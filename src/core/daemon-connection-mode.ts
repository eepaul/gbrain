/**
 * Connection-mode policy for long-running daemons.
 *
 * Background (autopilot "connect() has not been called" avalanche bug class):
 * in MODULE mode every PostgresEngine method falls back to the process-global
 * `db.ts` singleton. Any in-process module-mode disconnect (worker shutdown)
 * or failed reconnect (degraded DB) clears that shared singleton mid-life,
 * breaking in-flight cycle / extract / facts writes. Long-running daemons run
 * a job/request loop AND concurrent writes on a single engine, so they connect
 * in INSTANCE mode (their own `_sql` pool, immune to singleton teardown).
 *
 * Short-lived CLI commands deliberately stay module mode: single-threaded,
 * disconnect only at exit, and several (file ops, doctor, integrity,
 * repair-jsonb, auth) call `db.getConnection()` directly.
 *
 * PGLite has no shared module singleton (each engine owns its `_db`), so the
 * whole distinction is Postgres-only.
 */

export type EngineKind = 'postgres' | 'pglite';

/** Commands whose process is a long-running daemon with concurrent writes. */
const INSTANCE_DAEMON_COMMANDS = new Set(['serve', 'autopilot']);

/**
 * True when this process must NOT route engine methods through the shared
 * `db.ts` singleton. `parsedArgs` is the command argv AFTER global-flag
 * stripping (`parseGlobalFlags(...).rest`), so `--quiet jobs work` resolves to
 * `['jobs','work']`, not `['--quiet', ...]`.
 */
export function isInstanceModeDaemon(parsedArgs: string[], engineKind: EngineKind): boolean {
  if (engineKind !== 'postgres') return false;
  const cmd = parsedArgs[0];
  if (cmd && INSTANCE_DAEMON_COMMANDS.has(cmd)) return true;
  return cmd === 'jobs' && parsedArgs[1] === 'work';
}

/**
 * True only for `jobs work`: the worker runs builtin job handlers (integrity,
 * repair-jsonb) whose implementations reach `db.getConnection()` directly, so
 * the worker process must ALSO seed the module singleton even though its engine
 * is instance-mode. The engine's own methods still use `_sql`, so the seeded
 * singleton is never the cycle write path and idle-closes when no direct-caller
 * job is running — one small extra pool in one process. serve / autopilot never
 * invoke those handlers, so they get instance mode with no singleton.
 */
export function needsSingletonSeed(parsedArgs: string[], engineKind: EngineKind): boolean {
  if (engineKind !== 'postgres') return false;
  return parsedArgs[0] === 'jobs' && parsedArgs[1] === 'work';
}
