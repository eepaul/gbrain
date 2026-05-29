/**
 * opencode → dream-synthesize corpus exporter.
 *
 * opencode stores every chat session in a local SQLite DB
 * (`~/.local/share/opencode/opencode.db`): `session` (metadata),
 * `message` (one row per turn, role inside a JSON `data` blob), and `part`
 * (one row per content chunk, text inside a JSON `data` blob). gbrain's
 * synthesize phase consumes plain-text/markdown transcripts from a corpus
 * directory — it has no opencode importer. This module bridges the gap:
 * render each session to a `## User:` / `## Assistant:` markdown transcript
 * that `discoverTranscripts` (src/core/cycle/transcript-discovery.ts) picks up
 * automatically. The synthesize core is unchanged.
 *
 * Output filenames carry a `YYYY-MM-DD-` prefix (matching discoverTranscripts'
 * DATE_RE) and deliberately DO NOT stamp `dream_generated: true` — these are
 * INPUT transcripts, not dream output, so the self-consumption guard must not
 * skip them.
 *
 * Incremental via a state file keyed on each session's `time_updated`: a
 * session re-exports only when new turns have landed since the last run. First
 * run with no state exports everything; bound it with `sinceMs` / `limit`.
 *
 * The DB read is injectable (`opts.db`) so tests drive a `:memory:` opencode-
 * shaped database without touching the real one. Pure render helpers are
 * exported separately for unit coverage.
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { gbrainPath } from './config.ts';

export const OPENCODE_DEFAULT_DB = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
const STATE_SCHEMA_VERSION = 1;

export interface OpencodeSessionRow {
  id: string;
  slug: string | null;
  title: string | null;
  directory: string | null;
  time_created: number; // epoch ms
  time_updated: number; // epoch ms
}

export interface Turn {
  role: string;
  text: string;
}

export interface OpencodeExportOpts {
  /** opencode.db path. Default ~/.local/share/opencode/opencode.db. */
  dbPath?: string;
  /** Destination corpus dir (caller resolves from config/flag). Required. */
  corpusDir: string;
  /** State file path. Default gbrainPath('opencode-export-state.json'). */
  statePath?: string;
  /** Only sessions with time_updated >= sinceMs. */
  sinceMs?: number;
  /** Cap on sessions processed this run (newest first). */
  limit?: number;
  /** Report would-write counts without touching disk. */
  dryRun?: boolean;
  /** Injected DB for tests; production opens dbPath readonly. */
  db?: Database;
}

export interface OpencodeExportResult {
  scanned: number;
  written: number;
  skipped_empty: number;
  skipped_unchanged: number;
  files: string[];
}

interface ExportState {
  schema_version: number;
  /** sessionId → last exported session.time_updated. */
  exported: Record<string, number>;
}

// ── Pure render helpers ──────────────────────────────────────────────────

/** Parse a `message.data` JSON blob → role string, or null when unparseable. */
export function parseMessageRole(data: string): string | null {
  try {
    const d = JSON.parse(data) as { role?: unknown };
    return typeof d?.role === 'string' ? d.role : null;
  } catch {
    return null;
  }
}

/**
 * Extract prose from a `part.data` JSON blob. Only `type: 'text'` parts carry
 * user/assistant prose; tool calls, tool results, reasoning, and step markers
 * are deliberately excluded (noise for synthesis). Returns null otherwise.
 */
export function parsePartText(data: string): string | null {
  try {
    const d = JSON.parse(data) as { type?: unknown; text?: unknown };
    if (d?.type === 'text' && typeof d.text === 'string') return d.text;
    return null;
  } catch {
    return null;
  }
}

/** epoch ms → YYYY-MM-DD (UTC). Falls back to 1970-01-01 on invalid input. */
export function datePrefix(timeMs: number): string {
  const d = new Date(timeMs);
  if (!Number.isFinite(d.getTime())) return '1970-01-01';
  return d.toISOString().slice(0, 10);
}

/** Deterministic export filename for a session. */
export function exportFilename(session: OpencodeSessionRow): string {
  return `${datePrefix(session.time_created)}-${session.id}.md`;
}

/**
 * Render a session's turns to a synthesize-corpus markdown transcript.
 * NO `dream_generated` marker (input transcript, not dream output). A small
 * header gives synthesize topical + temporal anchoring (the recall-miss class
 * the conversation-facts work also targets).
 */
