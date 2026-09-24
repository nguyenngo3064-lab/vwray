import "server-only";
import { getEnv } from "@/server/config/env";
import { publish, subscriberCount, type TrafficTick } from "@/server/realtime/bus";
import { logger } from "@/server/lib/logger";

/**
 * Realtime traffic aggregator.
 *
 * Responsibilities:
 *   1. Turn batched byte counters from the collector into per-second RATES.
 *   2. Keep a sliding ring buffer sized to the widest chart window, so a browser that
 *      connects mid-minute receives history instead of starting flat.
 *   3. Publish one `traffic.tick` per second to SSE subscribers. NOTHING here writes
 *      to PostgreSQL: history is written by the collector's flush path at a much lower
 *      frequency (see TRAFFIC_PIPELINE.md).
 *
 * Honesty rules encoded below:
 *   * A rate of 0 bps is only reported when a gateway reported a zero delta. If no
 *     gateway has reported inside the freshness window the status becomes `stale`, so
 *     the UI renders "Gateway unavailable" instead of a flat zero line.
 *   * The buffer is never back-filled. After a restart the chart starts empty, which
 *     is the truth: the control plane cannot know bytes it did not observe.
 */

interface Point {
  t: number;
  uploadBps: number;
  downloadBps: number;
  totalBps: number;
  connections: number;
}

interface NodeRate {
  nodeId: string;
  uploadBps: number;
  downloadBps: number;
  sessions: number;
  lastReportAt: number;
}

interface Pending {
  uploadBytes: number;
  downloadBytes: number;
  connections: number;
}

const TICK_MS = 1000;

export class RealtimeAggregator {
  private readonly points: Point[] = [];
  private readonly nodes = new Map<string, NodeRate>();
  private pending: Pending = { uploadBytes: 0, downloadBytes: 0, connections: 0 };
  private pendingByNode = new Map<string, Pending>();
  private lastTickAt: number | null = null;
  private lastIngestAt: number | null = null;
  private sawMockFeed = false;
  private sawRealFeed = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Cached status so the SSE handshake frame and the tick frames agree. */
  private status: TrafficTick["status"] = "stale";

  /** Records a batch of bytes observed by the collector. */
  ingest(batch: {
    nodeId: string;
    uploadBytes: number;
    downloadBytes: number;
    connections?: number;
    sessions?: number;
    mock?: boolean;
    at?: number;
  }): void {
    const now = batch.at ?? Date.now();
    this.lastIngestAt = now;
    if (batch.mock) this.sawMockFeed = true;
    else this.sawRealFeed = true;

    this.pending.uploadBytes += batch.uploadBytes;
    this.pending.downloadBytes += batch.downloadBytes;
    this.pending.connections = batch.connections ?? this.pending.connections;

    const nodePending = this.pendingByNode.get(batch.nodeId) ?? {
      uploadBytes: 0,
      downloadBytes: 0,
      connections: 0,
    };
    nodePending.uploadBytes += batch.uploadBytes;
    nodePending.downloadBytes += batch.downloadBytes;
    nodePending.connections = batch.connections ?? nodePending.connections;
    this.pendingByNode.set(batch.nodeId, nodePending);

    const existing = this.nodes.get(batch.nodeId);
    this.nodes.set(batch.nodeId, {
      nodeId: batch.nodeId,
      uploadBps: existing?.uploadBps ?? 0,
      downloadBps: existing?.downloadBps ?? 0,
      sessions: batch.sessions ?? existing?.sessions ?? 0,
      lastReportAt: now,
    });

    this.ensureRunning();
  }

