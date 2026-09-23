import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { getSetting } from "@/server/settings/service";
import { resolveRange, type DateRange } from "@/server/lib/time";
import { applySavingFormula } from "@/lib/format/units";

/**
 * Traffic history analytics.
 *
 * Reads `TrafficAggregate`, which stores HUB rows: one row family per single
 * dimension, identified by a synthetic `dimKey` (`system`, `node:<id>`,
 * `device:<id>`, `user:<id>`, `config:<id>`, `category:<name>`). See
 * TRAFFIC_PIPELINE.md.
 *
 * That model has one consequence this module must be honest about: an aggregate for
 * "device A on node B" does not exist, because the writer records each dimension
 * separately. Rather than invent that number by multiplying or averaging two hub
 * rows, the query resolves ONE primary dimension from the supplied filters and
 * REPORTS the filters it could not apply in `ignoredFilters`. An operator who
 * selects both a device and a node therefore sees the device series plus a plain
 * explanation, instead of a plausible-looking wrong figure.
 *
 * `direction` and `source` are real columns on every row, so they always apply.
 */

export type Granularity = "HOUR" | "DAY" | "MINUTE";

export interface TrafficFilters {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  deviceId?: string | null;
  nodeId?: string | null;
  userId?: string | null;
  configId?: string | null;
  category?: string | null;
  direction?: "UPLOAD" | "DOWNLOAD" | null;
  source?: "REAL" | "MOCK" | "ALL" | null;
}

export interface TrafficBucket {
  t: number;
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  optimizedBytes: string | null;
}

export interface TrafficChannel {
  id: string | null;
  label: string;
  bytes: string;
  optimizedBytes: string | null;
}

export type SavingsKind = "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";

export interface TrafficSummary {
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  optimizedBytes: string | null;
  savedBytes: string | null;
  savingPct: number | null;
  savingsKind: SavingsKind;
  peakBps: number | null;
  avgBps: number | null;
  peakBucketStart: string | null;
  packets: number | null;
  connections: number | null;
}

export interface IgnoredFilter {
  filter: string;
  value: string;
  reason: string;
}

export interface TrafficQueryResult {
  range: { start: string; end: string; preset: string; granularity: Granularity };
  appliedDimension: string;
  /** Filters that were part of the request but cannot apply to the series. */
  ignoredFilters: IgnoredFilter[];
  series: TrafficBucket[];
  summary: TrafficSummary;
  breakdown: {
    byNode: TrafficChannel[];
    byDevice: TrafficChannel[];
    byUser: TrafficChannel[];
    byCategory: TrafficChannel[];
  };
  filters: {
    devices: Array<{ id: string; label: string }>;
    nodes: Array<{ id: string; label: string }>;
    users: Array<{ id: string; label: string }>;
    categories: string[];
  };
  mockRowsExcluded: number;
  unavailable: { packets: boolean; connections: boolean; latency: boolean };
}

/** Dimension precedence: the most specific filter wins. */
const DIMENSION_PRECEDENCE: Array<{
  filter: "deviceId" | "configId" | "userId" | "nodeId" | "category";
  prefix: string;
  label: string;
}> = [
  { filter: "deviceId", prefix: "device", label: "device" },
  { filter: "configId", prefix: "config", label: "configuration" },
  { filter: "userId", prefix: "user", label: "user" },
  { filter: "nodeId", prefix: "node", label: "node" },
  { filter: "category", prefix: "category", label: "category" },
];

