import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  runOpencodeExport,
  renderSessionMarkdown,
  parseMessageRole,
  parsePartText,
  datePrefix,
  exportFilename,
  type OpencodeSessionRow,
} from '../src/core/opencode-export.ts';

// ── Pure render helpers ──────────────────────────────────────────────────

describe('parseMessageRole', () => {
  test('extracts role from JSON blob', () => {
    expect(parseMessageRole('{"role":"user","time":{"created":1}}')).toBe('user');
    expect(parseMessageRole('{"role":"assistant"}')).toBe('assistant');
  });
  test('null on missing role or bad JSON', () => {
    expect(parseMessageRole('{"time":{}}')).toBeNull();
    expect(parseMessageRole('not json')).toBeNull();
    expect(parseMessageRole('{"role":123}')).toBeNull();
  });
});

describe('parsePartText', () => {
  test('returns text only for type:text parts', () => {
    expect(parsePartText('{"type":"text","text":"hello"}')).toBe('hello');
  });
  test('null for non-text part types (tool, reasoning, step)', () => {
    expect(parsePartText('{"type":"tool","tool":"bash"}')).toBeNull();
    expect(parsePartText('{"type":"reasoning","text":"thinking"}')).toBeNull();
    expect(parsePartText('{"type":"step-start"}')).toBeNull();
    expect(parsePartText('bad json')).toBeNull();
  });
});

describe('datePrefix', () => {
  test('ms epoch → YYYY-MM-DD UTC', () => {
    expect(datePrefix(Date.parse('2026-05-29T06:05:29.279Z'))).toBe('2026-05-29');
  });
  test('invalid → 1970-01-01', () => {
    expect(datePrefix(NaN)).toBe('1970-01-01');
  });
});

describe('exportFilename', () => {
  test('YYYY-MM-DD-<id>.md (discoverTranscripts DATE_RE prefix)', () => {
    const s = { id: 'ses_abc', time_created: Date.parse('2026-05-29T00:00:00Z') } as OpencodeSessionRow;
    expect(exportFilename(s)).toBe('2026-05-29-ses_abc.md');
    // The synthesize discover gate keys on /^\d{4}-\d{2}-\d{2}/ — assert it matches.
    expect(/^\d{4}-\d{2}-\d{2}/.test(exportFilename(s))).toBe(true);
  });
});

describe('renderSessionMarkdown', () => {
  const session = {
    id: 'ses_1', slug: 'witty-star', title: 'Event audit migration',
    directory: '/home/x/proj', time_created: Date.parse('2026-05-29T06:00:00Z'), time_updated: 0,
  } as OpencodeSessionRow;

  test('emits ## User: / ## Assistant: blocks with a header', () => {
    const md = renderSessionMarkdown(session, [
      { role: 'user', text: 'do the thing' },
      { role: 'assistant', text: 'done' },
    ]);
    expect(md).toContain('# Event audit migration');
    expect(md).toContain('Source: opencode session ses_1');
    expect(md).toContain('## User:');
    expect(md).toContain('do the thing');
    expect(md).toContain('## Assistant:');
    expect(md).toContain('done');
  });

  test('does NOT stamp dream_generated (input transcript, must stay discoverable)', () => {
    const md = renderSessionMarkdown(session, [{ role: 'user', text: 'x' }]);
    expect(md).not.toContain('dream_generated');
  });

  test('unknown role falls back to a titled heading', () => {
    const md = renderSessionMarkdown(session, [{ role: 'tool', text: 'output' }]);
    expect(md).toContain('## tool:');
  });
});

