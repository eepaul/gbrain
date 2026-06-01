/**
 * v0.41.30.0 — `gbrain takes propose` consumer (the propose_takes queue
 * review surface). PGLite in-memory, no DATABASE_URL required.
 *
 * Covers the NEW behavior that engine/fence tests don't:
 *   - list filters status='pending' (excludes 'empty' sentinels + acted rows)
 *   - --accept promotes a proposal into the page's takes fence (markdown +
 *     DB via addTakesBatch) AND marks the proposal accepted + records
 *     promoted_row_num
 *   - --reject marks the proposal rejected, leaves it as audit history
 *   - accept/reject refuse non-pending rows (sentinels can't be accepted)
 *
 * The accept path writes a `<slug>.md` under a temp brain dir and acquires a
 * per-page lock under $GBRAIN_HOME/page-locks; we point GBRAIN_HOME at a
 * tempdir for the file (test/e2e is exempt from the env-mutation lint).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runTakes } from '../../src/commands/takes.ts';

let engine: PGLiteEngine;
let brainDir: string;
let prevHome: string | undefined;

const PV = 'v0.36.1.0-tuned-cat15';

/** Capture console.log lines produced while `fn` runs. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines.join('\n');
}

/** Insert a proposal row, return its id. */
async function seedProposal(opts: {
  slug: string; status?: string; claim?: string; kind?: string;
  holder?: string; weight?: number; ch?: string;
}): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO take_proposals
       (source_id, page_slug, content_hash, prompt_version, proposal_run_id,
        status, claim_text, kind, holder, weight, model_id)
     VALUES ('default', $1, $2, $3, 'run-test', $4, $5, $6, $7, $8, 'claude-sonnet-4-6')
     RETURNING id`,
    [
      opts.slug,
      opts.ch ?? `hash-${opts.slug}-${opts.status ?? 'pending'}`,
      PV,
      opts.status ?? 'pending',
      opts.claim ?? 'a gradeable claim',
      opts.kind ?? 'bet',
      opts.holder ?? 'brain',
      opts.weight ?? 0.6,
    ],
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-propose-home-'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
});

beforeEach(async () => {
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-propose-brain-'));
  await engine.executeRaw(`DELETE FROM take_proposals`);
  await engine.executeRaw(`DELETE FROM takes`);
  await engine.executeRaw(`DELETE FROM pages`);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('default','default') ON CONFLICT (id) DO NOTHING`,
  );
});

describe('takes propose — list', () => {
  test('lists pending, excludes empty sentinels and acted rows', async () => {
    const pendingId = await seedProposal({ slug: 'people/alice-example', claim: 'alice wins the round', status: 'pending' });
    await seedProposal({ slug: 'wiki/no-claims', claim: '(no gradeable claims)', status: 'empty' });
    await seedProposal({ slug: 'wiki/done', claim: 'already accepted claim', status: 'accepted' });
    await seedProposal({ slug: 'wiki/nope', claim: 'already rejected claim', status: 'rejected' });

    const out = await captureLog(() => runTakes(engine, ['propose']));

    expect(out).toContain(`#${pendingId}`);
    expect(out).toContain('alice wins the round');
    // sentinel + acted rows must NOT surface
    expect(out).not.toContain('(no gradeable claims)');
    expect(out).not.toContain('already accepted claim');
    expect(out).not.toContain('already rejected claim');
  });

  test('--page filters to one page', async () => {
    await seedProposal({ slug: 'people/alice-example', claim: 'alice claim', ch: 'h-alice' });
    await seedProposal({ slug: 'companies/acme-example', claim: 'acme claim', ch: 'h-acme' });

    const out = await captureLog(() => runTakes(engine, ['propose', '--page', 'people/alice-example']));
    expect(out).toContain('alice claim');
    expect(out).not.toContain('acme claim');
  });

  test('--json emits machine-readable pending rows only', async () => {
    await seedProposal({ slug: 'people/alice-example', claim: 'json claim', status: 'pending' });
    await seedProposal({ slug: 'wiki/no-claims', status: 'empty' });
    const out = await captureLog(() => runTakes(engine, ['propose', '--json']));
    const parsed = JSON.parse(out) as Array<{ status: string; claim_text: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.status).toBe('pending');
    expect(parsed[0]!.claim_text).toBe('json claim');
  });

  test('empty queue prints a friendly note', async () => {
    const out = await captureLog(() => runTakes(engine, ['propose']));
    expect(out.toLowerCase()).toContain('no pending proposals');
  });
});

