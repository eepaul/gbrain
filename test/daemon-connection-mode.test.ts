import { describe, expect, test } from 'bun:test';
import {
  isInstanceModeDaemon,
  needsSingletonSeed,
} from '../src/core/daemon-connection-mode.ts';

// Pure-function policy tests for the v0.41.x connection-isolation fix.
// `parsedArgs` is always the post-global-flag-strip argv (parseGlobalFlags.rest),
// so callers never pass leading `--quiet`/`--progress-json` here.

describe('isInstanceModeDaemon', () => {
  test('serve on postgres → instance mode', () => {
    expect(isInstanceModeDaemon(['serve'], 'postgres')).toBe(true);
    expect(isInstanceModeDaemon(['serve', '--http', '--port', '3131'], 'postgres')).toBe(true);
  });

  test('autopilot on postgres → instance mode', () => {
    expect(isInstanceModeDaemon(['autopilot'], 'postgres')).toBe(true);
    expect(isInstanceModeDaemon(['autopilot', '--install'], 'postgres')).toBe(true);
  });

  test('jobs work on postgres → instance mode', () => {
    expect(isInstanceModeDaemon(['jobs', 'work'], 'postgres')).toBe(true);
    expect(isInstanceModeDaemon(['jobs', 'work', '--concurrency', '4'], 'postgres')).toBe(true);
  });

  test('jobs non-work subcommands stay module mode', () => {
    for (const sub of ['stats', 'list', 'supervisor', 'submit', 'smoke', 'get', 'prune']) {
      expect(isInstanceModeDaemon(['jobs', sub], 'postgres')).toBe(false);
    }
  });

  test('bare jobs (no subcommand) stays module mode', () => {
    expect(isInstanceModeDaemon(['jobs'], 'postgres')).toBe(false);
  });

  test('short-lived CLI commands stay module mode (db.getConnection() direct callers)', () => {
    for (const cmd of ['doctor', 'sync', 'dream', 'integrity', 'repair-jsonb', 'auth', 'query', 'search', 'embed']) {
      expect(isInstanceModeDaemon([cmd], 'postgres')).toBe(false);
    }
  });

  test('empty args → module mode (never crashes on undefined)', () => {
    expect(isInstanceModeDaemon([], 'postgres')).toBe(false);
  });

  test('PGLite is never instance-daemon (no shared module singleton to protect)', () => {
    expect(isInstanceModeDaemon(['serve'], 'pglite')).toBe(false);
    expect(isInstanceModeDaemon(['autopilot'], 'pglite')).toBe(false);
    expect(isInstanceModeDaemon(['jobs', 'work'], 'pglite')).toBe(false);
  });
});

describe('needsSingletonSeed', () => {
  test('only jobs work on postgres seeds the singleton (runs integrity/repair-jsonb handlers)', () => {
    expect(needsSingletonSeed(['jobs', 'work'], 'postgres')).toBe(true);
    expect(needsSingletonSeed(['jobs', 'work', '--queue', 'default'], 'postgres')).toBe(true);
  });

  test('serve / autopilot do NOT seed the singleton (no direct-caller handlers)', () => {
    expect(needsSingletonSeed(['serve'], 'postgres')).toBe(false);
    expect(needsSingletonSeed(['autopilot'], 'postgres')).toBe(false);
  });

  test('jobs non-work subcommands do not seed', () => {
    expect(needsSingletonSeed(['jobs', 'stats'], 'postgres')).toBe(false);
    expect(needsSingletonSeed(['jobs'], 'postgres')).toBe(false);
  });

  test('short-lived CLI does not seed (module mode already has the singleton)', () => {
    expect(needsSingletonSeed(['doctor'], 'postgres')).toBe(false);
    expect(needsSingletonSeed([], 'postgres')).toBe(false);
  });

  test('PGLite never seeds (no Postgres module singleton)', () => {
    expect(needsSingletonSeed(['jobs', 'work'], 'pglite')).toBe(false);
  });
});

describe('invariant: every instance-daemon either seeds the singleton or has no direct-caller handlers', () => {
  // The worker (jobs work) is the only daemon that runs builtin handlers
  // reaching db.getConnection() directly, so it is the only one that must seed.
  // This pins that serve/autopilot are deliberately seed-free.
  test('jobs work is instance AND seeds; serve/autopilot are instance and NOT seeded', () => {
    expect(isInstanceModeDaemon(['jobs', 'work'], 'postgres')).toBe(true);
    expect(needsSingletonSeed(['jobs', 'work'], 'postgres')).toBe(true);

    expect(isInstanceModeDaemon(['serve'], 'postgres')).toBe(true);
    expect(needsSingletonSeed(['serve'], 'postgres')).toBe(false);

    expect(isInstanceModeDaemon(['autopilot'], 'postgres')).toBe(true);
    expect(needsSingletonSeed(['autopilot'], 'postgres')).toBe(false);
  });
});