// ── Orchestration (in-memory opencode-shaped DB) ─────────────────────────

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE session (id TEXT PRIMARY KEY, slug TEXT, title TEXT, directory TEXT, time_created INTEGER, time_updated INTEGER)`);
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
  db.run(`CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`);
  return db;
}

let partSeq = 0;
function seedSession(
  db: Database,
  id: string,
  turns: Array<{ role: string; texts: string[]; nonText?: Array<Record<string, unknown>> }>,
  opts: { time_created?: number; time_updated?: number; title?: string } = {},
): void {
  const tc = opts.time_created ?? Date.parse('2026-05-29T06:00:00Z');
  const tu = opts.time_updated ?? tc;
  db.run(
    `INSERT INTO session (id, slug, title, directory, time_created, time_updated) VALUES (?,?,?,?,?,?)`,
    [id, id, opts.title ?? id, '/proj', tc, tu],
  );
  let t = tc;
  turns.forEach((turn, i) => {
    const msgId = `${id}-m${i}`;
    db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES (?,?,?,?)`,
      [msgId, id, t++, JSON.stringify({ role: turn.role })]);
    for (const text of turn.texts) {
      db.run(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
        [`p${partSeq++}`, msgId, id, t++, JSON.stringify({ type: 'text', text })]);
    }
    for (const np of turn.nonText ?? []) {
      db.run(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?,?,?,?,?)`,
        [`p${partSeq++}`, msgId, id, t++, JSON.stringify(np)]);
    }
  });
}

describe('runOpencodeExport — in-memory DB orchestration', () => {
  let dir: string;
  let corpusDir: string;
  let statePath: string;
  let db: Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gbrain-oce-'));
    corpusDir = join(dir, 'corpus');
    statePath = join(dir, 'state.json');
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('basic export writes one .md per non-empty session under opencode/', async () => {
    seedSession(db, 'ses_a', [
      { role: 'user', texts: ['build the thing'] },
      { role: 'assistant', texts: ['building...', 'done'] },
    ]);
    const r = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r.written).toBe(1);
    expect(r.scanned).toBe(1);
    const outDir = join(corpusDir, 'opencode');
    const files = readdirSync(outDir);
    expect(files.length).toBe(1);
    expect(/^\d{4}-\d{2}-\d{2}-ses_a\.md$/.test(files[0])).toBe(true);
    const content = readFileSync(join(outDir, files[0]), 'utf8');
    expect(content).toContain('## User:');
    expect(content).toContain('build the thing');
    expect(content).toContain('## Assistant:');
    expect(content).toContain('building...\ndone'); // multiple text parts joined
    expect(content).not.toContain('dream_generated');
  });

  test('incremental: second run with unchanged sessions skips them (no rewrite)', async () => {
    seedSession(db, 'ses_a', [{ role: 'user', texts: ['hi'] }]);
    const r1 = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r1.written).toBe(1);
    const r2 = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r2.written).toBe(0);
    expect(r2.skipped_unchanged).toBe(1);
  });

  test('changed session (time_updated bumped) re-exports', async () => {
    seedSession(db, 'ses_a', [{ role: 'user', texts: ['hi'] }], { time_updated: 1000 });
    await runOpencodeExport({ db, corpusDir, statePath });
    // Simulate a new turn landing: bump time_updated.
    db.run(`UPDATE session SET time_updated = 2000 WHERE id = 'ses_a'`);
    const r = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r.written).toBe(1);
    expect(r.skipped_unchanged).toBe(0);
  });

  test('empty session (no text parts, only tool/reasoning) is skipped, no file written', async () => {
    seedSession(db, 'ses_tooly', [
      { role: 'assistant', texts: [], nonText: [{ type: 'tool', tool: 'bash' }, { type: 'reasoning', text: 'hmm' }] },
    ]);
    const r = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r.written).toBe(0);
    expect(r.skipped_empty).toBe(1);
    expect(existsSync(join(corpusDir, 'opencode'))).toBe(false);
  });

  test('tool/reasoning parts are excluded; only text prose is rendered', async () => {
    seedSession(db, 'ses_mix', [
      { role: 'user', texts: ['real prompt'], nonText: [{ type: 'tool', tool: 'read' }] },
      { role: 'assistant', texts: ['real answer'], nonText: [{ type: 'reasoning', text: 'secret thinking' }] },
    ]);
    await runOpencodeExport({ db, corpusDir, statePath });
    const outDir = join(corpusDir, 'opencode');
    const content = readFileSync(join(outDir, readdirSync(outDir)[0]), 'utf8');
    expect(content).toContain('real prompt');
    expect(content).toContain('real answer');
    expect(content).not.toContain('secret thinking');
    expect(content).not.toContain('read');
  });

  test('--limit caps sessions processed (newest by time_updated first)', async () => {
    seedSession(db, 'old', [{ role: 'user', texts: ['a'] }], { time_updated: 1000 });
    seedSession(db, 'mid', [{ role: 'user', texts: ['b'] }], { time_updated: 2000 });
    seedSession(db, 'new', [{ role: 'user', texts: ['c'] }], { time_updated: 3000 });
    const r = await runOpencodeExport({ db, corpusDir, statePath, limit: 2 });
    expect(r.scanned).toBe(2);
    expect(r.written).toBe(2);
    const files = readdirSync(join(corpusDir, 'opencode'));
    // newest two: new + mid
    expect(files.some(f => f.includes('new'))).toBe(true);
    expect(files.some(f => f.includes('mid'))).toBe(true);
    expect(files.some(f => f.includes('old'))).toBe(false);
  });

  test('sinceMs filters out older sessions', async () => {
    seedSession(db, 'old', [{ role: 'user', texts: ['a'] }], { time_updated: 1000 });
    seedSession(db, 'recent', [{ role: 'user', texts: ['b'] }], { time_updated: 5000 });
    const r = await runOpencodeExport({ db, corpusDir, statePath, sinceMs: 3000 });
    expect(r.scanned).toBe(1);
    expect(r.written).toBe(1);
    expect(readdirSync(join(corpusDir, 'opencode'))[0]).toContain('recent');
  });

  test('dry-run writes nothing and does not persist state', async () => {
    seedSession(db, 'ses_a', [{ role: 'user', texts: ['hi'] }]);
    const r = await runOpencodeExport({ db, corpusDir, statePath, dryRun: true });
    expect(r.written).toBe(1); // would-write count
    expect(existsSync(join(corpusDir, 'opencode'))).toBe(false);
    expect(existsSync(statePath)).toBe(false);
    // A real run afterwards still writes (state wasn't poisoned by dry-run).
    const r2 = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r2.written).toBe(1);
    expect(r2.skipped_unchanged).toBe(0);
  });

  test('empty DB (no sessions) → zero work, no crash', async () => {
    const r = await runOpencodeExport({ db, corpusDir, statePath });
    expect(r).toEqual({ scanned: 0, written: 0, skipped_empty: 0, skipped_unchanged: 0, files: [] });
  });
});
