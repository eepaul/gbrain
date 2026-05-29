import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { localPathPresent } from '../src/core/source-local-path.ts';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Filesystem-backed unit test (real existsSync/statSync). Uses a temp dir +
// real file; no env mutation, no PGLite, no mock.module — safe in the parallel
// fast loop.

let dir: string;
let filePath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-localpath-'));
  filePath = join(dir, 'a-file.txt');
  writeFileSync(filePath, 'x');
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('localPathPresent', () => {
  test('existing directory → true', () => {
    expect(localPathPresent(dir)).toBe(true);
  });

  test('non-existent path → false', () => {
    expect(localPathPresent(join(dir, 'does-not-exist'))).toBe(false);
  });

  test('existing path that is a FILE (not a directory) → false', () => {
    expect(localPathPresent(filePath)).toBe(false);
  });

  test('null / undefined / empty string → false (no path to check)', () => {
    expect(localPathPresent(null)).toBe(false);
    expect(localPathPresent(undefined)).toBe(false);
    expect(localPathPresent('')).toBe(false);
  });
});
