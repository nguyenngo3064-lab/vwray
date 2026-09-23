import "server-only";
import { prisma } from "@/server/db/client";
import { getSetting } from "@/server/settings/service";
import { resolveRange } from "@/server/lib/time";
import { applySavingFormula } from "@/lib/format/units";

export type GroupBy = "device" | "user" | "node" | "category" | "profile";
export type SavingsKind = "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";

export interface AnalyticsRow {
  bucketStart: Date;
  kind: string;
  originalBytes: bigint;
  optimizedBytes: bigint;
  savedBytes: bigint;
  deviceId: string | null;
  nodeId: string | null;
  userId: string | null;
  category: string | null;
  profileId: string | null;
  profile: { key: string; name: string } | null;
  device: { displayName: string } | null;
}

function totalsOf(rows: AnalyticsRow[]) {
  const original = rows.reduce((sum, row) => sum + row.originalBytes, 0n);
  const optimized = rows.reduce((sum, row) => sum + row.optimizedBytes, 0n);
  return { original, optimized, saved: original - optimized };
}

function groupKeyOf(row: AnalyticsRow, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "device":
      return { key: row.deviceId ?? "unknown", label: row.device?.displayName ?? row.deviceId ?? "Unknown device" };
    case "node":
      return { key: row.nodeId ?? "unknown", label: row.nodeId ?? "Unknown node" };
    case "user":
      return { key: row.userId ?? "unknown", label: row.userId ?? "Unknown user" };
    case "category":
      return { key: row.category ?? "uncategorised", label: row.category ?? "Uncategorised" };
    case "profile":
      return { key: row.profile?.key ?? "none", label: row.profile?.name ?? "No profile" };
  }
}

export async function optimizationAnalytics(input: {
  preset?: string;
  from?: string | null;
  to?: string | null;
  groupBy: GroupBy;
  source: "REAL" | "MOCK" | "ALL";
}) {
  const range = resolveRange({ preset: input.preset ?? "30d", from: input.from, to: input.to });
  const [minSampleRaw, targetMin, targetMax] = await Promise.all([
    getSetting<string>("optimization.minSampleBytesForActualSavings"),
    getSetting<number>("optimization.targetSavingMinPct"),
    getSetting<number>("optimization.targetSavingMaxPct"),
  ]);
  const minSample = BigInt(Number(minSampleRaw) || 0);
  const sourceFilter = input.source === "ALL" ? {} : { source: input.source as "REAL" | "MOCK" };

  const rows: AnalyticsRow[] = range
    ? await prisma.optimizationRecord.findMany({
        where: { bucketStart: { gte: range.start, lt: range.end }, ...sourceFilter },
        select: {
          bucketStart: true,
          kind: true,
          originalBytes: true,
          optimizedBytes: true,
          savedBytes: true,
          deviceId: true,
          nodeId: true,
          userId: true,
          category: true,
          profileId: true,
          profile: { select: { key: true, name: true } },
          device: { select: { displayName: true } },
        },
        orderBy: { bucketStart: "asc" },
        take: 20_000,
      })
    : [];

  const measured = rows.filter((row) => row.kind === "MEASURED");
  const chosen = measured.length > 0 ? measured : rows;
  const totals = totalsOf(chosen);
  const dataSufficient = chosen.length > 0 && totals.original >= minSample;
  const kind: SavingsKind =
    chosen.length === 0 || !dataSufficient ? "INSUFFICIENT_DATA" : chosen === measured ? "MEASURED" : "ESTIMATED";
  const formula = totals.original > 0n ? applySavingFormula(totals.original, totals.optimized) : null;

  const byBucket = new Map<number, { original: bigint; optimized: bigint }>();
  for (const row of chosen) {
    const key = row.bucketStart.getTime();
    const entry = byBucket.get(key) ?? { original: 0n, optimized: 0n };
    entry.original += row.originalBytes;
    entry.optimized += row.optimizedBytes;
    byBucket.set(key, entry);
  }
  const series = [...byBucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, entry]) => ({
      t,
      originalBytes: entry.original.toString(),
      optimizedBytes: entry.optimized.toString(),
      savedBytes: (entry.original - entry.optimized).toString(),
    }));

  const groups = new Map<string, { label: string; original: bigint; optimized: bigint; kind: string }>();
  for (const row of chosen) {
    const key = groupKeyOf(row, input.groupBy);
    const entry = groups.get(key.key) ?? { label: key.label, original: 0n, optimized: 0n, kind: row.kind };
    entry.original += row.originalBytes;
    entry.optimized += row.optimizedBytes;
    groups.set(key.key, entry);
  }
  const breakdown = [...groups.entries()].map(([key, entry]) => {
    const result = entry.original > 0n ? applySavingFormula(entry.original, entry.optimized) : null;
    return {
      key,
      label: entry.label,
      originalBytes: entry.original.toString(),
      optimizedBytes: entry.optimized.toString(),
      savedBytes: (entry.original - entry.optimized).toString(),
      savingPct: result?.actualSavingPercent ?? null,
      kind: entry.kind,
    };
  });

  const byCategory = new Map<string, { original: bigint; optimized: bigint }>();
  for (const row of chosen) {
    const key = row.category ?? "uncategorised";
    const entry = byCategory.get(key) ?? { original: 0n, optimized: 0n };
    entry.original += row.originalBytes;
    entry.optimized += row.optimizedBytes;
    byCategory.set(key, entry);
  }
  const efficiency = [...byCategory.entries()].map(([category, entry]) => {
    const result = entry.original > 0n ? applySavingFormula(entry.original, entry.optimized) : null;
    const pct = result?.actualSavingPercent ?? null;
    const band = pct === null ? "UNKNOWN" : pct >= 30 ? "HIGH" : pct >= 15 ? "MODERATE" : pct > 0 ? "LOW" : "NONE";
    return {
      category,
      originalBytes: entry.original.toString(),
      savedBytes: (entry.original - entry.optimized).toString(),
      savingPct: pct,
      band,
      note:
        pct === null
          ? "No measurable original volume for this category."
          : `Actual measured saving for ${category}; encrypted or already-compressed traffic typically lands in LOW or NONE.`,
    };
  });

  return {
    range: range
      ? { start: range.start.toISOString(), end: range.end.toISOString(), preset: input.preset ?? "30d" }
      : null,
    groupBy: input.groupBy,
    summary: {
      originalBytes: totals.original.toString(),
      optimizedBytes: totals.optimized.toString(),
      savedBytes: totals.saved.toString(),
      actualSavingPct: kind === "INSUFFICIENT_DATA" ? null : (formula?.actualSavingPercent ?? null),
      kind,
      dataSufficient,
      minimumSampleBytes: minSample.toString(),
      target: { min: targetMin, max: targetMax },
      disclaimer:
        "30-60% is an optimization TARGET RANGE, not a guaranteed outcome. Actual savings depend on traffic type: text compresses well, encrypted or already-compressed traffic often saves little.",
    },
    series,
    breakdown,
    efficiency,
  };
}
