import "server-only";
import { Prisma, type NotificationSeverity } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { publishDomain } from "@/server/events/dispatch";
import { buildDedupeKey } from "@/server/lib/ids";
import { getBillingOverview } from "@/server/billing/service";

/**
 * Budget management (simulated spend only).
 *
 * A budget observes the current simulated spend against a ceiling and raises warnings at
 * 50 / 75 / 90 / 100%. It NEVER disconnects, throttles or blocks anything by itself:
 * acting on a budget requires an explicit policy whose action is one of the closed,
 * audited registry actions. That separation is the whole point of having a policy engine
 * next to it, and it is stated in the console copy as well as here.
 *
 * Spending numbers come from `getBillingOverview()` - the same measured traffic and the
 * same pricing the receipts use - so a budget warning and a receipt can never disagree.
 * When billing has no data yet, `available` is false and no threshold is raised.
 */

export const BUDGET_THRESHOLDS = [50, 75, 90, 100] as const;

export interface BudgetConsumption {
  available: boolean;
  /** Stated when `available` is false, or when a projection could not be formed. */
  reason: string | null;
  spentAmount: string;
  limitAmount: string;
  percent: number | null;
  currency: string;
  projectedAmount: string | null;
  projectedPercent: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  source: string;
  calculation: string | null;
}

export interface BudgetView {
  id: string;
  name: string;
  scope: string;
  scopeRefId: string | null;
  currency: string;
  amountLimit: string;
  period: string;
  periodStartDay: number;
  enabled: boolean;
  thresholds: number[];
  consumption: BudgetConsumption;
  nextThreshold: number | null;
  lastEvaluatedAt: string | null;
  createdAt: string;
}

interface BudgetRow {
  id: string;
  name: string;
  scope: "SYSTEM" | "USER" | "DEVICE" | "NODE" | "CATEGORY";
  scopeRefId: string | null;
  currency: string;
  amountLimit: Prisma.Decimal;
  period: "MONTHLY" | "WEEKLY" | "CUSTOM";
  periodStartDay: number;
  enabled: boolean;
  warnedAt50: Date | null;
  warnedAt75: Date | null;
  warnedAt90: Date | null;
  warnedAt100: Date | null;
  lastEvaluatedAt: Date | null;
  createdAt: Date;
}

/** How much the current simulated period has cost for one budget's scope. */
async function consumptionFor(budget: BudgetRow): Promise<BudgetConsumption> {
  const overview = await getBillingOverview();
  const limit = Number(budget.amountLimit.toString());
  const currency = budget.currency;

  if (!overview.dataAvailable) {
    return {
      available: false,
      reason: "No traffic recorded for the current period, so nothing has been costed yet.",
      spentAmount: "0",
      limitAmount: String(limit),
      percent: null,
      currency,
      projectedAmount: null,
      projectedPercent: null,
      periodStart: overview.period.start,
      periodEnd: overview.period.end,
      source: overview.source,
      calculation: null,
    };
  }

  // SYSTEM budgets use the period total; a scoped budget uses that dimension's slice.
  let spent: number;
  let scopeLabel: string;
  if (budget.scope === "SYSTEM") {
    spent = overview.totals.computedCost;
    scopeLabel = "system total";
  } else {
    const bucket =
      budget.scope === "DEVICE" ? "device" : budget.scope === "USER" ? "user" : budget.scope === "NODE" ? "node" : "category";
    const rows = overview.scopes[bucket as keyof typeof overview.scopes];
    const match = rows.find((row) => row.key === budget.scopeRefId);
    if (!match) {
      return {
        available: false,
        reason: `No costed traffic for this ${bucket} in the current period.`,
        spentAmount: "0",
        limitAmount: String(limit),
        percent: null,
        currency,
        projectedAmount: null,
        projectedPercent: null,
        periodStart: overview.period.start,
        periodEnd: overview.period.end,
        source: overview.source,
        calculation: null,
      };
    }
    spent = match.computedCost;
    scopeLabel = match.label;
  }

  const percent = limit > 0 ? (spent / limit) * 100 : null;
  const projected = overview.projection.available ? overview.projection.projectedCost : null;

  return {
    available: percent !== null,
    reason: percent === null ? "Budget limit must be greater than zero." : null,
    spentAmount: String(spent),
    limitAmount: String(limit),
    percent,
    currency,
    projectedAmount: projected === null ? null : String(projected),
    projectedPercent: projected !== null && limit > 0 ? (projected / limit) * 100 : null,
    periodStart: overview.period.start,
    periodEnd: overview.period.end,
    source: overview.source,
    calculation: `${spent.toFixed(2)} ${currency} of ${limit} ${currency} (${scopeLabel}; ${overview.pricing.pricePerGb} ${currency}/GB + ${overview.pricing.baseFee} ${currency} base, measured traffic for ${overview.period.start} → ${overview.period.end})`,
  };
}

