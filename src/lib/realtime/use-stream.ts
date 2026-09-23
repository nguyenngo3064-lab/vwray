"use client";

import { useEffect, useRef, useState } from "react";
import { isValidTick, type Point, type StreamStatus } from "@/lib/realtime/types";

/**
 * SSE subscription with an explicit connection state machine.
 *
 * States the hook reports:
 *   connecting    - no frames yet
 *   connected     - hello received, frames flowing
 *   disconnected  - the stream dropped; backoff reconnect is scheduled
 *   error         - the server rejected the stream or sent an invalid frame
 *
 * The hook owns the EventSource lifecycle and the point buffer; the chart component
 * never touches the socket. Points arrive at 1 Hz, so the buffer is capped at
 * (maxWindow + margin) entries and old points are shifted out instead of growing.
 *
 * Reconnect policy: 1s, 2s, 4s, 8s, then capped at 15s. Each attempt fully replaces
 * the previous connection so two streams can never feed the same chart.
 */

interface StreamState {
  status: "connecting" | "connected" | "disconnected" | "error";
  /** Freshness of the feed as reported by the server, not the socket. */
  streamStatus: StreamStatus | null;
  points: Point[];
  activeConnections: number;
  nodes: Array<{ nodeId: string; uploadBps: number; downloadBps: number; sessions: number }>;
  error: string | null;
  /** Round-trip latency of the last ping/pong pair, for the chart footer. */
  latencyMs: number | null;
  retryInSeconds: number | null;
  paused: boolean;
}

const BACKOFF = [1000, 2000, 4000, 8000, 15000];

export function useRealtimeStream(windowSeconds: number, paused: boolean): StreamState & {
  setPaused: (paused: boolean) => void;
  clear: () => void;
} {
  const [state, setState] = useState<StreamState>({
    status: "connecting",
    streamStatus: null,
    points: [],
    activeConnections: 0,
    nodes: [],
    error: null,
    latencyMs: null,
    retryInSeconds: null,
    paused,
  });

  const pauseRef = useRef(paused);
  pauseRef.current = paused;

  const pausePending = useRef<null | { tick: unknown }>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let attempt = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let lastPingAt = 0;

    const maxPoints = Math.max(windowSeconds, 60) + 10;

    function applyTick(raw: unknown) {
      if (!isValidTick(raw)) {
        setState((previous) => ({ ...previous, status: "error", error: "The realtime stream sent an invalid frame." }));
        return;
      }
      const point: Point = {
        t: raw.ts,
        uploadBps: raw.uploadBps,
        downloadBps: raw.downloadBps,
        totalBps: raw.totalBps,
      };
      setState((previous) => {
        if (pauseRef.current) {
          pausePending.current = { tick: raw };
          return previous;
        }
        const points = [...previous.points, point];
        while (points.length > maxPoints) points.shift();
        return {
          ...previous,
          status: "connected",
          streamStatus: raw.status,
          points,
          activeConnections: raw.activeConnections,
          nodes: raw.nodes,
          error: null,
          latencyMs: lastPingAt > 0 ? Math.max(0, Date.now() - lastPingAt) : previous.latencyMs,
        };
      });
    }

    function connect() {
      if (cancelled) return;
      setState((previous) => ({ ...previous, status: "connecting", retryInSeconds: null }));

      source = new EventSource("/api/realtime/stream");

      source.addEventListener("hello", (event) => {
        try {
          const hello = JSON.parse((event as MessageEvent).data) as {
            tick?: unknown;
          };
          if (hello.tick) applyTick(hello.tick);
          attempt = 0;
        } catch {
          // A malformed hello is fatal for this connection; the error handler below reconnects.
        }
      });

      source.addEventListener("tick", (event) => {
        try {
          applyTick(JSON.parse((event as MessageEvent).data));
        } catch {
          setState((previous) => ({ ...previous, status: "error", error: "The realtime stream sent an unreadable frame." }));
        }
      });

      source.addEventListener("ping", () => {
        lastPingAt = Date.now();
      });

      source.onerror = () => {
        source?.close();
        source = null;
        if (cancelled) return;

        const delay = BACKOFF[Math.min(attempt, BACKOFF.length - 1)] ?? 15000;
        attempt += 1;
        setState((previous) => ({
          ...previous,
          status: "disconnected",
          retryInSeconds: Math.round(delay / 1000),
          error: "Realtime disconnected. Reconnecting.",
        }));
        retryTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
    // Reconnect from scratch when the window changes so the buffer matches the chart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowSeconds]);

  function setPaused(next: boolean) {
    setState((previous) => {
      if (!previous.paused && next === false && pausePending.current) {
        // Resume: apply the last tick that arrived while paused, then continue.
        const raw = pausePending.current.tick;
        pausePending.current = null;
        if (isValidTick(raw)) {
          return {
            ...previous,
            paused: next,
            streamStatus: raw.status,
            activeConnections: raw.activeConnections,
            nodes: raw.nodes,
          };
        }
      }
      return { ...previous, paused: next };
    });
  }

  function clear() {
    setState((previous) => ({ ...previous, points: [] }));
  }

  return { ...state, setPaused, clear };
}
