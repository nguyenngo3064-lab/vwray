import "server-only";
import { logger } from "@/server/lib/logger";
import { getSetting } from "@/server/settings/service";
import { schedulerTick } from "@/server/automation/service";

/**
 * In-process scheduler loop.
 *
 * A single interval runs `schedulerTick()`, which leases due jobs from the database and
 * advances them. There is no external cron dependency: wherever the control plane runs,
 * the loop runs, and the PostgreSQL lease is what stops two replicas from doubling up.
 *
 * Wired at runtime by importing this module once (see `src/server/runtime.ts`); the loop
 * is idempotent, so double-importing it cannot double-schedule.
 */

declare global {
  // eslint-disable-next-line no-var
  var __vwrayScheduler: boolean | undefined;
}

let timer: ReturnType<typeof setInterval> | null = null;

async function tick(): Promise<void> {
  try {
    const enabled = await getSetting<boolean>("automation.enabled").catch(() => true);
    if (!enabled) return;
    const result = await schedulerTick();
    if (result.ran > 0) logger.info("automation tick ran jobs", result);
  } catch (error) {
    logger.error("automation tick failed", { error });
  }
}

/** Starts the loop. Calling it twice is a no-op. */
export async function startScheduler(): Promise<void> {
  if (globalThis.__vwrayScheduler || timer) return;
  globalThis.__vwrayScheduler = true;
  const tickSeconds = await getSetting<number>("automation.tickSeconds").catch(() => 60);
  const intervalMs = Math.max(15_000, tickSeconds * 1000);
  timer = setInterval(() => void tick(), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("automation scheduler started", { tickSeconds, intervalMs });
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  globalThis.__vwrayScheduler = false;
}
