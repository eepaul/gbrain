import { existsSync, statSync } from 'fs';

/**
 * True when a source's `local_path` exists on THIS machine as a directory.
 *
 * Multi-machine (federated) brains register sources owned by several hosts. A
 * source's `local_path` is only meaningful on the host that actually holds the
 * repo checkout; on every other machine the path is absent. The autopilot
 * freshness loop and per-source fan-out skip sources whose `local_path` is not
 * present here, so this machine never enqueues a `sync` / `autopilot-cycle`
 * job for a repo it cannot reach (which would fail, or worse, trigger an
 * unwanted reclone on the sync handler's recloneIfMissing path).
 *
 * This is an autopilot-only gate. A manual `gbrain sync --source <id>` still
 * reclones a missing remote-backed source on demand — that path is untouched.
 *
 * Returns false for null / empty `local_path` (nothing to check) and for paths
 * that exist but are not directories. `statSync` is wrapped so a TOCTOU race
 * (path removed between existsSync and statSync) or a permission error degrades
 * to "absent" rather than throwing into the autopilot tick.
 *
 * Mirrors the `!existsSync(p) || !statSync(p).isDirectory()` check in
 * `src/core/operations.ts` (put_page write-through `repo_not_found` gate) so
 * the three sites share one definition of "is this local path usable here".
 */
export function localPathPresent(localPath: string | null | undefined): boolean {
  if (!localPath) return false;
  try {
    return existsSync(localPath) && statSync(localPath).isDirectory();
  } catch {
    return false;
  }
}
