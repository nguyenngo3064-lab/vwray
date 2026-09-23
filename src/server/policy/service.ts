import "server-only";
import type { Prisma, PolicyStatus, PolicyExecutionResult } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { publishDomain } from "@/server/events/dispatch";
import { ACTION_CATALOG } from "@/server/policy/actions";
import { METRIC_TARGETS, POLICY_ACTIONS, POLICY_METRICS, parseAction, parseCondition } from "@/server/policy/schema";
import type { PolicyRow } from "@/server/policy/engine";

/**
 * Policy CRUD and read models.
 *
 * Every mutation is validated (so a malformed condition can never be stored), audited in
 * the same call, and re-validated on read by the engine - the console never has to trust
 * that what it wrote is what runs.
 */

export interface PolicyView {
  id: string;
  name: string;
  description: string | null;
  status: PolicyStatus;
  priority: number;
  targetKind: string;
  condition: {
    metric: string;
    operator: string;
    value: number;
    windowSeconds: number;
    baselineWindowSeconds?: number;
    minSamples: number;
  } | null;
  conditionValid: boolean;
  action: { key: string; params: Record<string, unknown> } | null;
  actionValid: boolean;
  cooldownSeconds: number;
  dryRun: boolean;
  override: { until: string; label: string | null; reason: string | null; active: boolean } | null;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  recent: { applied: number; suppressed: number; cooldown: number; unmeasurable: number; failed: number };
  createdAt: string;
}

