import "server-only";
import { prisma } from "@/server/db/client";
import { quotaPercent } from "@/lib/format/units";

/**
 * Quota forecast.
 *
 * A rate extrapolation over traffic recorded in the CURRENT period: bytes so far over
 * hours elapsed, applied to what is left. No seasonal model, no smoothing: with this
 * little data a clever model would be a confident lie.
 *
 * It answers four questions honestly:
 *   * Is there enough history? If not: `available:false` with the stated reason.
 *   * How confident is the number? From observed hours and data points, shown alongside.
 *   * What when nothing flows? Zero rate means ETA unknown, not infinite.
 *   * Where from? `calculation` and `source` name the aggregates and the quota row.
 */

export type ForecastConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface QuotaForecast {
  available: boolean;
  reason: string | null;
  quotaId: string | null;
  scope: string;
  label: string;
  period: string;
  usedBytes: string;
  limitBytes: string;
  remainingBytes: string;
  percent: number | null;
  rateBytesPerHour: number | null;
  etaSeconds: number | null;
  etaLabel: string | null;
  confidence: ForecastConfidence | null;
  historyHours: number;
  dataPoints: number;
  calculation: string | null;
  source: string | null;
  notice: string;
}

const NOTICE = "Estimate from recorded traffic. Actual consumption varies.";

function unavailable(input: {
  reason: string;
  quotaId?: string | null;
  scope?: string;
  label?: string;
  period?: string;
  usedBytes?: bigint;
  limitBytes?: bigint;
  percent?: number | null;
  historyHours?: number;
  dataPoints?: number;
}): QuotaForecast {
  const used = input.usedBytes ?? 0n;
  const limit = input.limitBytes ?? 0n;
  const remaining = limit > 0n ? (limit > used ? limit - used : 0n) : 0n;
  return {
    available: false,
    reason: input.reason,
    quotaId: input.quotaId ?? null,
    scope: input.scope ?? "SYSTEM",
    label: input.label ?? "Quota",
    period: input.period ?? "UNKNOWN",
    usedBytes: used.toString(),
    limitBytes: limit.toString(),
    remainingBytes: remaining.toString(),
    percent: input.percent ?? null,
    rateBytesPerHour: null,
    etaSeconds: null,
    etaLabel: null,
    confidence: null,
    historyHours: input.historyHours ?? 0,
    dataPoints: input.dataPoints ?? 0,
    calculation: null,
    source: null,
    notice: NOTICE,
  };
}

function formatEta(seconds: number): string {
  if (seconds < 60) return "<1m";
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes < 60) return `~${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  if (hours < 48) {
    const minutes = totalMinutes - hours * 60;
    return minutes > 0 ? `~${hours}h${minutes}m` : `~${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `~${days}d${hours - days * 24}h`;
}

function dimKeyFor(scope: string, scopeRefId: string | null): string {
  if (scope === "SYSTEM") return "system";
  return `${scope.toLowerCase()}:${scopeRefId ?? "unknown"}`;
}

export async function forecastQuota(input: {
  quotaId?: string | null;
  deviceId?: string | null;
  scope?: string | null;
  scopeRefId?: string | null;
}): Promise<QuotaForecast> {
  const where = input.quotaId
    ? { id: input.quotaId }
    : input.deviceId
      ? { scope: "DEVICE" as const, scopeRefId: input.deviceId }
      : input.scope
        ? { scope: input.scope as never, scopeRefId: input.scopeRefId ?? null }
        : { scope: "SYSTEM" as const, scopeRefId: null };

  const quota = await prisma.quota.findFirst({ where });
  if (!quota) {
    return unavailable({
      reason: input.deviceId ? "No quota is configured for this device." : "No matching quota is configured.",
      scope: input.scope ?? (input.deviceId ? "DEVICE" : "SYSTEM"),
      label: "Quota",
    });
  }

  const percent = quotaPercent(quota.usedBytes, quota.limitBytes);
  const base = {
    quotaId: quota.id,
    scope: quota.scope,
    label: quota.label,
    period: quota.period,
    usedBytes: quota.usedBytes,
    limitBytes: quota.limitBytes,
    percent,
  };

  if (!quota.enabled) return unavailable({ ...base, reason: "This quota is disabled, so there is nothing to forecast." });
  if (quota.limitBytes <= 0n) return unavailable({ ...base, reason: "The quota limit is zero, so remaining time is undefined." });
  if (quota.usedBytes >= quota.limitBytes) {
    return unavailable({ ...base, reason: "The quota is already exhausted - there is no remaining time to forecast." });
  }

  const periodStart = quota.periodStart ?? quota.createdAt;
  const now = new Date();
  const elapsedHours = (now.getTime() - periodStart.getTime()) / 3_600_000;

  if (elapsedHours < 2) {
    return unavailable({
      ...base,
      reason: `Only ${elapsedHours.toFixed(1)} hour(s) of period history. At least 2 hours are required before a rate can be estimated.`,
      historyHours: Math.max(0, elapsedHours),
    });
  }

  const dimKey = dimKeyFor(quota.scope, quota.scopeRefId);
  const aggregate = await prisma.trafficAggregate.aggregate({
    where: { dimKey, bucketStart: { gte: periodStart, lt: now } },
    _sum: { bytes: true },
    _count: { _all: true },
  });

  const totalBytes = aggregate._sum.bytes ?? 0n;
  const dataPoints = aggregate._count._all;

  if (dataPoints < 2) {
    return unavailable({
      ...base,
      reason: `Only ${dataPoints} traffic bucket(s) recorded since the period began, so no rate can be derived.`,
      historyHours: elapsedHours,
      dataPoints,
    });
  }

  const rate = Number(totalBytes) / elapsedHours;
  const remaining = quota.limitBytes - quota.usedBytes;

  if (rate <= 0) {
    return unavailable({
      ...base,
      reason: "No traffic has been recorded in this period, so there is no rate to extrapolate.",
      historyHours: elapsedHours,
      dataPoints,
    });
  }

  const etaSeconds = Math.round(Number(remaining) / rate);
  const confidence: ForecastConfidence =
    elapsedHours >= 24 && dataPoints >= 24 ? "HIGH" : elapsedHours >= 6 && dataPoints >= 6 ? "MEDIUM" : "LOW";

  const eta = formatEta(etaSeconds);
  return {
    available: true,
    reason: null,
    ...base,
    usedBytes: quota.usedBytes.toString(),
    limitBytes: quota.limitBytes.toString(),
    remainingBytes: remaining.toString(),
    rateBytesPerHour: Math.round(rate),
    etaSeconds,
    etaLabel: eta,
    confidence,
    historyHours: Math.round(elapsedHours * 10) / 10,
    dataPoints,
    calculation: `${(Number(remaining) / 1024 ** 3).toFixed(2)} GB remaining / ${(rate / 1024 ** 3).toFixed(3)} GB per hour observed over ${elapsedHours.toFixed(1)}h = ${eta.replace("~", "")}`,
    source: `TrafficAggregate(dimKey=${dimKey}, ${periodStart.toISOString()} to ${now.toISOString()}, ${dataPoints} bucket(s)) and Quota ${quota.id}`,
    notice: NOTICE,
  };
}
