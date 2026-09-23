import "server-only";
import { logger } from "@/server/lib/logger";
import { emitDomainEvent } from "@/server/events/bus";
import type { DomainEventMap, DomainEventName } from "@/server/events/types";

/**
 * The only sanctioned way to publish a domain event.
 *
 * Why this is a separate module from `bus.ts`: publishing has a side effect the bus
 * cannot express - the first publish wires the standard subscribers (timeline,
 * notifications, realtime bridge, audit). Those subscribers are imported LAZILY, which
 * breaks the import cycle that would otherwise exist between, say, the quota engine and
 * the notification service that reacts to it.
 *
 * Publishing is awaitable so a caller can order it after its transaction commits, but it
 * resolves as soon as the in-process subscribers have been invoked. Subscribers that need
 * to do I/O are responsible for their own error handling; `emitDomainEvent` isolates
 * their failures so one broken subscriber cannot starve the others.
 */

let wiring: Promise<void> | null = null;

async function ensureWired(): Promise<void> {
  if (!wiring) {
    wiring = import("@/server/events/subscribers")
      .then((module) => module.registerCoreSubscribers())
      .catch((error: unknown) => {
        // Reset so a transient failure does not permanently disable the event engine.
        wiring = null;
        logger.error("domain event subscriber wiring failed", { error });
      });
  }
  return wiring;
}

export async function publishDomain<K extends DomainEventName>(
  name: K,
  payload: DomainEventMap[K],
): Promise<void> {
  await ensureWired();
  const failures = emitDomainEvent(name, payload);
  for (const failure of failures) {
    logger.error("domain event subscriber failed", {
      event: name,
      listener: failure.listener,
      error: failure.error,
    });
  }
}
