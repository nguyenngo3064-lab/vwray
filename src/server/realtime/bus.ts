import "server-only";
import { EventEmitter } from "node:events";
import type { NotificationSeverity } from "@prisma/client";

/**
 * Realtime event bus.
 *
 * The dashboard's live view is driven by this bus, NOT by polling PostgreSQL. The
 * pipeline is:
 *
 *   gateway agent -> traffic collector -> aggregator -> THIS BUS -> SSE -> browser
 *                                |
 *                                +-> batched rollup -> PostgreSQL (history)
 *
 * A single Node process fans events out in memory. For a multi-replica deployment the
 * same interface can be backed by Redis pub/sub (see TRAFFIC_PIPELINE.md); the
 * subscriber API is identical either way, so nothing above this file changes.
 *
 * The bus deliberately carries ONLY derived state (rates, counters, statuses). Raw
 * samples never travel over it, which keeps message size bounded no matter how much
 * traffic the data plane sees.
 */

export interface TrafficTick {
  ts: number;
  /** Bytes per second, smoothed over the ingest interval. */
  uploadBps: number;
  downloadBps: number;
  totalBps: number;
  activeConnections: number;
  /** Per-node rates, for the node column in the dashboard. */
  nodes: Array<{ nodeId: string; uploadBps: number; downloadBps: number; sessions: number }>;
  /**
   * `live`    - a gateway reported inside the freshness window
   * `idle`    - gateway healthy, but nobody is transferring
   * `stale`   - no gateway has reported recently: the chart must NOT show 0 bps
   * `mock`    - the only feed is the development mock gateway
   */
  status: "live" | "idle" | "stale" | "mock";
}

export interface SystemStatus {
  ts: number;
  controlPlane: "up" | "degraded" | "down";
  database: { state: "up" | "down"; latencyMs: number | null };
  realtime: { clients: number; lastTickAt: number | null };
  gateway: {
    state: "connected" | "degraded" | "unavailable" | "unknown";
    nodesOnline: number;
    nodesTotal: number;
    lastHeartbeatAt: number | null;
    mockOnly: boolean;
  };
  dns: { state: "up" | "disabled" | "unknown" };
  optimization: { state: "up" | "unknown" };
}

export interface RealtimeEventMap {
  "traffic.tick": TrafficTick;
  "system.status": SystemStatus;
  notification: {
    ts: number;
    id: string;
    severity: NotificationSeverity;
    type: string;
    title: string;
    body: string;
  };
  "quota.update": {
    ts: number;
    deviceId: string;
    state: "ACTIVE" | "WARNED_80" | "WARNED_90" | "QUOTA_EXCEEDED" | "BLOCKED" | "REVOKED";
    percent: number | null;
    usedBytes: string;
    limitBytes: string;
  };
  "device.update": {
    ts: number;
    deviceId: string;
    connectionStatus: string;
    approvalState: string;
  };
  "node.update": {
    ts: number;
    nodeId: string;
    health: "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN" | "DRAINING" | "MAINTENANCE";
    lastHeartbeatAt: number | null;
  };
}

export type RealtimeEventName = keyof RealtimeEventMap;
export type Listener<K extends RealtimeEventName> = (event: RealtimeEventMap[K]) => void;

declare global {

  var __vwrayBus: EventEmitter | undefined;
}

function createBus(): EventEmitter {
  const emitter = new EventEmitter();
  // The console keeps several SSE connections plus server-side subscribers alive
  // simultaneously; the Node default of 10 listeners would start warning after two.
  emitter.setMaxListeners(500);
  return emitter;
}

export const bus: EventEmitter = globalThis.__vwrayBus ?? createBus();
if (!globalThis.__vwrayBus) globalThis.__vwrayBus = bus;

export function subscribe<K extends RealtimeEventName>(
  event: K,
  listener: Listener<K>,
): () => void {
  bus.on(event, listener as (payload: unknown) => void);
  return () => bus.off(event, listener as (payload: unknown) => void);
}

export function publish<K extends RealtimeEventName>(event: K, payload: RealtimeEventMap[K]): void {
  bus.emit(event, payload);
}

/** Number of attached SSE streams, reported by the health endpoint. */
export function subscriberCount(): number {
  return bus.eventNames().reduce((total, name) => total + bus.listenerCount(name), 0);
}
