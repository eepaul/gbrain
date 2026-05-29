/**
 * E2E regression for the v0.41.x connection-isolation fix (the autopilot
 * "connect() has not been called" avalanche bug class).
 *
 * Root cause: in MODULE mode every PostgresEngine method falls back to the
 * process-global `db.ts` singleton. Any in-process module-mode disconnect
 * (worker shutdown) or failed reconnect (degraded DB) clears that shared
 * singleton mid-life, so in-flight cycle / extract / facts writes throw
 * "connect() has not been called" while the process keeps running. That is how
 * the worker's link/facts writes silently failed (brain_score links stuck low).
 *
 * Fix: long-running daemons (serve, autopilot, jobs work) connect in INSTANCE
 * mode — their own `_sql` pool, immune to singleton teardown. Policy lives in
 * `src/core/daemon-connection-mode.ts` (unit-tested); this E2E pins the
 * load-bearing engine-level invariant the policy depends on, so a future
 * refactor of disconnect()/get sql() can't silently regress it.
 *
 * One file per process (scripts/run-e2e.sh), so module-singleton manipulation
 * here cannot strand sibling E2E files.
 */

import { describe, test, expect, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import * as db from '../../src/core/db.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const skip = !DATABASE_URL;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping connection-isolation E2E (DATABASE_URL not set)');
}

describe.skipIf(skip)('connection isolation: instance-mode engines survive module-singleton teardown', () => {
  afterAll(async () => {
    // Leave the process with the singleton closed (pool reaped at process exit).
    try { await db.disconnect(); } catch { /* best-effort */ }
  });

  test('after the shared singleton is torn down: instance engine works, module engine throws', async () => {
    // Seed the module singleton — what short-lived CLI commands and pre-fix
    // module-mode engines share.
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });

    // A daemon-style INSTANCE-mode engine (poolSize set → owns its own _sql).
    const daemon = new PostgresEngine();
    await daemon.connect({ database_url: DATABASE_URL!, poolSize: 2 });

    // A MODULE-mode engine (no poolSize → routes every method through the
    // shared singleton). This is the pre-fix worker engine.
    const moduleEngine = new PostgresEngine();
    await moduleEngine.connect({ database_url: DATABASE_URL! });

    // Both read fine while the singleton is alive.
    expect((await daemon.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);
    expect((await moduleEngine.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);

    // The avalanche trigger: an in-process disconnect clears the shared
    // singleton mid-life. (Any module-mode engine.disconnect(), worker shutdown,
    // or failed reconnect routes through db.disconnect() → singleton = null.)
    await db.disconnect();

    // THE FIX (load-bearing): the daemon's instance engine still works — its
    // own _sql pool was never touched by the singleton teardown.
    expect((await daemon.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);

    // PRE-FIX BUG SURFACE: the module-mode engine now throws on every method —
    // exactly the failure that silently dropped autopilot cycle writes.
    await expect(moduleEngine.executeRaw('SELECT 1 AS ok')).rejects.toThrow(
      /connect\(\) has not been called|No database connection/,
    );

    await daemon.disconnect();
  }, 30_000);

  test('a module-mode engine.disconnect() clears the singleton for OTHER module consumers (the actual trigger)', async () => {
    // Re-seed.
    await db.disconnect();
    await db.connect({ database_url: DATABASE_URL! });

    // Two module-mode engines sharing the singleton (worker loop + a job
    // handler, conceptually).
    const a = new PostgresEngine();
    await a.connect({ database_url: DATABASE_URL! });
    const b = new PostgresEngine();
    await b.connect({ database_url: DATABASE_URL! });

    expect((await a.executeRaw<{ ok: number }>('SELECT 1 AS ok'))[0].ok).toBe(1);

    // b shuts down → module branch → db.disconnect() → clears the singleton
    // that `a` is still using. This is precisely jobs.ts:857 firing while an
    // in-flight handler on `a` still writes.
    await b.disconnect();

    await expect(a.executeRaw('SELECT 1 AS ok')).rejects.toThrow(
      /connect\(\) has not been called|No database connection/,
    );

    // (Under the fix, the worker's engine is instance-mode, so this cross-clear
    // can never reach its writes — proven by the first test.)
  }, 30_000);
});