export function renderSessionMarkdown(session: OpencodeSessionRow, turns: Turn[]): string {
  const when = Number.isFinite(new Date(session.time_created).getTime())
    ? new Date(session.time_created).toISOString()
    : 'unknown';
  const lines: string[] = [];
  lines.push(`# ${session.title || session.slug || session.id}`);
  lines.push('');
  lines.push(`Source: opencode session ${session.id}`);
  if (session.directory) lines.push(`Directory: ${session.directory}`);
  lines.push(`Started: ${when}`);
  lines.push('');
  for (const t of turns) {
    const heading =
      t.role === 'assistant' ? '## Assistant:'
      : t.role === 'user' ? '## User:'
      : `## ${t.role || 'Message'}:`;
    lines.push(heading);
    lines.push('');
    lines.push(t.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}

// ── State ────────────────────────────────────────────────────────────────

function loadState(statePath: string): ExportState {
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Partial<ExportState>;
    if (raw && typeof raw === 'object' && raw.exported && typeof raw.exported === 'object') {
      return { schema_version: STATE_SCHEMA_VERSION, exported: raw.exported as Record<string, number> };
    }
  } catch {
    // missing / malformed → fresh state (re-export is cheap; synthesize dedups
    // via dream_verdicts content_hash so a re-write doesn't re-spend LLM).
  }
  return { schema_version: STATE_SCHEMA_VERSION, exported: {} };
}

function saveState(statePath: string, state: ExportState): void {
  const tmp = `${statePath}.tmp`;
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(tmp, JSON.stringify(state), 'utf8');
  // Atomic swap so a crash mid-write never leaves a partial state file.
  renameSync(tmp, statePath);
}

// ── Orchestration ──────────────────────────────────────────────────────────

/**
 * Build the ordered turn list for one session: walk messages by time_created,
 * concatenate each message's text parts (by part.time_created), drop turns with
 * no text. Two queries per session (messages, parts) — no per-part N+1.
 */
function buildTurns(db: Database, sessionId: string): Turn[] {
  const messages = db
    .query('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
    .all(sessionId) as Array<{ id: string; data: string }>;
  if (messages.length === 0) return [];

  // One query for ALL parts of the session, grouped client-side by message_id.
  const parts = db
    .query('SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
    .all(sessionId) as Array<{ message_id: string; data: string }>;
  const textByMsg = new Map<string, string[]>();
  for (const p of parts) {
    const text = parsePartText(p.data);
    if (text === null) continue;
    const arr = textByMsg.get(p.message_id) ?? [];
    arr.push(text);
    textByMsg.set(p.message_id, arr);
  }

  const turns: Turn[] = [];
  for (const m of messages) {
    const role = parseMessageRole(m.data) ?? 'message';
    const text = (textByMsg.get(m.id) ?? []).join('\n').trim();
    if (!text) continue;
    turns.push({ role, text });
  }
  return turns;
}

export async function runOpencodeExport(opts: OpencodeExportOpts): Promise<OpencodeExportResult> {
  const dbPath = opts.dbPath ?? OPENCODE_DEFAULT_DB;
  const statePath = opts.statePath ?? gbrainPath('opencode-export-state.json');
  const outDir = join(opts.corpusDir, 'opencode');

  const result: OpencodeExportResult = {
    scanned: 0, written: 0, skipped_empty: 0, skipped_unchanged: 0, files: [],
  };

  // db injection (tests) or open readonly (production). Caller is expected to
  // gate on existsSync(dbPath) for the multi-machine "no opencode here" case;
  // guard anyway so a direct call doesn't throw on a missing file.
  const ownsDb = !opts.db;
  if (ownsDb && !existsSync(dbPath)) return result;
  const db = opts.db ?? new Database(dbPath, { readonly: true });

  try {
    const state = loadState(statePath);

    const where: string[] = [];
    const params: number[] = [];
    if (typeof opts.sinceMs === 'number') {
      where.push('time_updated >= ?');
      params.push(opts.sinceMs);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = typeof opts.limit === 'number' && opts.limit > 0 ? `LIMIT ${Math.floor(opts.limit)}` : '';
    const sessions = db
      .query(
        `SELECT id, slug, title, directory, time_created, time_updated
         FROM session ${whereSql}
         ORDER BY time_updated DESC, id ASC ${limitSql}`,
      )
      .all(...params) as OpencodeSessionRow[];

    for (const session of sessions) {
      result.scanned++;
      // Incremental: skip when nothing changed since last export.
      if (state.exported[session.id] === session.time_updated) {
        result.skipped_unchanged++;
        continue;
      }
      const turns = buildTurns(db, session.id);
      if (turns.length === 0) {
        result.skipped_empty++;
        // Record so an empty session isn't re-scanned every run.
        state.exported[session.id] = session.time_updated;
        continue;
      }
      const md = renderSessionMarkdown(session, turns);
      const filePath = join(outDir, exportFilename(session));
      if (!opts.dryRun) {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, md, 'utf8');
        state.exported[session.id] = session.time_updated;
      }
      result.written++;
      result.files.push(filePath);
    }

    if (!opts.dryRun) saveState(statePath, state);
  } finally {
    if (ownsDb) db.close();
  }

  return result;
}
