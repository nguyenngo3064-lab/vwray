import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { resolveRange } from "@/server/lib/time";

/**
 * Optimization lab benchmark: profile A vs profile B.
 *
 * The comparison is between two MEASURED groups: traffic that was actually recorded under
 * each profile (or under "no profile") in the same window. Every figure names the records
 * behind it, and anything unmeasured is returned as null with a stated reason. The module
 * never imputes a profile's savings onto traffic that was never observed under it.
 *
 * Reductions are signed: bytes −18% means the second profile carried 18% fewer bytes.
 * Latency is reported as a raw difference (+2ms) alongside the means it came from.
 * Cost is the simulated data cost of each side at the active price.
 */

export interface BenchmarkSide {
  profileKey: string;
  profileName: string | null;
  measured: boolean;
  bytes: string | null;
  bytesGb: number | null;
  sessions: number | null;
  avgLatencyMs: number | null;
  estimatedCost: string | null;
  reason: string | null;
  source: string | null;
}

export interface BenchmarkComparison {
  range: { start: string; end: string; preset: string };
  a: BenchmarkSide;
  b: BenchmarkSide;
  delta: {
    available: boolean;
    dataPct: number | null;
    latencyMs: number | null;
    costPct: number | null;
    direction: string | null;
  };
  notice: string;
}

const NOTICE =
  "Measured comparison of two recorded groups. No modelled or imputed savings appear anywhere in this result.";

async function profileWindow(input: {
  profileKey: string | null;
  deviceId: string | null;
  from: Date;
  to: Date;
  currency: string;
  pricePerGb: number;
}): Promise<BenchmarkSide> {
  const label = input.profileKey ?? "NONE";
  const name =
    input.profileKey === null
      ? null
      : ((await prisma.optimizationProfile.findUnique({
          where: { key: input.profileKey as never },
          select: { name: true },
        }))?.name ?? input.profileKey);

  // Devices that carried this profile through the whole window.
  const devices = input.deviceId
    ? [input.deviceId]
    : (
        await prisma.device.findMany({
          where: input.profileKey
            ? { optimizationProfile: { key: input.profileKey as never } }
            : { optimizationProfileId: null },
          select: { id: true },
          take: 500,
        })
      ).map((row) => row.id);

  if (devices.length === 0) {
    return {
      profileKey: label,
      profileName: name,
      measured: false,
      bytes: null,
      bytesGb: null,
      sessions: null,
      avgLatencyMs: null,
      estimatedCost: null,
      reason: `No device used ${label} in this window, so there is nothing to measure.`,
      source: null,
    };
  }

  const aggregates = await prisma.trafficAggregate.groupBy({
    by: ["dimKey"],
    where: {
      bucketStart: { gte: input.from, lt: input.to },
      dimKey: { startsWith: "device:", in: undefined },
    },
    _sum: { bytes: true },
  });
  const dimIds = new Set(devices.map((id) => `device:${id}`));
  let bytes = 0n;
  for (const row of aggregates) {
    if (dimIds.has(row.dimKey)) bytes += row._sum.bytes ?? 0n;
  }

  const sessions = await prisma.vpnSession.groupBy({
    by: ["deviceId"],
    where: { deviceId: { in: devices }, startedAt: { gte: input.from, lt: input.to } },
    _count: { _all: true },
    _avg: { latencyMs: true },
  });
  const sessionCount = sessions.reduce((sum, row) => sum + row._count._all, 0);
  const latencies = sessions.map((row) => row._avg.latencyMs).filter((value): value is number => value !== null);
  const avgLatency =
    latencies.length > 0 ? latencies.reduce((sum, value) => sum + value, 0) / latencies.length : null;

  if (bytes === 0n && sessionCount === 0) {
    return {
      profileKey: label,
      profileName: name,
      measured: false,
      bytes: null,
      bytesGb: null,
      sessions: null,
      avgLatencyMs: null,
      estimatedCost: null,
      reason: `Devices used ${label}, but none of them moved traffic in this window.`,
      source: null,
    };
  }

  const gb = Number(bytes) / 1024 ** 3;
  return {
    profileKey: label,
    profileName: name,
    measured: true,
    bytes: bytes.toString(),
    bytesGb: Math.round(gb * 1000) / 1000,
    sessions: sessionCount,
    avgLatencyMs: avgLatency === null ? null : Math.round(avgLatency * 100) / 100,
    estimatedCost: (gb * input.pricePerGb).toFixed(2),
    reason: null,
    source: `TrafficAggregate(${devices.length} device(s) on ${label}) + VpnSession(${sessionCount} session(s))`,
  };
}

export async function compareOptimizationProfiles(input: {
  a: string;
  b: string;
  deviceId?: string | null;
  preset?: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<BenchmarkComparison> {
  const valid = ["BALANCED", "DATA_SAVER", "GAMING", "VIDEO_SAVER", "MAXIMUM_SAVING", "NONE"];
  const aKey = input.a.toUpperCase();
  const bKey = input.b.toUpperCase();
  if (!valid.includes(aKey) || !valid.includes(bKey)) {
    throw errors.validation("Both profiles must be known profile keys (or NONE).", { valid });
  }

  const range = resolveRange({ preset: input.preset ?? "7d", from: input.from, to: input.to });
  if (!range) throw errors.validation("The requested time range is invalid.");

  const pricing = await (async () => {
    const { getActivePricing } = await import("@/server/billing/service");
    return getActivePricing();
  })();

  const [a, b] = await Promise.all([
    profileWindow({
      profileKey: aKey === "NONE" ? null : aKey,
      deviceId: input.deviceId ?? null,
      from: range.start,
      to: range.end,
      currency: pricing.currency,
      pricePerGb: Number(pricing.pricePerGb),
    }),
    profileWindow({
      profileKey: bKey === "NONE" ? null : bKey,
      deviceId: input.deviceId ?? null,
      from: range.start,
      to: range.end,
      currency: pricing.currency,
      pricePerGb: Number(pricing.pricePerGb),
    }),
  ]);

  const measurable = a.measured && b.measured && Number(a.bytes ?? 0n) > 0 && Number(b.bytes ?? 0n) > 0;
  const dataPct =
    measurable && a.bytesGb !== null && b.bytesGb !== null && a.bytesGb > 0
      ? Math.round(((b.bytesGb - a.bytesGb) / a.bytesGb) * 1000) / 10
      : null;
  const latencyMs =
    measurable && a.avgLatencyMs !== null && b.avgLatencyMs !== null
      ? Math.round((b.avgLatencyMs - a.avgLatencyMs) * 100) / 100
      : null;
  const costA = measurable && a.estimatedCost !== null ? Number(a.estimatedCost) : null;
  const costB = measurable && b.estimatedCost !== null ? Number(b.estimatedCost) : null;
  const costPct = costA !== null && costB !== null && costA > 0 ? Math.round(((costB - costA) / costA) * 1000) / 10 : null;

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString(), preset: input.preset ?? "7d" },
    a,
    b,
    delta: {
      available: measurable,
      dataPct,
      latencyMs,
      costPct,
      direction:
        !measurable || dataPct === null ? null : dataPct < 0 ? `${bKey} carried less data` : dataPct > 0 ? `${bKey} carried more data` : "equal data",
    },
    notice: NOTICE,
  };
}
