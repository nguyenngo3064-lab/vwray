/**
 * Realtime stream contract, shared between the SSE route and the browser.
 *
 * The browser MUST NOT depend on shapes that only exist server-side
 * (src/server/realtime/bus.ts). This file is the boundary: if the server sends
 * something that does not fit these types, the client treats the stream as broken
 * instead of rendering garbage.
 */

export type StreamStatus = "live" | "idle" | "stale" | "mock";

export interface StreamNodeRate {
  nodeId: string;
  uploadBps: number;
  downloadBps: number;
  sessions: number;
}

export interface StreamTick {
  ts: number;
  uploadBps: number;
  downloadBps: number;
  totalBps: number;
  activeConnections: number;
  status: StreamStatus;
  nodes: StreamNodeRate[];
}

export interface StreamHello {
  tick: StreamTick;
  serverTime: number;
  windows: number[];
}

export type StreamEventName = "hello" | "tick" | "ping" | "notification" | "quota.update" | "device.update" | "node.update";

export interface StreamNotification {
  id: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  type: string;
  title: string;
  body: string;
  ts: number;
}

export interface Point {
  t: number;
  uploadBps: number;
  downloadBps: number;
  totalBps: number;
}

/** Validates an incoming frame enough to trust it on screen. */
export function isValidTick(value: unknown): value is StreamTick {
  if (typeof value !== "object" || value === null) return false;
  const tick = value as Record<string, unknown>;
  return (
    typeof tick.ts === "number" &&
    typeof tick.uploadBps === "number" &&
    typeof tick.downloadBps === "number" &&
    typeof tick.totalBps === "number" &&
    typeof tick.activeConnections === "number" &&
    (tick.status === "live" || tick.status === "idle" || tick.status === "stale" || tick.status === "mock") &&
    Array.isArray(tick.nodes)
  );
}