export function resolvePrimaryDimension(filters: TrafficFilters): {
  dimKey: string;
  dimension: string;
  ignoredFilters: IgnoredFilter[];
} {
  const present = DIMENSION_PRECEDENCE.filter((entry) => {
    const value = filters[entry.filter];
    return value !== null && value !== undefined && value !== "";
  });

  if (present.length === 0) {
    return { dimKey: "system", dimension: "system", ignoredFilters: [] };
  }

  const primary = present[0] as (typeof DIMENSION_PRECEDENCE)[number];
  const value = String(filters[primary.filter]);

  const ignoredFilters: IgnoredFilter[] = present.slice(1).map((entry) => ({
    filter: entry.filter,
    value: String(filters[entry.filter]),
    reason:
      `Traffic is aggregated per single dimension, so "${primary.label}" was used for the time series ` +
      `and the "${entry.label}" filter is not applied to it. Clear the "${primary.label}" filter to see ` +
      `"${entry.label}" totals instead.`,
  }));

  return {
    dimKey: `${primary.prefix}:${value}`,
    dimension: primary.label,
    ignoredFilters,
  };
}

/** Chooses the stored granularity for a range: HOUR is only written for <= 3 days. */
export function granularityFor(range: DateRange): Granularity {
  const hours = (range.end.getTime() - range.start.getTime()) / 3_600_000;
  return hours <= 72 ? "HOUR" : "DAY";
}

interface AggregateRowShape {
  bucketStart: Date;
  bucketEnd: Date;
  direction: "UPLOAD" | "DOWNLOAD";
  bytes: bigint;
  bytesOptimized: bigint | null;
  packets: bigint | null;
  connections: number | null;
}

