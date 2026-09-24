import "server-only";
import { EventEmitter } from "node:events";
import type { DomainEventMap, DomainEventName } from "@/server/events/types";

/**
 * In-process domain event bus.
 *
 * Same shape as `realtime/bus.ts` (and the same globalThis caching, so a Next.js dev
 * reload does not accumulate emitters), but for FACTS rather than for chart frames.
 *
 * Subscriber isolation is the point of this file: a subscriber that throws must not
 * prevent the other subscribers from seeing the event, and must never propagate an
 * error back into the business transaction that published it. A notification UI bug is
 * not allowed to fail a quota enforcement.
 *
 * Multi-replica: like the realtime bus, this is per-process. A deployment with more
 * than one control-plane replica that needs cross-replica automation should back both
 * buses with Redis pub/sub; the subscribe/publish contract below does not change.
 */

declare global {

  var __vwrayDomainBus: EventEmitter | undefined;
}

function createBus(): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(500);
  return emitter;
}

export const domainBus: EventEmitter = globalThis.__vwrayDomainBus ?? createBus();
if (!globalThis.__vwrayDomainBus) globalThis.__vwrayDomainBus = domainBus;

export type DomainListener<K extends DomainEventName> = (payload: DomainEventMap[K]) => void;

export function onDomainEvent<K extends DomainEventName>(
  name: K,
  listener: DomainListener<K>,
): () => void {
  domainBus.on(name, listener as (payload: unknown) => void);
  return () => domainBus.off(name, listener as (payload: unknown) => void);
}

/**
 * Emits to every subscriber. Errors are swallowed here, on purpose (see the module
 * comment); `dispatch.ts` logs them with the event name so a broken subscriber is
 * visible in the log rather than silently missing.
 */
export function emitDomainEvent<K extends DomainEventName>(
  name: K,
  payload: DomainEventMap[K],
): Array<{ listener: string; error: unknown }> {
  const failures: Array<{ listener: string; error: unknown }> = [];
  for (const listener of domainBus.listeners(name)) {
    try {
      (listener as (value: DomainEventMap[K]) => void)(payload);
    } catch (error) {
      failures.push({ listener: listener.name || "anonymous", error });
    }
  }
  return failures;
}

/** Attached listener count, reported by the system status endpoint. */
export function domainSubscriberCount(name?: DomainEventName): number {
  if (name) return domainBus.listenerCount(name);
  return domainBus.eventNames().reduce((total, eventName) => total + domainBus.listenerCount(eventName), 0);
}
