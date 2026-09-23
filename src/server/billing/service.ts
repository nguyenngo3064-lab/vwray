import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { canonicalJson, sha256Hex } from "@/server/lib/crypto";
import { record } from "@/server/audit";
import { getEnv } from "@/server/config/env";
import { billingPeriod, elapsedDays, rangeDays, type DateRange } from "@/server/lib/time";
import { BYTES_PER_GB } from "@/lib/format/units";

/**
 * SIMULATED billing.
 *
 * There is no payment processor here and none is implied. This module converts
 * measured bytes into a simulated cost using the pricing an operator configured, and
 * it is the ONLY place that arithmetic happens, so a receipt, the dashboard and the
 * CSV export can never disagree.
 *
 * Formula (exactly the brief's, applied to stored aggregates):
 *
 *   actual_gb   = bytes / 1024^3
 *   billable_gb = max(0, actual_gb - free_quota_gb)
 *   cost        = base_fee + billable_gb * price_per_gb
 *
 * "actual bytes" is the volume that was really carried, i.e. the OPTIMIZED total when
 * the data plane reports one, because that is what the link actually transferred. The
 * same figures are recomputed against the pre-optimization volume to produce the
 * "without optimization" comparison; the difference is the simulated saving.
 *
 * Everything is Decimal, never float: a rounding artefact in a money column compounds
 * silently across every downstream projection.
 */

const GB = new Prisma.Decimal(BYTES_PER_GB.toString());
const DECIMAL_PLACES = 4;

export interface PricingShape {
  currency: string;
  baseFee: Prisma.Decimal;
  pricePerGb: Prisma.Decimal;
  freeQuotaGb: Prisma.Decimal;
  billingPeriod: "MONTHLY" | "WEEKLY" | "CUSTOM";
  periodStartDay: number;
  providerLabel: string;
  configId: string | null;
  simulationEnabled: boolean;
}

export interface CostBreakdown {
  rawBytes: bigint;
  optimizedBytes: bigint;
  savedBytes: bigint;
  savingPct: number | null;
  rawGb: number;
  billableGb: number;
  billableGbWithoutOptimization: number;
  freeQuotaGb: number;
  baseFee: number;
  pricePerGb: number;
  currency: string;
  /** Simulated cost of the bytes actually carried. */
  computedCost: number;
  /** Simulated cost if nothing had been optimized. */
  costWithoutOptimization: number;
  /** costWithoutOptimization - computedCost, floored at zero. */
  savedCost: number;
  formula: string;
}

/**
 * Reads the active pricing row, falling back to the environment template.
 *
 * The fallback matters on a fresh install: `.env` already carries `PRICE_PER_GB` and
 * `BASE_FEE`, and refusing to price anything until a row is saved would leave the
 * console showing nothing for no good reason. A saved row always wins.
 */
export async function getActivePricing(): Promise<PricingShape> {
  const env = getEnv();
  const row = await prisma.billingConfig.findFirst({
    where: { active: true },
    orderBy: { updatedAt: "desc" },
  });

  if (row) {
    return {
      currency: row.currency,
      baseFee: new Prisma.Decimal(row.baseFee),
      pricePerGb: new Prisma.Decimal(row.pricePerGb),
      freeQuotaGb: new Prisma.Decimal(row.freeQuotaGb),
      billingPeriod: row.billingPeriod,
      periodStartDay: row.periodStartDay,
      providerLabel: row.providerLabel,
      configId: row.id,
      simulationEnabled: true,
    };
  }

  return {
    currency: env.BILLING_CURRENCY,
    baseFee: new Prisma.Decimal(env.BASE_FEE),
    pricePerGb: new Prisma.Decimal(env.PRICE_PER_GB),
    freeQuotaGb: new Prisma.Decimal(env.FREE_QUOTA_GB),
    billingPeriod: env.BILLING_PERIOD,
    periodStartDay: env.BILLING_PERIOD_START_DAY,
    providerLabel: "VWRAY",
    configId: null,
    simulationEnabled: false,
  };
}