  /**
   * Starts the ticker lazily. Importing this module during `next build` must not open
   * a timer, otherwise the build process would never exit.
   */
  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    // Do not hold the event loop open: a pending chart tick must not block shutdown.
    this.timer.unref?.();
  }

  /** Advances the clock one interval, publishing the derived rates. */
  private tick(): void {
    const now = Date.now();
    const seconds = TICK_MS / 1000;

    const uploadBps = this.pending.uploadBytes / seconds;
    const downloadBps = this.pending.downloadBytes / seconds;
    const totalBps = uploadBps + downloadBps;
    const connections = this.pending.connections;

    for (const [nodeId, pending] of this.pendingByNode) {
      const record = this.nodes.get(nodeId);
      if (!record) continue;
      record.uploadBps = pending.uploadBytes / seconds;
      record.downloadBps = pending.downloadBytes / seconds;
      if (pending.connections) record.sessions = pending.connections;
    }

    this.points.push({ t: now, uploadBps, downloadBps, totalBps, connections });

    const maxWindow = Math.max(...getEnv().realtimeWindows, 60);
    while (this.points.length > maxWindow + 5) this.points.shift();

    this.pending = { uploadBytes: 0, downloadBytes: 0, connections: 0 };
    this.pendingByNode.clear();
    this.lastTickAt = now;
    this.status = this.resolveStatus(totalBps);

    if (subscriberCount() === 0) return;

    publish("traffic.tick", {
      ts: now,
      uploadBps,
      downloadBps,
      totalBps,
      activeConnections: connections,
      status: this.status,
      nodes: Array.from(this.nodes.values()).map((node) => ({
        nodeId: node.nodeId,
        uploadBps: node.uploadBps,
        downloadBps: node.downloadBps,
        sessions: node.sessions,
      })),
    });
  }

  /**
   * Decides what the chart may claim.
   *
   * Order matters: a silent gateway outranks everything else, because "0 bps" and
   * "we cannot see the gateway" look identical numerically but mean opposite things.
   */
  private resolveStatus(totalBps: number): TrafficTick["status"] {
    const env = getEnv();
    const now = Date.now();
    const staleMs = Math.max(15, Number(process.env.NODE_STALE_SECONDS ?? 90)) * 1000;

    let newestReport = 0;
    for (const node of this.nodes.values()) newestReport = Math.max(newestReport, node.lastReportAt);

    const neverReported = this.lastIngestAt === null;
    const allSilent = neverReported || now - newestReport > staleMs;

    if (allSilent) {
      // No node registered yet: we have no visibility at all.
      if (this.nodes.size === 0) return "stale";
      // Development with the mock gateway enabled and no real feed ever seen.
      if (env.isDevelopment && env.DEV_MOCK_GATEWAY_ENABLED && !this.sawRealFeed) return "idle";
      return "stale";
    }

    if (this.sawMockFeed && !this.sawRealFeed) return "mock";
    if (totalBps === 0) return "idle";
    return "live";
  }

  /** Sliding window for one chart, oldest first. */
  snapshot(windowSeconds: number): Point[] {
    if (this.points.length === 0) return [];
    const cutoff = Date.now() - windowSeconds * 1000;
    return this.points.filter((point) => point.t >= cutoff);
  }

  /** Header state for the SSE stream, so the first frame is not a blind wait. */
  hello(): TrafficTick {
    const points = this.snapshot(Math.max(...getEnv().realtimeWindows));
    const latest = points.at(-1);
    return {
      ts: Date.now(),
      uploadBps: latest?.uploadBps ?? 0,
      downloadBps: latest?.downloadBps ?? 0,
      totalBps: latest?.totalBps ?? 0,
      activeConnections: latest?.connections ?? 0,
      status: this.status,
      nodes: Array.from(this.nodes.values()).map((node) => ({
        nodeId: node.nodeId,
        uploadBps: node.uploadBps,
        downloadBps: node.downloadBps,
        sessions: node.sessions,
      })),
    };
  }

  lastTick(): number | null {
    return this.lastTickAt;
  }

  cachedStatus(): TrafficTick["status"] {
    return this.status;
  }

  /** Drops all state. Used by tests so two suites cannot see each other's points. */
  reset(): void {
    this.points.length = 0;
    this.nodes.clear();
    this.pendingByNode.clear();
    this.pending = { uploadBytes: 0, downloadBytes: 0, connections: 0 };
    this.lastTickAt = null;
    this.lastIngestAt = null;
    this.sawMockFeed = false;
    this.sawRealFeed = false;
    this.status = "stale";
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

declare global {

  var __vwrayAggregator: RealtimeAggregator | undefined;
}

/** Singleton that survives Next.js dev-module reloads. */
export const aggregator: RealtimeAggregator =
  globalThis.__vwrayAggregator ?? new RealtimeAggregator();
if (!globalThis.__vwrayAggregator) globalThis.__vwrayAggregator = aggregator;

export type { Point as TrafficPoint };

export function logAggregatorStarted(): void {
  logger.debug("realtime aggregator initialised", { windows: getEnv().realtimeWindows });
}
