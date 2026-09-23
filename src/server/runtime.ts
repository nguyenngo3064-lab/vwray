import "server-only";

/**
 * Runtime boot hooks.
 *
 * Next.js has no `main()` for route handlers, so background loops (automation
 * scheduler, realtime flusher) start lazily from the first request that touches the
 * module and then persist for the process lifetime. Every starter is idempotent, so
 * concurrent first requests cannot double-start a loop.
 */

declare global {
  // eslint-disable-next-line no-var
  var __vwrayRuntimeBooted: boolean | undefined;
}

/** Starts the scheduler and the traffic flusher. Never throws. */
export async function ensureRuntimeBooted(): Promise<void> {
  if (globalThis.__vwrayRuntimeBooted) return;
  globalThis.__vwrayRuntimeBooted = true;

  try {
    const { startScheduler } = await import("@/server/automation/scheduler");
    await startScheduler();
  } catch {
    // A scheduler that cannot start must not take the console down with it; the
    // console logs the failure through the tick path instead.
  }
  try {
    const { startFlusher } = await import("@/server/traffic/buffer");
    startFlusher();
  } catch {
    // Same: flushing failures stay in the ingest path's own logs.
  }
}