function severityForThreshold(pct: number): NotificationSeverity {
  if (pct >= 100) return "CRITICAL";
  if (pct >= 90) return "HIGH";
  if (pct >= 75) return "MEDIUM";
  return "LOW";
}

function warnedField(pct: number): "warnedAt50" | "warnedAt75" | "warnedAt90" | "warnedAt100" | null {
  if (pct >= 100) return "warnedAt100";
  if (pct >= 90) return "warnedAt90";
  if (pct >= 75) return "warnedAt75";
  if (pct >= 50) return "warnedAt50";
  return null;
}

export async function listBudgets(): Promise<BudgetView[]> {
  const budgets = await prisma.budget.findMany({ orderBy: { createdAt: "asc" } });
  return Promise.all(
    budgets.map(async (budget) => {
      const consumption = await consumptionFor(budget);
      const crossed = warnedField(consumption.percent ?? 0);
      const next = BUDGET_THRESHOLDS.find((threshold) => (consumption.percent ?? 0) < threshold) ?? null;
      void crossed;
      return {
        id: budget.id,
        name: budget.name,
        scope: budget.scope,
        scopeRefId: budget.scopeRefId,
        currency: budget.currency,
        amountLimit: budget.amountLimit.toString(),
        period: budget.period,
        periodStartDay: budget.periodStartDay,
        enabled: budget.enabled,
        thresholds: [...BUDGET_THRESHOLDS],
        consumption,
        nextThreshold: next,
        lastEvaluatedAt: budget.lastEvaluatedAt?.toISOString() ?? null,
        createdAt: budget.createdAt.toISOString(),
      };
    }),
  );
}

/**
 * Evaluates every enabled budget and raises any threshold that is newly crossed.
 * Called by the automation engine's billing sweep and directly by the API.
 *
 * Each threshold fires AT MOST ONCE per period: the dedupe key contains the period start,
 * so a restart or a second evaluation in the same period cannot replay the warning.
 */
export async function evaluateBudgets(now: Date = new Date()): Promise<{
  evaluated: number;
  raised: number;
  unavailable: number;
}> {
  const budgets = await prisma.budget.findMany({ where: { enabled: true } });
  let raised = 0;
  let unavailable = 0;

  for (const budget of budgets) {
    const consumption = await consumptionFor(budget);
    await prisma.budget.update({ where: { id: budget.id }, data: { lastEvaluatedAt: now } }).catch(() => undefined);

    if (!consumption.available || consumption.percent === null) {
      unavailable += 1;
      continue;
    }

    const percent = consumption.percent;
    const highestCrossed = [...BUDGET_THRESHOLDS].reverse().find((threshold) => percent >= threshold);
    if (highestCrossed === undefined) continue;

    const field = warnedField(percent);
    if (!field || budget[field] !== null) continue;

    const periodStart = consumption.periodStart ?? now.toISOString();
    const dedupeKey = buildDedupeKey([budget.id, highestCrossed, periodStart]);

    const event = await prisma.budgetEvent.upsert({
      where: { dedupeKey },
      create: {
        budgetId: budget.id,
        thresholdPct: highestCrossed,
        observedPct: percent,
        spentAmount: new Prisma.Decimal(consumption.spentAmount),
        limitAmount: new Prisma.Decimal(consumption.limitAmount),
        projectedAmount: consumption.projectedAmount ? new Prisma.Decimal(consumption.projectedAmount) : null,
        severity: severityForThreshold(highestCrossed),
        evidence: {
          currency: consumption.currency,
          calculation: consumption.calculation,
          periodStart: consumption.periodStart,
          periodEnd: consumption.periodEnd,
          source: consumption.source,
        },
        dedupeKey,
      },
      update: {
        observedPct: percent,
        spentAmount: new Prisma.Decimal(consumption.spentAmount),
        projectedAmount: consumption.projectedAmount ? new Prisma.Decimal(consumption.projectedAmount) : null,
      },
    });

    // Only the transition itself is new: an upsert that changed nothing means we already
    // warned in this period, so the notification and audit stay silent.
    const isNew = budget[field] === null;
    if (isNew) {
      await prisma.budget.update({ where: { id: budget.id }, data: { [field]: now } });
      raised += 1;

      await record({
        actor: { type: "SYSTEM", id: null, label: "budget monitor" },
        action: "budget.threshold",
        resource: "budget",
        resourceId: budget.id,
        result: "SUCCESS",
        metadata: {
          thresholdPct: highestCrossed,
          observedPct: percent,
          spentAmount: consumption.spentAmount,
          limitAmount: consumption.limitAmount,
          budgetEventId: event.id,
        },
      });

      await publishDomain("budget.threshold", {
        ts: now.getTime(),
        budgetId: budget.id,
        budgetName: budget.name,
        scope: budget.scope,
        scopeRefId: budget.scopeRefId,
        thresholdPct: highestCrossed,
        observedPct: percent,
        spentAmount: consumption.spentAmount,
        limitAmount: consumption.limitAmount,
        currency: consumption.currency,
        projectedAmount: consumption.projectedAmount,
      });
    }
  }

  return { evaluated: budgets.length, raised, unavailable };
}