/** The current period window derived from the pricing configuration. */
export function currentPeriod(pricing: PricingShape, now: Date = new Date()) {
  return billingPeriod({
    period: pricing.billingPeriod,
    periodStartDay: pricing.periodStartDay,
    now,
  });
}

function toGb(bytes: bigint): Prisma.Decimal {
  return new Prisma.Decimal(bytes.toString()).div(GB);
}

function round(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(DECIMAL_PLACES, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * The arithmetic, in one pure function.
 *
 * Exported so a unit test can prove the brief's worked example without a database:
 * 100 GB at 25,000 VND/GB with a 15,000 VND base fee is 15,000 + 100 x 25,000.
 */
export function computeCost(input: {
  rawBytes: bigint;
  optimizedBytes: bigint | null;
  pricing: Pick<PricingShape, "baseFee" | "pricePerGb" | "freeQuotaGb" | "currency">;
}): CostBreakdown {
  const optimized = input.optimizedBytes ?? input.rawBytes;
  const rawBytes = input.rawBytes;
  const savedBytes = rawBytes > optimized ? rawBytes - optimized : 0n;

  const rawGb = toGb(rawBytes);
  const optimizedGb = toGb(optimized);
  const freeQuota = new Prisma.Decimal(input.pricing.freeQuotaGb);

  const billable = Prisma.Decimal.max(new Prisma.Decimal(0), optimizedGb.minus(freeQuota));
  const billableWithout = Prisma.Decimal.max(new Prisma.Decimal(0), rawGb.minus(freeQuota));

  const baseFee = new Prisma.Decimal(input.pricing.baseFee);
  const pricePerGb = new Prisma.Decimal(input.pricing.pricePerGb);

  const computedCost = round(baseFee.plus(billable.mul(pricePerGb)));
  const costWithoutOptimization = round(baseFee.plus(billableWithout.mul(pricePerGb)));
  const savedCost = round(costWithoutOptimization.minus(computedCost));

  const savingPct =
    rawBytes > 0n ? Math.round((Number(savedBytes) / Number(rawBytes)) * 1000) / 10 : null;

  return {
    rawBytes,
    optimizedBytes: optimized,
    savedBytes,
    savingPct,
    rawGb: rawGb.toDecimalPlaces(3).toNumber(),
    billableGb: billable.toDecimalPlaces(6).toNumber(),
    billableGbWithoutOptimization: billableWithout.toDecimalPlaces(6).toNumber(),
    freeQuotaGb: freeQuota.toNumber(),
    baseFee: baseFee.toNumber(),
    pricePerGb: pricePerGb.toNumber(),
    currency: input.pricing.currency,
    computedCost: computedCost.toNumber(),
    costWithoutOptimization: costWithoutOptimization.toNumber(),
    savedCost: Math.max(0, savedCost.toNumber()),
    formula:
      `${input.pricing.currency} ${baseFee.toFixed(2)} base fee + ` +
      `max(0, ${optimizedGb.toDecimalPlaces(6).toFixed(6)} GB − ${freeQuota.toFixed(6)} GB free quota) × ` +
      `${pricePerGb.toFixed(4)} per GB = ${computedCost.toFixed(2)}`,
  };
}

/**
 * Sums stored traffic for a period and scope.
 *
 * Reads `TrafficAggregate` hub rows only, and picks exactly one `dimKey` per scope so
 * the totals cannot double-count across dimensions.
 */
export async function measurePeriod(input: {
  range: { start: Date; end: Date };
  dimKey: string;
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Promise<{ rawBytes: bigint; optimizedBytes: bigint | null }> {
  const rows = await prisma.trafficAggregate.groupBy({
    by: ["direction"],
    where: {
      dimKey: input.dimKey,
      bucketStart: { gte: input.range.start, lt: input.range.end },
      ...(input.source && input.source !== "ALL" ? { source: input.source } : {}),
    },
    _sum: { bytes: true, bytesOptimized: true },
    _count: { bytesOptimized: true },
  });

  let rawBytes = 0n;
  let optimizedBytes = 0n;
  let sawMeasured = false;

  for (const row of rows) {
    rawBytes += row._sum.bytes ?? 0n;
    if (row._sum.bytesOptimized !== null && row._count.bytesOptimized > 0) {
      optimizedBytes += row._sum.bytesOptimized;
      sawMeasured = true;
    }
  }

  return { rawBytes, optimizedBytes: sawMeasured ? optimizedBytes : null };
}

/** Deterministic hash of the inputs a cost was derived from, for receipt provenance. */
export function costInputHash(input: Record<string, unknown>): string {
  return sha256Hex(canonicalJson(input));
}

export interface CostScopeTotal extends CostBreakdown {
  key: string;
  label: string;
  sublabel: string | null;
}

export interface BillingOverview {
  simulationEnabled: boolean;
  simulationNotice: string;
  pricing: {
    currency: string;
    baseFee: number;
    pricePerGb: number;
    freeQuotaGb: number;
    billingPeriod: string;
    periodStartDay: number;
    providerLabel: string;
    configId: string | null;
    persisted: boolean;
  };
  period: { start: string; end: string; elapsedDays: number; totalDays: number };
  totals: CostBreakdown;
  scopes: {
    device: CostScopeTotal[];
    user: CostScopeTotal[];
    node: CostScopeTotal[];
    category: CostScopeTotal[];
  };
  projection: {
    available: boolean;
    projectedCost: number | null;
    reason: string | null;
    minimumDays: number;
    elapsedDays: number;
  };
  storedCostRecords: Array<{
    id: string;
    scope: string;
    label: string;
    periodStart: string;
    periodEnd: string;
    rawBytes: string;
    optimizedBytes: string;
    savedBytes: string;
    billableGb: number;
    computedCost: number;
    costWithoutOptimization: number;
    savedCost: number;
    currency: string;
    inputHash: string;
    source: string;
    computedAt: string;
  }>;
  dataAvailable: boolean;
  source: "REAL" | "MOCK" | "ALL";
}

const SIMULATION_NOTICE =
  "Simulated cost. No payment processor is connected and no charge is made. Figures are derived from " +
  "measured traffic and the pricing configured in this console.";

/** Dimensions charged for, and the dimKey used to measure each one. */
const SCOPE_DIMENSIONS = [
  { key: "device", prefix: "device" },
  { key: "user", prefix: "user" },
  { key: "node", prefix: "node" },
  { key: "category", prefix: "category" },
] as const;

/**
 * Full billing view: totals for the current period, the same numbers per dimension,
 * the projection, and previously stored cost records.
 *
 * A projection is only offered once enough time has actually elapsed AND traffic was
 * recorded. Below that threshold `available` is false with a stated reason, because a
 * projected invoice extrapolated from a few hours is a fabricated number.
 */
export async function getBillingOverview(input?: {
  source?: "REAL" | "MOCK" | "ALL" | null;
  range?: DateRange | null;
}): Promise<BillingOverview> {
  const source = input?.source ?? "REAL";
  const pricing = await getActivePricing();
  const range = input?.range ?? currentPeriod(pricing);
  const minimumDays = await projectionMinimumDays();

  const totalsMeasure = await measurePeriod({ range, dimKey: "system", source });
  const totals = computeCost({ ...totalsMeasure, pricing });

  const scopes = await Promise.all(
    SCOPE_DIMENSIONS.map(async (dimension) => {
      const rows = await scopedTotals({ range, prefix: dimension.prefix, source, pricing });
      return [dimension.key, rows] as const;
    }),
  );

  const scopeMap = Object.fromEntries(scopes) as Record<string, CostScopeTotal[]>;
  const elapsed = elapsedDays(range);
  const total = rangeDays(range);
  const projection = project({
    periodsCost: totals.computedCost,
    elapsed,
    totalDays: total,
    minimumDays,
    hasTraffic: totals.rawBytes > 0n,
  });

  const stored = await prisma.costRecord.findMany({
    where: { ...(source !== "ALL" ? { source } : {}) },
    orderBy: { periodStart: "desc" },
    take: 50,
  });

  return {
    simulationEnabled: true,
    simulationNotice: SIMULATION_NOTICE,
    pricing: {
      currency: pricing.currency,
      baseFee: pricing.baseFee.toNumber(),
      pricePerGb: pricing.pricePerGb.toNumber(),
      freeQuotaGb: pricing.freeQuotaGb.toNumber(),
      billingPeriod: pricing.billingPeriod,
      periodStartDay: pricing.periodStartDay,
      providerLabel: pricing.providerLabel,
      configId: pricing.configId,
      persisted: pricing.configId !== null,
    },
    period: {
      start: range.start.toISOString(),
      end: range.end.toISOString(),
      elapsedDays: Math.round(elapsed * 100) / 100,
      totalDays: Math.round(total * 100) / 100,
    },
    totals,
    scopes: {
      device: scopeMap.device ?? [],
      user: scopeMap.user ?? [],
      node: scopeMap.node ?? [],
      category: scopeMap.category ?? [],
    },
    projection,
    storedCostRecords: stored.map((row) => ({
      id: row.id,
      scope: row.scope,
      label: row.label,
      periodStart: row.periodStart.toISOString(),
      periodEnd: row.periodEnd.toISOString(),
      rawBytes: row.rawBytes.toString(),
      optimizedBytes: row.optimizedBytes.toString(),
      savedBytes: row.savedBytes.toString(),
      billableGb: Number(row.billableGb),
      computedCost: Number(row.computedCost),
      costWithoutOptimization: Number(row.costWithoutOptimization),
      savedCost: Number(row.savedCost),
      currency: row.currency,
      inputHash: row.inputHash,
      source: row.source,
      computedAt: row.computedAt.toISOString(),
    })),
    dataAvailable: totals.rawBytes > 0n,
    source,
  };
}

async function projectionMinimumDays(): Promise<number> {
  try {
    const { getSetting } = await import("@/server/settings/service");
    return await getSetting<number>("billing.projectionMinimumDays");
  } catch {
    return getEnv().isTest ? 1 : 5;
  }
}

/**
 * Per-entity totals for one dimension, reusing the same measurement and the same
 * arithmetic as the system total. Reimplementing the formula per dimension is exactly
 * how a per-device figure ends up not adding up to the system figure.
 */
async function scopedTotals(input: {
  range: DateRange;
  prefix: "device" | "user" | "node" | "category";
  source: "REAL" | "MOCK" | "ALL";
  pricing: PricingShape;
}): Promise<CostScopeTotal[]> {
  const grouped = await prisma.trafficAggregate.groupBy({
    by: ["dimKey"],
    where: {
      dimKey: { startsWith: `${input.prefix}:` },
      bucketStart: { gte: input.range.start, lt: input.range.end },
      ...(input.source !== "ALL" ? { source: input.source } : {}),
    },
    _sum: { bytes: true, bytesOptimized: true },
  });

  const entries = grouped
    .map((row) => ({
      id: row.dimKey.slice(input.prefix.length + 1),
      rawBytes: row._sum.bytes ?? 0n,
      optimizedBytes: row._sum.bytesOptimized ?? null,
    }))
    .filter((row) => row.rawBytes > 0n)
    .sort((left, right) => (right.rawBytes > left.rawBytes ? 1 : -1))
    .slice(0, 50);

  const labels = await scopeLabels(input.prefix, entries.map((entry) => entry.id));

  return entries.map((entry) => ({
    ...computeCost({
      rawBytes: entry.rawBytes,
      optimizedBytes: entry.optimizedBytes,
      pricing: input.pricing,
    }),
    key: entry.id,
    label:
      input.prefix === "category"
        ? entry.id
        : (labels.get(entry.id) ?? `(removed) ${entry.id.slice(0, 8)}`),
    sublabel: input.prefix === "category" ? null : entry.id.slice(0, 12),
  }));
}

async function scopeLabels(prefix: string, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  if (prefix === "device") {
    const rows = await prisma.device.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
  if (prefix === "user") {
    const rows = await prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true },
    });
    return new Map(rows.map((row) => [row.id, row.username]));
  }
  const rows = await prisma.vpnNode.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Validates and persists the pricing an operator edits. Audited, never silent. */
export async function updateBillingConfig(input: {
  currency?: string;
  baseFee?: number;
  pricePerGb?: number;
  freeQuotaGb?: number;
  billingPeriod?: "MONTHLY" | "WEEKLY" | "CUSTOM";
  periodStartDay?: number;
  providerLabel?: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const current = await getActivePricing();

  const currency = (input.currency ?? current.currency).toUpperCase().slice(0, 8);
  const baseFee = nonNegative(input.baseFee ?? current.baseFee.toNumber(), "base fee");
  const pricePerGb = nonNegative(input.pricePerGb ?? current.pricePerGb.toNumber(), "price per GB");
  const freeQuotaGb = nonNegative(input.freeQuotaGb ?? current.freeQuotaGb.toNumber(), "free quota");
  const periodStartDay = Math.min(
    28,
    Math.max(1, Math.trunc(input.periodStartDay ?? current.periodStartDay)),
  );
  const providerLabel = (input.providerLabel ?? current.providerLabel).slice(0, 60);
  const billingPeriodValue = input.billingPeriod ?? current.billingPeriod;

  if (currency.length < 3) {
    throw errors.validation("The currency code must have at least three characters.");
  }

  const data = {
    currency,
    baseFee: new Prisma.Decimal(baseFee),
    pricePerGb: new Prisma.Decimal(pricePerGb),
    freeQuotaGb: new Prisma.Decimal(freeQuotaGb),
    billingPeriod: billingPeriodValue,
    periodStartDay,
    providerLabel,
    updatedById: input.actorId,
  };

  const row = current.configId
    ? await prisma.billingConfig.update({ where: { id: current.configId }, data })
    : await prisma.billingConfig.create({ data: { ...data, name: "default", active: true } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "billing.config_updated",
    resource: "billing_config",
    resourceId: row.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { currency, baseFee, pricePerGb, freeQuotaGb, billingPeriodValue, periodStartDay },
  });

  return {
    id: row.id,
    currency: row.currency,
    baseFee: Number(row.baseFee),
    pricePerGb: Number(row.pricePerGb),
    freeQuotaGb: Number(row.freeQuotaGb),
    billingPeriod: row.billingPeriod,
    periodStartDay: row.periodStartDay,
    providerLabel: row.providerLabel,
  };
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw errors.validation(`The ${label} must be a number greater than or equal to zero.`);
  }
  return Math.round(value * 10_000) / 10_000;
}

/**
 * project = current_cost / elapsed_days * days_in_period
 *
 * Refused unless traffic exists AND enough of the period has elapsed. The reason is
 * always returned so the UI can state why, rather than showing a dash with no
 * explanation.
 */
function project(input: {
  periodsCost: number;
  elapsed: number;
  totalDays: number;
  minimumDays: number;
  hasTraffic: boolean;
}): BillingOverview["projection"] {
  if (!input.hasTraffic) {
    return {
      available: false,
      projectedCost: null,
      reason:
        "No traffic was recorded in this period, so there is nothing to project. A projection is never invented.",
      minimumDays: input.minimumDays,
      elapsedDays: Math.round(input.elapsed * 100) / 100,
    };
  }
  if (input.elapsed < input.minimumDays) {
    return {
      available: false,
      projectedCost: null,
      reason:
        `Only ${input.elapsed.toFixed(2)} of ${input.minimumDays} required days have elapsed in this period, ` +
        "so a projection would be misleading.",
      minimumDays: input.minimumDays,
      elapsedDays: Math.round(input.elapsed * 100) / 100,
    };
  }
  if (input.totalDays <= 0) {
    return {
      available: false,
      projectedCost: null,
      reason: "The billing period has no defined length.",
      minimumDays: input.minimumDays,
      elapsedDays: Math.round(input.elapsed * 100) / 100,
    };
  }

  const projected = (input.periodsCost / input.elapsed) * input.totalDays;
  return {
    available: true,
    projectedCost: Math.round(projected * 100) / 100,
    reason: null,
    minimumDays: input.minimumDays,
    elapsedDays: Math.round(input.elapsed * 100) / 100,
  };
}

/**
 * Persists the computed cost for a scope and period.
 *
 * `inputHash` covers the exact inputs, so a receipt can prove which calculation it was
 * issued from and a later pricing change cannot silently rewrite history. The upsert is
 * keyed on the schema's unique tuple, so recomputing the same period refreshes the row
 * rather than duplicating it.
 */
export async function persistCostRecord(input: {
  scope: "SYSTEM" | "USER" | "DEVICE" | "NODE" | "CATEGORY";
  scopeRefId: string | null;
  label: string;
  range: DateRange;
  dimKey: string;
  source?: "REAL" | "MOCK" | "ALL" | null;
  actorId: string | null;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; breakdown: CostBreakdown }> {
  const pricing = await getActivePricing();
  const resolvedSource = input.source && input.source !== "ALL" ? input.source : "REAL";

  const measured = await measurePeriod({
    range: input.range,
    dimKey: input.dimKey,
    source: resolvedSource,
  });
  const breakdown = computeCost({ ...measured, pricing });

  if (input.scope !== "SYSTEM" && !input.scopeRefId) {
    throw errors.validation(`A ${input.scope} cost record needs a scope reference id.`);
  }
  const scopeRefId = input.scope === "SYSTEM" ? "system" : (input.scopeRefId as string);

  const inputHash = costInputHash({
    scope: input.scope,
    scopeRefId,
    periodStart: input.range.start.toISOString(),
    periodEnd: input.range.end.toISOString(),
    rawBytes: breakdown.rawBytes.toString(),
    optimizedBytes: breakdown.optimizedBytes.toString(),
    currency: breakdown.currency,
    baseFee: breakdown.baseFee,
    pricePerGb: breakdown.pricePerGb,
    freeQuotaGb: breakdown.freeQuotaGb,
  });

  const money = {
    freeQuotaGb: new Prisma.Decimal(breakdown.freeQuotaGb),
    billableGb: new Prisma.Decimal(breakdown.billableGb),
    baseFee: new Prisma.Decimal(breakdown.baseFee),
    pricePerGb: new Prisma.Decimal(breakdown.pricePerGb),
    computedCost: new Prisma.Decimal(breakdown.computedCost),
    costWithoutOptimization: new Prisma.Decimal(breakdown.costWithoutOptimization),
    savedCost: new Prisma.Decimal(breakdown.savedCost),
  };

  const row = await prisma.costRecord.upsert({
    where: {
      scope_scopeRefId_periodStart_periodEnd_source: {
        scope: input.scope,
        scopeRefId,
        periodStart: input.range.start,
        periodEnd: input.range.end,
        source: resolvedSource,
      },
    },
    create: {
      scope: input.scope,
      scopeRefId,
      label: input.label.slice(0, 120),
      periodStart: input.range.start,
      periodEnd: input.range.end,
      rawBytes: breakdown.rawBytes,
      optimizedBytes: breakdown.optimizedBytes,
      savedBytes: breakdown.savedBytes,
      currency: breakdown.currency,
      inputHash,
      source: resolvedSource,
      ...money,
    },
    update: {
      label: input.label.slice(0, 120),
      rawBytes: breakdown.rawBytes,
      optimizedBytes: breakdown.optimizedBytes,
      savedBytes: breakdown.savedBytes,
      inputHash,
      computedAt: new Date(),
      ...money,
    },
  });

  await record({
    actor: input.actorId
      ? { type: "USER", id: input.actorId, label: input.actorLabel }
      : { type: "SYSTEM", id: null, label: input.actorLabel },
    action: "billing.cost_computed",
    resource: "cost_record",
    resourceId: row.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: {
      scope: input.scope,
      scopeRefId,
      periodStart: input.range.start.toISOString(),
      periodEnd: input.range.end.toISOString(),
      computedCost: breakdown.computedCost,
      currency: breakdown.currency,
      inputHash,
    },
  });

  return { id: row.id, breakdown };
}