function buildWhere(input: {
  range: DateRange;
  dimKey: string;
  granularity: Granularity;
  direction?: "UPLOAD" | "DOWNLOAD" | null;
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Prisma.TrafficAggregateWhereInput {
  return {
    granularity: input.granularity,
    dimKey: input.dimKey,
    bucketStart: { gte: input.range.start, lt: input.range.end },
    ...(input.direction ? { direction: input.direction } : {}),
    // "ALL" is explicit: a caller must ask for mock rows, they are never mixed in by
    // default. That is what stops development traffic appearing in a production view.
    source: input.source && input.source !== "ALL" ? input.source : undefined,
  };
}

/**
 * Runs the traffic query.
 *
 * Called with no `range` it resolves the preset; an unparseable custom range is a
 * validation error rather than a silent fallback to "today", because a filter that
 * quietly does something else is how wrong numbers reach a dashboard.
 */
export async function queryTraffic(filters: TrafficFilters): Promise<TrafficQueryResult> {
  const range = resolveRange({ preset: filters.preset, from: filters.from, to: filters.to });
  if (!range) {
    throw errors.validation("The selected date range is invalid. Provide from/to for a custom range.");
  }

  const granularity = granularityFor(range);
  const { dimKey, dimension, ignoredFilters } = resolvePrimaryDimension(filters);
  const base = buildWhere({
    range,
    dimKey,
    granularity,
    direction: filters.direction,
    source: filters.source,
  });

  const [rows, excludedMock, measuredPackets] = await Promise.all([
    prisma.trafficAggregate.findMany({
      where: base,
      orderBy: { bucketStart: "asc" },
      select: {
        bucketStart: true,
        bucketEnd: true,
        direction: true,
        bytes: true,
        bytesOptimized: true,
        packets: true,
        connections: true,
      },
    }),
    filters.source === "REAL"
      ? prisma.trafficAggregate.count({ where: { ...base, source: "MOCK" } })
      : Promise.resolve(0),
    prisma.trafficAggregate.count({
      where: {
        granularity,
        dimKey,
        bucketStart: { gte: range.start, lt: range.end },
        packets: { not: null },
      },
    }),
  ]);

  const buckets = foldBuckets(rows);
  const summary = summarise(rows, buckets, range, measuredPackets > 0);

  const [byNode, byDevice, byUser, byCategory] = await Promise.all([
    channelBreakdown({ range, prefix: "node", source: filters.source }),
    channelBreakdown({ range, prefix: "device", source: filters.source }),
    channelBreakdown({ range, prefix: "user", source: filters.source }),
    channelBreakdown({ range, prefix: "category", source: filters.source }),
  ]);

  return {
    range: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      preset: filters.preset ?? "today",
      granularity,
    },
    appliedDimension: dimension,
    ignoredFilters,
    series: buckets,
    summary,
    breakdown: { byNode, byDevice, byUser, byCategory },
    filters: await filterOptions(),
    mockRowsExcluded: excludedMock,
    unavailable: {
      packets: measuredPackets === 0,
      connections: summary.connections === null,
      // Latency is a per-session gateway measurement, not an aggregate property, so
      // it is reported unavailable here rather than derived from anything.
      latency: true,
    },
  };
}

/** Folds UPLOAD/DOWNLOAD rows into one bucket per timestamp. */
function foldBuckets(rows: AggregateRowShape[]): TrafficBucket[] {
  const byStart = new Map<
    number,
    { upload: bigint; download: bigint; optimized: bigint; hasOptimized: boolean }
  >();

  for (const row of rows) {
    const key = row.bucketStart.getTime();
    const bucket = byStart.get(key) ?? { upload: 0n, download: 0n, optimized: 0n, hasOptimized: false };

    if (row.direction === "UPLOAD") bucket.upload += row.bytes;
    else bucket.download += row.bytes;

    if (row.bytesOptimized !== null) {
      bucket.optimized += row.bytesOptimized;
      bucket.hasOptimized = true;
    }

    byStart.set(key, bucket);
  }

  return Array.from(byStart.entries())
    .sort(([left], [right]) => left - right)
    .map(([t, bucket]) => ({
      t,
      uploadBytes: bucket.upload.toString(),
      downloadBytes: bucket.download.toString(),
      totalBytes: (bucket.upload + bucket.download).toString(),
      optimizedBytes: bucket.hasOptimized ? bucket.optimized.toString() : null,
    }));
}

/** Peak and average are derived from the same bytes the chart draws, never separately. */
function summarise(
  rows: AggregateRowShape[],
  buckets: TrafficBucket[],
  range: DateRange,
  packetsMeasured: boolean,
): TrafficSummary {
  let upload = 0n;
  let download = 0n;
  let optimized = 0n;
  let hasOptimized = false;
  let packets: bigint | null = null;
  let connections: number | null = null;
  let peakBps: number | null = null;
  let peakBucketStart: string | null = null;

  const bucketSeconds = (bucket: TrafficBucket, index: number): number => {
    const next = buckets[index + 1];
    if (next) return Math.max(1, (next.t - bucket.t) / 1000);
    const previous = buckets[index - 1];
    if (previous) return Math.max(1, (bucket.t - previous.t) / 1000);
    return Math.max(1, (range.end.getTime() - Math.max(range.start.getTime(), bucket.t)) / 1000);
  };

  buckets.forEach((bucket, index) => {
    const rate = Number(BigInt(bucket.totalBytes)) / bucketSeconds(bucket, index);
    if (!Number.isFinite(rate)) return;
    if (peakBps === null || rate > peakBps) {
      peakBps = rate;
      peakBucketStart = new Date(bucket.t).toISOString();
    }
  });

  for (const row of rows) {
    if (row.direction === "UPLOAD") upload += row.bytes;
    else download += row.bytes;
    if (row.bytesOptimized !== null) {
      optimized += row.bytesOptimized;
      hasOptimized = true;
    }
    if (row.packets !== null) packets = (packets ?? 0n) + row.packets;
    if (row.connections !== null) connections = Math.max(connections ?? 0, row.connections);
  }

  const total = upload + download;
  const rangeSeconds = Math.max(1, (range.end.getTime() - range.start.getTime()) / 1000);
  const avgBps = Number(total) / rangeSeconds;

  let savedBytes: string | null = null;
  let savingPct: number | null = null;
  let savingsKind: SavingsKind = "INSUFFICIENT_DATA";

  if (hasOptimized) {
    const formula = applySavingFormula(total, optimized);
    savedBytes = formula.savedBytes.toString();
    savingPct = formula.actualSavingPercent;
    savingsKind = savingPct === null ? "INSUFFICIENT_DATA" : "MEASURED";
  }

  return {
    uploadBytes: upload.toString(),
    downloadBytes: download.toString(),
    totalBytes: total.toString(),
    optimizedBytes: hasOptimized ? optimized.toString() : null,
    savedBytes,
    savingPct,
    savingsKind,
    peakBps: Number.isFinite(avgBps) ? peakBps : null,
    avgBps: Number.isFinite(avgBps) ? avgBps : null,
    peakBucketStart,
    packets: packetsMeasured && packets !== null ? Number(packets) : null,
    connections,
  };
}

/**
 * Totals per entity for one dimension.
 *
 * Uses the hub rows for that dimension only (`dimKey` prefix), so the four breakdowns
 * never overlap and each is authoritative for its own dimension.
 */
async function channelBreakdown(input: {
  range: DateRange;
  prefix: "node" | "device" | "user" | "category";
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Promise<TrafficChannel[]> {
  const grouped = await prisma.trafficAggregate.groupBy({
    by: ["dimKey"],
    where: {
      dimKey: { startsWith: `${input.prefix}:` },
      bucketStart: { gte: input.range.start, lt: input.range.end },
      ...(input.source && input.source !== "ALL" ? { source: input.source } : {}),
    },
    _sum: { bytes: true, bytesOptimized: true },
    _max: { bytesOptimized: true },
  });

  const entries = grouped
    .map((row) => ({
      id: row.dimKey.slice(input.prefix.length + 1),
      bytes: row._sum.bytes ?? 0n,
      optimized: row._sum.bytesOptimized ?? null,
    }))
    .filter((row) => row.bytes > 0n || row.optimized !== null)
    .sort((left, right) => (right.bytes > left.bytes ? 1 : right.bytes < left.bytes ? -1 : 0));

  const labels: Map<string, string> =
    input.prefix === "category"
      ? new Map()
      : await lookupLabels(
          input.prefix,
          entries.map((entry) => entry.id),
        );

  return entries.map((entry) => ({
    id: entry.id,
    // A dimension value whose entity was deleted still has bytes against it, so the
    // label falls back to a truthful "removed" marker instead of hiding the traffic.
    label:
      input.prefix === "category"
        ? entry.id
        : (labels.get(entry.id) ?? `(removed ${input.prefix} ${entry.id.slice(0, 8)})`),
    bytes: entry.bytes.toString(),
    optimizedBytes: entry.optimized === null ? null : entry.optimized.toString(),
  }));
}

async function lookupLabels(
  prefix: "node" | "device" | "user",
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();

  if (prefix === "node") {
    const rows = await prisma.vpnNode.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
  if (prefix === "device") {
    const rows = await prisma.device.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
  const rows = await prisma.adminUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, username: true },
  });
  return new Map(rows.map((row) => [row.id, row.username]));
}

/** Filter dropdown options, capped so the payload stays small. */
async function filterOptions(): Promise<TrafficQueryResult["filters"]> {
  const [devices, nodes, users, categories] = await Promise.all([
    prisma.device.findMany({
      orderBy: { lastSeenAt: "desc" },
      take: 200,
      select: { id: true, displayName: true },
    }),
    prisma.vpnNode.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    prisma.adminUser.findMany({ orderBy: { username: "asc" }, select: { id: true, username: true } }),
    prisma.trafficAggregate.groupBy({
      by: ["category"],
      where: { category: { not: null } },
      _sum: { bytes: true },
    }),
  ]);

  return {
    devices: devices.map((row) => ({ id: row.id, label: row.displayName })),
    nodes: nodes.map((row) => ({ id: row.id, label: row.name })),
    users: users.map((row) => ({ id: row.id, label: row.username })),
    categories: categories
      .map((row) => row.category as string)
      .filter((value): value is string => Boolean(value))
      .sort(),
  };
}