export async function createBudget(input: {
  name: string;
  amountLimit: string | number;
  currency?: string;
  scope?: BudgetRow["scope"];
  scopeRefId?: string | null;
  period?: BudgetRow["period"];
  periodStartDay?: number;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<BudgetView> {
  const limit = Number(input.amountLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw errors.validation("Budget limit must be a positive number.");
  }

  try {
    const created = await prisma.budget.create({
      data: {
        name: input.name,
        amountLimit: new Prisma.Decimal(limit.toFixed(4)),
        currency: input.currency ?? "VND",
        scope: input.scope ?? "SYSTEM",
        scopeRefId: input.scopeRefId ?? null,
        period: input.period ?? "MONTHLY",
        periodStartDay: input.periodStartDay ?? 1,
        createdById: input.actorId,
      },
    });

    await record({
      actor: { type: "USER", id: input.actorId, label: input.actorLabel },
      action: "budget.created",
      resource: "budget",
      resourceId: created.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp ?? null,
      metadata: { name: created.name, amountLimit: created.amountLimit.toString(), currency: created.currency },
    });

    const [view] = await listBudgets();
    const target = (await listBudgets()).find((entry) => entry.id === created.id);
    void view;
    if (target) return target;
    throw errors.internal("Budget created but could not be read back.");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") {
      throw errors.conflict("A budget with that name already exists for this scope.");
    }
    throw error;
  }
}

export async function updateBudget(input: {
  id: string;
  name?: string;
  amountLimit?: string | number;
  enabled?: boolean;
  periodStartDay?: number;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<BudgetView> {
  const existing = await prisma.budget.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Budget");

  const data: Prisma.BudgetUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.amountLimit !== undefined) {
    const limit = Number(input.amountLimit);
    if (!Number.isFinite(limit) || limit <= 0) throw errors.validation("Budget limit must be a positive number.");
    data.amountLimit = new Prisma.Decimal(limit.toFixed(4));
  }
  if (input.enabled !== undefined) data.enabled = input.enabled;
  if (input.periodStartDay !== undefined) data.periodStartDay = input.periodStartDay;

  await prisma.budget.update({ where: { id: existing.id }, data });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "budget.updated",
    resource: "budget",
    resourceId: existing.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { changed: Object.keys(data) },
  });

  const views = await listBudgets();
  const target = views.find((entry) => entry.id === existing.id);
  if (target) return target;
  throw errors.notFound("Budget");
}

export async function deleteBudget(input: {
  id: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const existing = await prisma.budget.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Budget");
  await prisma.budget.delete({ where: { id: existing.id } });
  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "budget.deleted",
    resource: "budget",
    resourceId: existing.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { name: existing.name },
  });
}

export async function listBudgetEvents(budgetId?: string, limit = 50) {
  return prisma.budgetEvent.findMany({
    where: budgetId ? { budgetId } : {},
    orderBy: { raisedAt: "desc" },
    take: Math.min(limit, 200),
  });
}

/** Consumption for one budget, used by the policy engine's BUDGET_PERCENT metric. */
export async function budgetConsumption(budgetId: string): Promise<BudgetConsumption> {
  const budget = await prisma.budget.findUnique({ where: { id: budgetId } });
  if (!budget) throw errors.notFound("Budget");
  return consumptionFor(budget);
}

/** First enabled SYSTEM budget, or null. Used when a policy targets SYSTEM percent. */
export async function primaryBudgetConsumption(): Promise<BudgetConsumption | null> {
  const budget = await prisma.budget.findFirst({ where: { enabled: true }, orderBy: { createdAt: "asc" } });
  if (!budget) return null;
  return consumptionFor(budget);
}
