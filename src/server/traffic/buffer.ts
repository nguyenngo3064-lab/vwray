import "server-only";
import type { AggregateGranularity, DataSource, TrafficDirection } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { logger } from "@/server/lib/logger";
import { optimizationDimKey } from "@/server/traffic/dimensions";

/**
 * Raw-sample buffer and rollup writer.
 *
 * Why a buffer exists at all: a data plane can push hundreds of samples per second.
 * One `INSERT` per sample plus four aggregate upserts per sample would make the
 * control plane's write amplification the bottleneck of the whole system, and would
 * put a row per second into PostgreSQL for a graph that is usually showing the last
 * 30 seconds anyway.
 *
 * So: samples are accumulated in memory and flushed in batches every
 * `TRAFFIC_FLUSH_INTERVAL_SECONDS` (default 10s), during which PostgreSQL sees one
 * bulk insert and a handful of upserts per dimension.
 *
 * Crash-window trade-off, stated explicitly: up to one flush interval of raw samples
 * can be lost if the process dies. Aggregates are derived from those raw samples, so
 * billing history can be short by that amount on an unclean shutdown. This is the
 * standard telemetry trade-off and is documented in TRAFFIC_PIPELINE.md; if exact
 * accounting is required, lower `TRAFFIC_FLUSH_INTERVAL_SECONDS`.
 */

export interface PendingSample {
  ts: Date;
  nodeId: string;
  deviceId: string | null;
  userId: string | null;
  configId: string | null;
  direction: TrafficDirection;
  bytes: bigint;
  bytesOptimized: bigint | null;
  packets: number | null;
  connections: number | null;
  domainId: string | null;
  category: string | null;
  source: DataSource;
}

/** Hard ceiling so a stalled database cannot exhaust the process heap. */
const MAX_PENDING = 50_000;

