/**
 * `gbrain opencode-export` — render opencode chat sessions into the dream
 * synthesize corpus as `## User:` / `## Assistant:` markdown transcripts.
 *
 * opencode has no gbrain importer; synthesize consumes plain transcripts from a
 * corpus dir. This command bridges the two by reading opencode's local SQLite
 * DB (read-only) and writing one `.md` per session under `<corpus>/opencode/`.
 * Output is incremental (state file keyed on session.time_updated) and
 * discoverTranscripts picks it up with no synthesize-core change.
 *
 * First run on a large history exports every session; synthesize then runs its
 * Haiku significance verdict over all of them (real LLM cost). Bound the first
 * run with `--since 7d` / `--limit N`; later runs are incremental.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { loadConfig } from '../core/config.ts';
import { runOpencodeExport, OPENCODE_DEFAULT_DB } from '../core/opencode-export.ts';

const HELP = `gbrain opencode-export — export opencode chat sessions to the synthesize corpus

Usage:
  gbrain opencode-export [--corpus-dir PATH] [--db PATH] [--since DUR|DATE] [--limit N] [--dry-run] [--json]

Options:
  --corpus-dir PATH   Destination corpus dir. Defaults to the
                      dream.synthesize.session_corpus_dir config key.
  --db PATH           opencode.db path. Default: ${OPENCODE_DEFAULT_DB}
  --since DUR|DATE    Only sessions updated since DUR (7d/24h/30m/2w) or a
                      YYYY-MM-DD date. Bounds first-run cost.
  --limit N           Cap sessions processed this run (newest first).
  --dry-run           Report would-write counts; touch nothing.
  --json              Machine-readable output.

Writes <corpus>/opencode/YYYY-MM-DD-<session-id>.md. Incremental via
~/.gbrain/opencode-export-state.json. Re-run any time; unchanged sessions skip.`;

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}

/**
 * Resolve a `--since` value to an absolute epoch-ms cutoff.
 * Accepts duration shorthand (Nd/Nh/Nm/Nw → now minus that span) or an ISO
 * YYYY-MM-DD date (→ that day's UTC midnight). Returns null on bad input.
 */
export function resolveSinceMs(raw: string, now: number = Date.now()): number | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) {
    const t = Date.parse(`${raw}T00:00:00.000Z`);
    return Number.isFinite(t) ? t : null;
  }
  const dur = /^(\d+)\s*([smhdw])$/.exec(raw.trim());
  if (!dur) return null;
  const n = parseInt(dur[1], 10);
  const unit = dur[2];
  const mult: Record<string, number> = {
    s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000,
  };
  return now - n * mult[unit];
}

/** Resolve the corpus dir: explicit flag wins, else DB-plane config key. */
async function resolveCorpusDir(flagVal?: string): Promise<string | null> {
  if (flagVal) return flagVal;
  const { createEngine } = await import('../core/engine-factory.ts');
  const cfg = loadConfig() ?? {};
  const engineKind = (cfg as { engine?: string }).engine === 'postgres' ? 'postgres' : 'pglite';
  const connectConfig: import('../core/types.ts').EngineConfig = {
    engine: engineKind,
    database_url: (cfg as { database_url?: string }).database_url,
  };
  const engine = await createEngine(connectConfig);
  await engine.connect(connectConfig);
  try {
    return (await engine.getConfig('dream.synthesize.session_corpus_dir')) ?? null;
  } finally {
    await engine.disconnect();
  }
}

export async function runOpencodeExportCli(args: string[]): Promise<void> {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(HELP);
    return;
  }

  const json = hasFlag(args, '--json');
  const dryRun = hasFlag(args, '--dry-run');
  const dbPath = parseFlag(args, '--db') ?? OPENCODE_DEFAULT_DB;
  const corpusFlag = parseFlag(args, '--corpus-dir');
  const sinceRaw = parseFlag(args, '--since');
  const limitRaw = parseFlag(args, '--limit');

  let sinceMs: number | undefined;
  if (sinceRaw !== undefined) {
    const resolved = resolveSinceMs(sinceRaw);
    if (resolved === null) {
      console.error(`Invalid --since: ${sinceRaw} (use 7d/24h/30m/2w or YYYY-MM-DD)`);
      process.exit(2);
    }
    sinceMs = resolved;
  }

  let limit: number | undefined;
  if (limitRaw !== undefined) {
    const n = parseInt(limitRaw, 10);
    if (!Number.isFinite(n) || n < 1 || String(n) !== limitRaw.trim()) {
      console.error(`Invalid --limit: ${limitRaw} (expected a positive integer)`);
      process.exit(2);
    }
    limit = n;
  }

  // Multi-machine: no opencode here. Clear, non-error exit.
  if (!existsSync(dbPath)) {
    if (json) {
      console.log(JSON.stringify({ ok: true, skipped: 'opencode_db_absent', db_path: dbPath }, null, 2));
    } else {
      console.log(`opencode.db not found at ${dbPath} — nothing to export (this machine has no opencode).`);
    }
    return;
  }

  const corpusDir = await resolveCorpusDir(corpusFlag);
  if (!corpusDir) {
    console.error('No corpus dir resolved. Pass --corpus-dir <path>, or set the config key:');
    console.error('  gbrain config set dream.synthesize.session_corpus_dir /path/to/corpus');
    process.exit(2);
  }

  const result = await runOpencodeExport({ dbPath, corpusDir, sinceMs, limit, dryRun });

  if (json) {
    console.log(JSON.stringify({ ok: true, dry_run: dryRun, corpus_dir: corpusDir, ...result }, null, 2));
  } else {
    console.log(
      `opencode-export${dryRun ? ' (dry-run)' : ''}: ${result.written} written, ` +
      `${result.skipped_unchanged} unchanged, ${result.skipped_empty} empty (${result.scanned} scanned)`,
    );
    console.log(`  → ${join(corpusDir, 'opencode')}`);
  }
}