describe('takes propose — accept', () => {
  test('promotes proposal into fence (markdown + DB) and marks accepted', async () => {
    const slug = 'people/alice-example';
    await engine.putPage(slug, { title: 'Alice', type: 'person' as const, compiled_truth: '# Alice\n\nStrong founder.\n' });
    const id = await seedProposal({ slug, claim: 'alice 10x exit by 2030', kind: 'bet', holder: 'brain', weight: 0.7 });

    await runTakes(engine, ['propose', '--accept', String(id), '--dir', brainDir]);

    // DB take landed
    const takes = await engine.listTakes({ page_slug: slug });
    expect(takes).toHaveLength(1);
    expect(takes[0]!.claim).toBe('alice 10x exit by 2030');
    expect(takes[0]!.kind).toBe('bet');
    expect(Number(takes[0]!.weight)).toBeCloseTo(0.7, 5);
    expect(takes[0]!.source).toContain('proposal:run-test');

    // markdown fence written
    const mdPath = join(brainDir, `${slug}.md`);
    expect(existsSync(mdPath)).toBe(true);
    const md = readFileSync(mdPath, 'utf-8');
    expect(md).toContain('gbrain:takes:begin');
    expect(md).toContain('alice 10x exit by 2030');

    // proposal marked accepted + promoted_row_num recorded
    const rows = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
      `SELECT status, promoted_row_num FROM take_proposals WHERE id = $1`, [id],
    );
    expect(rows[0]!.status).toBe('accepted');
    expect(rows[0]!.promoted_row_num).toBe(takes[0]!.row_num);
  });

  test('--weight overrides the proposal weight on accept', async () => {
    const slug = 'companies/acme-example';
    await engine.putPage(slug, { title: 'Acme', type: 'company' as const, compiled_truth: '# Acme\n' });
    const id = await seedProposal({ slug, claim: 'acme hits 1M ARR', weight: 0.5 });

    await runTakes(engine, ['propose', '--accept', String(id), '--weight', '0.85', '--dir', brainDir]);
    const takes = await engine.listTakes({ page_slug: slug });
    expect(Number(takes[0]!.weight)).toBeCloseTo(0.85, 5);
  });
});

describe('takes propose — reject', () => {
  test('marks a pending proposal rejected (kept as audit history)', async () => {
    const id = await seedProposal({ slug: 'people/alice-example', claim: 'weak claim' });
    await runTakes(engine, ['propose', '--reject', String(id)]);

    const rows = await engine.executeRaw<{ status: string; acted_by: string | null }>(
      `SELECT status, acted_by FROM take_proposals WHERE id = $1`, [id],
    );
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.acted_by).toBe('garry');

    // rejected rows never appear in the pending list
    const out = await captureLog(() => runTakes(engine, ['propose']));
    expect(out.toLowerCase()).toContain('no pending proposals');
  });

  test('--by records the actor', async () => {
    const id = await seedProposal({ slug: 'people/alice-example', claim: 'c' });
    await runTakes(engine, ['propose', '--reject', String(id), '--by', 'reviewer-1']);
    const rows = await engine.executeRaw<{ acted_by: string | null }>(
      `SELECT acted_by FROM take_proposals WHERE id = $1`, [id],
    );
    expect(rows[0]!.acted_by).toBe('reviewer-1');
  });
});
