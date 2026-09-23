import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { queryTraffic } from "@/server/analytics/traffic";
import { queryConsumers } from "@/server/analytics/consumers";
import { parseConsumerFilters } from "@/server/analytics/filters";
import { getBillingOverview } from "@/server/billing/service";
import { listQuotas } from "@/server/quota/engine";
import { aggregator } from "@/server/realtime/aggregator";
import { getSystemStatus } from "@/server/system/status";
import { getSetting } from "@/server/settings/service";
import { resolveRange } from "@/server/lib/time";
import { applySavingFormula } from "@/lib/format/units";
import { prisma } from "@/server/db/client";

/**
 * DATA CENTER payload.
 *
 * Six sections in one response - realtime, history, consumers, quota, optimization and
 * cost - because the Data Center is a single analytical view. Six independently-timed
 * reads would let the cost block disagree with the traffic block on the same screen.
 *
 * Each block comes from the routine that owns its arithmetic: `queryTraffic` for
 * volume, `listQuotas` for enforcement state, `getBillingOverview` for money. The
 * route only assembles them.
 */

export const GET = withConsole(
  async (_request, ctx) => {
    const sourceParam = ctx.url.searchParams.get("source");
    const source: "REAL" | "MOCK" | "ALL" =
      sourceParam === "MOCK" || sourceParam === "ALL" ? sourceParam : "REAL";
    const preset = ctx.url.searchParams.get("preset") ?? "30d";
    const from = ctx.url.searchParams.get("from");
    const to = ctx.url.searchParams.get("to");

    const tick = aggregator.hello();
    const [system, history, consumers, quotas, billing, todayTraffic, daily, monthly] =
      await Promise.all([
        getSystemStatus(),
        queryTraffic({ preset, from, to, source }),
        queryConsumers(parseConsumerFilters(ctx.url)),
        listQuotas(),
        getBillingOverview({ source }),
        queryTraffic({ preset: "today", source }),
        queryTraffic({ preset: "30d", source }),
        queryTraffic({ preset: "month", source }),
      ]);

    const range = resolveRange({ preset, from, to });
    const [optimization, targetMin, targetMax, thresholds, enforcement, graceBytes] =
      await Promise.all([
        range ? measureOptimization(range) : insufficientOptimization(),
        getSetting<number>("optimization.targetSavingMinPct"),
        getSetting<number>("optimization.targetSavingMaxPct"),
        getSetting<number[]>("quota.warnThresholds"),
        getSetting<boolean>("quota.enforcementEnabled"),
        getSetting<string>("quota.graceBytes"),
      ]);

    return jsonOk(
      {
        realtime: {
          status: system.realtime.status,
          uploadBps: tick.uploadBps,
          downloadBps: tick.downloadBps,
          totalBps: tick.totalBps,
          activeConnections: tick.activeConnections,
          nodes: tick.nodes,
          clients: system.realtime.clients,
          lastTickAt: system.realtime.lastTickAt,
        },
        history: {
          daily: daily.series,
          weekly: daily.series,
          monthly: monthly.series,
        },
        consumers,
        quota: {
          items: quotas,
          thresholds,
          enforcementEnabled: enforcement,
          graceBytes: String(graceBytes),
        },
        optimization: { ...optimization, target: { min: targetMin, max: targetMax } },
        cost: {
          currency: billing.pricing.currency,
          periodStart: billing.period.start,
          periodEnd: billing.period.end,
          rawBytes: billing.totals.rawBytes.toString(),
          optimizedBytes: billing.totals.optimizedBytes.toString(),
          savedBytes: billing.totals.savedBytes.toString(),
          billableGb: billing.totals.billableGb,
          computedCost: billing.totals.computedCost,
          costWithoutOptimization: billing.totals.costWithoutOptimization,
          savedCost: billing.totals.savedCost,
          projection: billing.projection,
          simulationNotice: billing.simulationNotice,
        },
        today: { totalBytes: todayTraffic.summary.totalBytes, series: todayTraffic.series },
        mockDataPresent: system.gateway.mockOnly,
        generatedAt: Date.now(),
      },
      { requestId: ctx.requestId },
    );
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);

interface OptimizationTotals {
  originalBytes: string;
  optimizedBytes: string;
  savedBytes: string;
  actualSavingPct: number | null;
  kind: "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";
}

async function insufficientOptimization(): Promise<OptimizationTotals> {
  return {
    originalBytes: "0",
    optimizedBytes: "0",
    savedBytes: "0",
    actualSavingPct: null,
    kind: "INSUFFICIENT_DATA",
  };
}

/**
 * Optimization totals for a window, taken from the stored `OptimizationRecord` rows.
 *
 * MEASURED rows win over ESTIMATED ones because only a measured original/optimized
 * pair justifies a percentage. With no stored record at all the result is
 * INSUFFICIENT_DATA, never a guessed 0% or a target range presented as an outcome.
 */
async function measureOptimization(range: { start: Date; end: Date }): Promise<OptimizationTotals> {
  const rows = await prisma.optimizationRecord.groupBy({
    by: ["kind"],
    where: { bucketStart: { gte: range.start, lt: range.end } },
    _sum: { originalBytes: true, optimizedBytes: true, savedBytes: true },
  });

  const chosen = rows.find((row) => row.kind === "MEASURED") ?? rows[0];
  if (!chosen) return insufficientOptimization();

  const original = chosen._sum.originalBytes ?? 0n;
  const optimized = chosen._sum.optimizedBytes ?? 0n;
  if (original === 0n) return insufficientOptimization();

  const formula = applySavingFormula(original, optimized);
  return {
    originalBytes: original.toString(),
    optimizedBytes: optimized.toString(),
    savedBytes: formula.savedBytes.toString(),
    actualSavingPct: formula.actualSavingPercent,
    kind: chosen.kind === "MEASURED" ? "MEASURED" : "ESTIMATED",
  };
}