let pending: PendingSample[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function queueSample(sample: PendingSample): void {
  pending.push(sample);
  if (pending.length >= MAX_PENDING) {
    // Flush inline rather than dropping: losing accounting data silently is worse
    // than a slow ingest response.
    void flush().catch((error) => logger.error("buffer overflow flush failed", { error }));
  }
}

export function pendingCount(): number {
  return pending.length;
}

export function pendingSnapshot(): PendingSample[] {
  return pending;
}

/** Clears the buffer without writing. Test-only escape hatch. */
export function discardPending(): void {
  pending = [];
}

interface AggregateKey {
  granularity: AggregateGranularity;
  bucketStart: number;
  nodeId: string | null;
  deviceId: string | null;
  userId: string | null;
  configId: string | null;
  category: string | null;
  direction: TrafficDirection;
  source: DataSource;
}

export interface AggregateRow extends AggregateKey {
  /** Non-null dimension identity (see TrafficAggregate docs): "system", "node:<id>", ... */
  dimKey: string;
  bucketEnd: number;
  bytes: bigint;
  bytesOptimized: bigint;
  hasOptimized: boolean;
  packets: bigint;
  connections: number;
}

function bucketStartFor(ts: Date, granularity: AggregateGranularity): number {
  const date = new Date(ts);
  date.setUTCSeconds(0, 0);
  if (granularity === "MINUTE") return date.getTime();
  date.setUTCMinutes(0, 0);
  if (granularity === "HOUR") return date.getTime();
  date.setUTCHours(0, 0);
  if (granularity === "DAY") return date.getTime();
  date.setUTCDate(1);
  return date.getTime();
}

const GRANULARITY_MS: Record<AggregateGranularity, number> = {
  MINUTE: 60_000,
  HOUR: 3_600_000,
  DAY: 86_400_000,
  MONTH: 28 * 86_400_000,
};

/**
 * Folds a batch of raw samples into aggregate rows.
 *
 * Pure and exported so it can be unit-tested without a database: this is where the
 * accounting maths lives, and a bug here would silently corrupt billing history.
 *
 * Dimensions emitted per sample:
 *   system   - the "everything" row (`dimKey = "system"`)
 *   node     - per-gateway
 *   device   - per-device (also drives quota and top-consumer views)
 *   user     - per owner, when the device has one
 *   config   - per VPN configuration, when one is attached
 *   category - per traffic category, when attribution exists
 *
 * Rows are written at HOUR and DAY granularity. Summing across dimensions in one
 * query would double-count, which is why callers must filter on `dimKey`.
 */
export function rollup(samples: PendingSample[]): AggregateRow[] {
  const rows = new Map<string, AggregateRow>();

  const accumulate = (
    granularity: AggregateGranularity,
    sample: PendingSample,
    dimensions: {
      dimKey: string;
      nodeId: string | null;
      deviceId: string | null;
      userId: string | null;
      configId: string | null;
      category: string | null;
    },
  ): void => {
    const bucketStart = bucketStartFor(sample.ts, granularity);
    const key = [
      granularity,
      bucketStart,
      dimensions.dimKey,
      sample.direction,
      sample.source,
    ].join("|");

    const existing = rows.get(key);
    if (existing) {
      existing.bytes += sample.bytes;
      existing.packets += BigInt(sample.packets ?? 0);
      existing.connections = Math.max(existing.connections, sample.connections ?? 0);
      if (sample.bytesOptimized !== null && sample.bytesOptimized !== undefined) {
        existing.bytesOptimized += sample.bytesOptimized;
        existing.hasOptimized = true;
      }
      return;
    }

    rows.set(key, {
      granularity,
      bucketStart,
      bucketEnd: bucketStart + GRANULARITY_MS[granularity],
      dimKey: dimensions.dimKey,
      nodeId: dimensions.nodeId,
      deviceId: dimensions.deviceId,
      userId: dimensions.userId,
      configId: dimensions.configId,
      category: dimensions.category,
      direction: sample.direction,
      source: sample.source,
      bytes: sample.bytes,
      bytesOptimized: sample.bytesOptimized ?? 0n,
      hasOptimized: sample.bytesOptimized !== null && sample.bytesOptimized !== undefined,
      packets: BigInt(sample.packets ?? 0),
      connections: sample.connections ?? 0,
    });
  };

  for (const sample of samples) {
    const dimensions = {
      dimKey: "system",
      nodeId: null as string | null,
      deviceId: sample.deviceId,
      userId: sample.userId,
      configId: sample.configId,
      category: null as string | null,
    };

    for (const granularity of ["HOUR", "DAY"] as const) {
      // system total
      accumulate(granularity, sample, dimensions);

      if (sample.nodeId) {
        accumulate(granularity, sample, { ...dimensions, dimKey: `node:${sample.nodeId}`, nodeId: sample.nodeId });
      }
      if (sample.deviceId) {
        accumulate(granularity, sample, {
          ...dimensions,
          dimKey: `device:${sample.deviceId}`,
          userId: null,
          configId: null,
        });
      }
      if (sample.userId) {
        accumulate(granularity, sample, {
          ...dimensions,
          dimKey: `user:${sample.userId}`,
          nodeId: null,
          deviceId: null,
          configId: null,
        });
      }
      if (sample.configId) {
        accumulate(granularity, sample, {
          ...dimensions,
          dimKey: `config:${sample.configId}`,
          nodeId: null,
          deviceId: null,
          userId: null,
        });
      }
      if (sample.category) {
        accumulate(granularity, sample, {
          ...dimensions,
          dimKey: `category:${sample.category}`,
          nodeId: null,
          deviceId: null,
          userId: null,
          configId: null,
          category: sample.category,
        });
      }
    }
  }

  return Array.from(rows.values());
}

let flushing = false;

/**
 * Persists the buffer: one bulk insert for raw samples and one batched transaction of
 * upserts for aggregates.
 *
 * On failure the batch is pushed back to the FRONT of the queue (bounded by
 * MAX_PENDING) rather than dropped, so a transient database blip does not create a
 * hole in billing history. The next flush retries it.
 */
export async function flush(): Promise<{ samples: number; aggregates: number; optimizations: number }> {
  if (flushing || pending.length === 0) return { samples: 0, aggregates: 0, optimizations: 0 };
  flushing = true;

  const batch = pending;
  pending = [];

  try {
    await prisma.trafficSample.createMany({
      data: batch.map((sample) => ({
        ts: sample.ts,
        nodeId: sample.nodeId,
        deviceId: sample.deviceId,
        direction: sample.direction,
        bytes: sample.bytes,
        bytesOptimized: sample.bytesOptimized,
        packets: sample.packets,
        connections: sample.connections,
        domainId: sample.domainId,
        source: sample.source,
      })),
    });

    const rows = rollup(batch);

    const aggregateOps = rows.map((row) =>
      prisma.trafficAggregate.upsert({
        where: {
          granularity_bucketStart_dimKey_direction_source: {
            granularity: row.granularity,
            bucketStart: new Date(row.bucketStart),
            dimKey: row.dimKey,
            direction: row.direction,
            source: row.source,
          },
        },
        create: {
          granularity: row.granularity,
          bucketStart: new Date(row.bucketStart),
          bucketEnd: new Date(row.bucketEnd),
          dimKey: row.dimKey,
          nodeId: row.nodeId,
          deviceId: row.deviceId,
          userId: row.userId,
          configId: row.configId,
          category: row.category,
          direction: row.direction,
          bytes: row.bytes,
          // Optimized bytes are only stored when the gateway reported them. Writing 0
          // for a gateway that cannot measure optimization would later read back as
          // "100% saved", which would be a lie.
          bytesOptimized: row.hasOptimized ? row.bytesOptimized : null,
          packets: row.packets,
          connections: row.connections,
          source: row.source,
        },
        update: {
          bytes: { increment: row.bytes },
          packets: { increment: row.packets },
          connections: row.connections,
          bucketEnd: new Date(row.bucketEnd),
          ...(row.hasOptimized ? { bytesOptimized: { increment: row.bytesOptimized } } : {}),
        },
      }),
    );

    // One transaction per chunk: a partially applied set of aggregates would break
    // every total on the dashboard, because the raw samples are already stored.
    for (let index = 0; index < aggregateOps.length; index += 100) {
      await prisma.$transaction(aggregateOps.slice(index, index + 100));
    }

    const optimizations = await recordOptimizationFromBatch(batch);
    return { samples: batch.length, aggregates: rows.length, optimizations };
  } catch (error) {
    const overflowed = pending.length + batch.length > MAX_PENDING;
    pending = overflowed ? batch.slice(-MAX_PENDING) : [...batch, ...pending];
    logger.error("traffic flush failed; batch requeued", {
      batchSize: batch.length,
      pendingNow: pending.length,
      dropped: overflowed,
      error,
    });
    throw error;
  } finally {
    flushing = false;
  }
}

/**
 * Writes MEASURED optimization records for the buckets in this batch.
 *
 * "MEASURED" is earned: a record is only written when the sample carried a non-null
 * `bytesOptimized`, i.e. the data plane counted the volume both before and after its
 * own transformation. Samples without that field never reach this table, so the
 * analytics layer cannot accidentally present an assumption as a measurement.
 */
async function recordOptimizationFromBatch(batch: PendingSample[]): Promise<number> {
  const rows = rollup(batch).filter((row) => row.hasOptimized);
  if (rows.length === 0) return 0;

  const deviceIds = Array.from(
    new Set(rows.map((row) => row.deviceId).filter((id): id is string => Boolean(id))),
  );
  const devices =
    deviceIds.length > 0
      ? await prisma.device.findMany({
          where: { id: { in: deviceIds } },
          select: { id: true, optimizationProfileId: true },
        })
      : [];
  const profileByDevice = new Map(devices.map((device) => [device.id, device.optimizationProfileId]));

  let written = 0;
  for (const row of rows) {
    const profileId = row.deviceId ? (profileByDevice.get(row.deviceId) ?? null) : null;
    const dimKey = optimizationDimKey({
      deviceId: row.deviceId,
      nodeId: row.nodeId,
      userId: row.userId,
      profileId,
      category: row.category,
    });

    const savedBytes = row.bytes - row.bytesOptimized;
    const savingPct = row.bytes > 0n ? (Number(savedBytes) / Number(row.bytes)) * 100 : null;

    const existing = await prisma.optimizationRecord.findFirst({
      where: {
        granularity: row.granularity,
        bucketStart: new Date(row.bucketStart),
        dimKey,
        kind: "MEASURED",
        source: row.source,
      },
    });

    if (existing) {
      const mergedOriginal = existing.originalBytes + row.bytes;
      const mergedOptimized = existing.optimizedBytes + row.bytesOptimized;
      const mergedSaved = mergedOriginal - mergedOptimized;

      await prisma.optimizationRecord.update({
        where: { id: existing.id },
        data: {
          originalBytes: mergedOriginal,
          optimizedBytes: mergedOptimized,
          savedBytes: mergedSaved,
          // Percentage is always recomputed from the merged totals, never averaged:
          // averaging percentages across buckets of different sizes is wrong.
          savingPct:
            mergedOriginal > 0n
              ? Math.round((Number(mergedSaved) / Number(mergedOriginal)) * 1000) / 10
              : null,
          bucketEnd: new Date(row.bucketEnd),
        },
      });
    } else {
      await prisma.optimizationRecord.create({
        data: {
          granularity: row.granularity,
          bucketStart: new Date(row.bucketStart),
          bucketEnd: new Date(row.bucketEnd),
          dimKey,
          profileId,
          deviceId: row.deviceId,
          nodeId: row.nodeId,
          userId: row.userId,
          category: row.category,
          originalBytes: row.bytes,
          optimizedBytes: row.bytesOptimized,
          savedBytes,
          savingPct: savingPct === null ? null : Math.round(savingPct * 10) / 10,
          kind: "MEASURED",
          source: row.source,
        },
      });
    }
    written += 1;
  }

  return written;
}

/**
 * Starts the periodic flush. Like the aggregator ticker this is lazy: importing the
 * module during `next build` must not keep a timer alive.
 */
export function startFlusher(): void {
  if (timer) return;
  const intervalMs = getEnv().TRAFFIC_FLUSH_INTERVAL_SECONDS * 1000;
  timer = setInterval(() => {
    void flush().catch(() => {
      // Already logged with context inside flush(); swallow so the interval survives.
    });
  }, intervalMs);
  timer.unref?.();
}

/** Flushes whatever is buffered and stops the timer. Used on shutdown and in tests. */
export async function stopFlusher(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (pending.length > 0) await flush();
}

/** Test helper: clears the buffer without writing. */
export function resetBuffer(): void {
  pending = [];
  flushing = false;
}