function viewOf(
  row: PolicyRow & { executions: Array<{ result: PolicyExecutionResult }> },
  now: Date,
): PolicyView {
  let condition: PolicyView["condition"] = null;
  let action: PolicyView["action"] = null;
  let conditionValid = true;
  let actionValid = true;
  try {
    const parsed = parseCondition(row.condition);
    condition = parsed;
  } catch {
    conditionValid = false;
  }
  try {
    const parsed = parseAction(row.action);
    action = parsed;
  } catch {
    actionValid = false;
  }

  const recent = { applied: 0, suppressed: 0, cooldown: 0, unmeasurable: 0, failed: 0 };
  for (const execution of row.executions) {
    if (execution.result === "APPLIED") recent.applied += 1;
    else if (execution.result === "SUPPRESSED") recent.suppressed += 1;
    else if (execution.result === "COOLDOWN") recent.cooldown += 1;
    else if (execution.result === "UNMEASURABLE") recent.unmeasurable += 1;
    else if (execution.result === "FAILED") recent.failed += 1;
  }

  const overrideActive = row.overrideUntil !== null && row.overrideUntil.getTime() > now.getTime();

  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    priority: row.priority,
    targetKind: row.targetKind,
    condition,
    conditionValid,
    action,
    actionValid,
    cooldownSeconds: row.cooldownSeconds,
    dryRun: row.dryRun,
    override:
      row.overrideUntil === null
        ? null
        : {
            until: row.overrideUntil.toISOString(),
            label: row.overrideLabel,
            reason: row.overrideReason,
            active: overrideActive,
          },
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    recent,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listPolicies(filters?: {
  status?: PolicyStatus;
  targetKind?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}): Promise<{ items: PolicyView[]; total: number }> {
  const page = Math.max(1, filters?.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters?.pageSize ?? 25));
  const where: Prisma.PolicyWhereInput = {
    ...(filters?.status ? { status: filters.status } : {}),
    ...(filters?.targetKind ? { targetKind: filters.targetKind as never } : {}),
    ...(filters?.search
      ? {
          OR: [
            { name: { contains: filters.search, mode: "insensitive" } },
            { description: { contains: filters.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.policy.findMany({
      where,
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        executions: {
          where: { evaluatedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
          select: { result: true },
        },
      },
    }),
    prisma.policy.count({ where }),
  ]);

  const now = new Date();
  return { items: rows.map((row) => viewOf(row as PolicyRow & { executions: Array<{ result: PolicyExecutionResult }> }, now)), total };
}

export async function getPolicy(id: string): Promise<PolicyView> {
  const row = await prisma.policy.findUnique({
    where: { id },
    include: { executions: { orderBy: { evaluatedAt: "desc" }, take: 50, select: { result: true } } },
  });
  if (!row) throw errors.notFound("Policy");
  return viewOf(row as PolicyRow & { executions: Array<{ result: PolicyExecutionResult }> }, new Date());
}

export interface PolicyInput {
  name: string;
  description?: string | null;
  targetKind?: "DEVICE" | "USER" | "NODE" | "CONFIG" | "SYSTEM";
  condition: unknown;
  action: unknown;
  priority?: number;
  cooldownSeconds?: number;
  dryRun?: boolean;
  status?: PolicyStatus;
}

async function validate(input: PolicyInput): Promise<{
  condition: ReturnType<typeof parseCondition>;
  action: ReturnType<typeof parseAction>;
}> {
  const condition = parseCondition(input.condition);
  const action = parseAction(input.action);
  const targetKind = input.targetKind ?? "DEVICE";
  const allowed = METRIC_TARGETS[condition.metric];
  if (!allowed.includes(targetKind)) {
    throw errors.validation(`Metric ${condition.metric} cannot be evaluated against a ${targetKind} target.`, {
      metric: condition.metric,
      allowedTargets: allowed,
    });
  }
  const allowedActions: string[] = ACTION_CATALOG.filter((entry) =>
    (entry.targets as ReadonlyArray<string>).includes(targetKind),
  ).map((entry) => entry.key as string);
  if (!allowedActions.includes(action.key)) {
    throw errors.validation(`Action ${action.key} cannot run against a ${targetKind} target.`, {
      action: action.key,
      allowedActions,
    });
  }
  return { condition, action };
}

export async function createPolicy(
  input: PolicyInput & { actorId: string; actorLabel: string; sourceIp?: string | null; requestId?: string | null },
): Promise<PolicyView> {
  const { condition, action } = await validate(input);
  const targetKind = input.targetKind ?? "DEVICE";

  const created = await prisma.policy.create({
    data: {
      name: input.name,
      description: input.description ?? null,
      targetKind,
      condition: condition as unknown as Prisma.InputJsonValue,
      action: action as unknown as Prisma.InputJsonValue,
      priority: input.priority ?? 100,
      cooldownSeconds: input.cooldownSeconds ?? 600,
      dryRun: input.dryRun ?? false,
      status: input.status ?? "ENABLED",
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "policy.created",
    resource: "policy",
    resourceId: created.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    requestId: input.requestId ?? null,
    metadata: {
      name: created.name,
      metric: condition.metric,
      operator: condition.operator,
      threshold: condition.value,
      actionKey: action.key,
      targetKind,
      status: created.status,
      dryRun: created.dryRun,
      cooldownSeconds: created.cooldownSeconds,
    },
  });

  return getPolicy(created.id);
}

export async function updatePolicy(
  id: string,
  input: Partial<PolicyInput> & { actorId: string; actorLabel: string; sourceIp?: string | null; requestId?: string | null },
): Promise<PolicyView> {
  const existing = await prisma.policy.findUnique({ where: { id } });
  if (!existing) throw errors.notFound("Policy");

  const merged = {
    name: input.name ?? existing.name,
    description: input.description !== undefined ? input.description : existing.description,
    targetKind: input.targetKind ?? (existing.targetKind as "DEVICE" | "USER" | "NODE" | "CONFIG" | "SYSTEM"),
    condition: input.condition !== undefined ? input.condition : existing.condition,
    action: input.action !== undefined ? input.action : existing.action,
  };
  const { condition, action } = await validate(merged as PolicyInput);

  const updated = await prisma.policy.update({
    where: { id },
    data: {
      name: merged.name,
      description: merged.description,
      targetKind: merged.targetKind as never,
      condition: condition as unknown as Prisma.InputJsonValue,
      action: action as unknown as Prisma.InputJsonValue,
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.cooldownSeconds !== undefined ? { cooldownSeconds: input.cooldownSeconds } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      updatedById: input.actorId,
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action:
      input.status && input.status !== existing.status
        ? input.status === "ENABLED"
          ? "policy.enabled"
          : "policy.disabled"
        : "policy.updated",
    resource: "policy",
    resourceId: id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    requestId: input.requestId ?? null,
    metadata: {
      changed: Object.keys(input).filter((key) => !["actorId", "actorLabel", "sourceIp", "requestId"].includes(key)),
      previousStatus: existing.status,
      nextStatus: updated.status,
      actionKey: action.key,
      metric: condition.metric,
      threshold: condition.value,
    },
  });

  return getPolicy(id);
}

export async function deletePolicy(input: {
  id: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const existing = await prisma.policy.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Policy");
  await prisma.policy.delete({ where: { id: input.id } });
  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "policy.deleted",
    resource: "policy",
    resourceId: input.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { name: existing.name, metric: (existing.condition as { metric?: string } | null)?.metric ?? null },
  });
}

/** Execution history for the WHY / audit views. */
export async function listPolicyExecutions(filters: {
  policyId?: string;
  targetId?: string;
  result?: PolicyExecutionResult;
  page?: number;
  pageSize?: number;
}): Promise<{ items: unknown[]; total: number }> {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 25));
  const where: Prisma.PolicyExecutionWhereInput = {
    ...(filters.policyId ? { policyId: filters.policyId } : {}),
    ...(filters.targetId ? { targetId: filters.targetId } : {}),
    ...(filters.result ? { result: filters.result } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.policyExecution.findMany({
      where,
      orderBy: { evaluatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { policy: { select: { name: true, priority: true } } },
    }),
    prisma.policyExecution.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      policyId: row.policyId,
      policyName: row.policy.name,
      priority: row.policy.priority,
      evaluatedAt: row.evaluatedAt.toISOString(),
      result: row.result,
      targetKind: row.targetKind,
      targetId: row.targetId,
      targetLabel: row.targetLabel,
      metric: row.metric,
      operator: row.operator,
      observed: row.observed,
      threshold: row.threshold,
      actionKey: row.actionKey,
      actionPayload: row.actionPayload,
      evidence: row.evidence,
      message: row.message,
      suppressed: row.suppressed,
      suppressionReason: row.suppressionReason,
      dryRun: row.dryRun,
    })),
    total,
  };
}

/** Vocabulary the policy builder renders from: metrics, actions, and their target rules. */
export function policyRegistry() {
  return {
    metrics: POLICY_METRICS.map((metric) => ({
      key: metric,
      targets: METRIC_TARGETS[metric],
      // "Unavailable" is part of the contract: a metric with no data must not read as 0.
      unavailableBehaviour: "Recorded as UNMEASURABLE; the condition does not match.",
    })),
    actions: POLICY_ACTIONS.map((key) => ACTION_CATALOG.find((entry) => entry.key === key)).filter(Boolean),
    operators: ["GTE", "GT", "LTE", "LT", "EQ", "NEQ"],
    targetKinds: ["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"],
    safety:
      "Policies may only reference named metrics and predefined actions. No code, shell, SQL or arbitrary requests can be expressed.",
  };
}

export { publishDomain };
