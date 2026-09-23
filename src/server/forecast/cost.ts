import "server-only";
import { getActivePricing, currentPeriod, computeCost, measurePeriod, getBillingOverview } from "@/server/billing/service";

/**
 * Cost forecast (SIMULATED billing only).
 *
 * Wraps the billing service's measured totals and projection with an explicit
 * availability gate, so the console can say "Projection unavailable" instead of
 * extrapolating from a few hours. Every figure carries `calculation` and `source` so an
 * operator can see exactly which aggregates and which price produced it.
 *
 * "Cost today" is deliberately the MARGINAL data cost of today's bytes (the delta
 * between costing today's bytes and costing none), because the period base fee is a
 * period charge and charging it again for "today" would be wrong.
 */

export interface CostForecast {
  available: boolean;
  reason: string | null;
  currency: string;
  pricePerGb: number;
  baseFee: number;
  freeQuotaGb: number;
  period: { start: string; end: string; elapsedDays: number; periodDays: number };
  /** Cost of the period so far (base fee + data), from measured aggregates. */
  currentPeriodCost: string | null;
  /** Marginal data cost of today's traffic, excluding the period base fee. */
  costToday: string | null;
  projectedCost: string | null;
  projectedReason: string | null;
  dataUsedGb: number | null;
  calculation: string | null;
  /** Per-dimension slices for "cost by device / user / node". */
  byDevice: Array<{ id: string; label: string; cost: string; gb: number }>;
  byUser: Array<{ id: string; label: string; cost: string; gb: number }>;
  byNode: Array<{ id: string; label: string; cost: string; gb: number }>;
  notice: string;
}

const NOTICE =
  "Simulated cost. No payment processor is connected and no charge is made. Projections are estimates from recorded traffic.";

export async function costForecast(): Promise<CostForecast> {
  const pricing = await getActivePricing();
  const overview = await getBillingOverview();
  const now = new Date();
  const period = currentPeriod(pricing, now);

  const mapRows = (rows: Array<{ key: string; label: string; computedCost: number; rawGb: number }>) =>
    rows.map((row) => ({ id: row.key, label: row.label, cost: row.computedCost.toFixed(2), gb: row.rawGb }));

  // Today's marginal data cost: cost(today bytes) - cost(0 bytes).
  const todayStart = new Date(now);
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayMeasured = await measurePeriod({ range: { start: todayStart, end: now }, dimKey: "system", source: "REAL" });
  const withToday = computeCost({ rawBytes: todayMeasured.rawBytes, optimizedBytes: todayMeasured.optimizedBytes, pricing });
  const withoutToday = computeCost({ rawBytes: 0n, optimizedBytes: 0n, pricing });
  const costToday = Math.max(0, withToday.computedCost - withoutToday.computedCost);

  const elapsedDays = overview.period.elapsedDays;
  const periodDays = Math.max(
    1,
    Math.round((new Date(overview.period.end).getTime() - new Date(overview.period.start).getTime()) / 86_400_000),
  );

  const projectionAvailable = overview.projection.available && overview.dataAvailable;

  return {
    available: overview.dataAvailable,
    reason: overview.dataAvailable
      ? null
      : "No measured traffic in the current period, so nothing has been costed yet.",
    currency: pricing.currency,
    pricePerGb: Number(pricing.pricePerGb),
    baseFee: Number(pricing.baseFee),
    freeQuotaGb: Number(pricing.freeQuotaGb),
    period: {
      start: overview.period.start,
      end: overview.period.end,
      elapsedDays: Math.round(elapsedDays * 100) / 100,
      periodDays,
    },
    currentPeriodCost: overview.dataAvailable ? overview.totals.computedCost.toFixed(2) : null,
    costToday: todayMeasured.rawBytes > 0n ? costToday.toFixed(2) : overview.dataAvailable ? costToday.toFixed(2) : null,
    projectedCost: projectionAvailable && overview.projection.projectedCost !== null
      ? overview.projection.projectedCost.toFixed(2)
      : null,
    projectedReason: projectionAvailable ? null : (overview.projection.reason ?? "Projection unavailable."),
    dataUsedGb: overview.dataAvailable ? overview.totals.rawGb : null,
    calculation: overview.dataAvailable
      ? `${overview.totals.rawGb.toFixed(3)} GB × ${pricing.pricePerGb} ${pricing.currency}/GB + ${pricing.baseFee} ${pricing.currency} base − ${pricing.freeQuotaGb} GB free = ${overview.totals.computedCost.toFixed(2)} ${pricing.currency}`
      : null,
    byDevice: mapRows(overview.scopes.device),
    byUser: mapRows(overview.scopes.user),
    byNode: mapRows(overview.scopes.node),
    notice: NOTICE,
  };
}
