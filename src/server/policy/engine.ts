import "server-only";
import type { PolicyActionKey, PolicyExecutionResult, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { publishDomain } from "@/server/events/dispatch";
import { compare, observeMetric, targetsForPolicy, type Observation, type PolicyTarget } from "@/server/policy/metrics";
import { executeAction, type ActionResult } from "@/server/policy/actions";
import { parseAction, parseCondition, type PolicyAction, type PolicyCondition } from "@/server/policy/schema";

/**
 * Policy engine.
 *
 * Evaluation order is fixed and stated to the operator: policies run by `priority`
 * ascending (ties broken by creation time), one target at a time, and the result of every
 * decision that is not a plain non-match is written to `PolicyExecution` - which is both
 * the audit trail and the evidence behind the console's WHY view.
 *
 * What is deliberately NOT written: a row per non-matching target per tick. A fleet of
 * 500 devices against 10 quiet policies would be 5,000,000 empty rows a day. Non-matches
 * are counted in the summary instead; matches, cooldowns, suppressions and unmeasurable
 * results are always persisted, because those are the ones an operator might need to
 * reconstruct a decision later.
 *
 * Safety properties:
 *   * conditions and actions are re-validated from JSON on every read;
 *   * a metric that cannot be measured yields UNMEASURABLE, never a comparison to 0;
 *   * cooldown is enforced per target, so a threshold-hugging metric cannot fire wildly;
 *   * `dryRun` and an operator override both suppress the ACTION while still recording
 *     that the condition matched;
 *   * actions come from the closed registry in actions.ts - no code execution path exists.
 */

export interface PolicyRow {
  id: string;
  name: string;
  description: string | null;
  status: "ENABLED" | "DISABLED";
  priority: number;
  targetKind: "DEVICE" | "USER" | "NODE" | "CONFIG" | "SYSTEM";
  condition: Prisma.JsonValue;
  action: Prisma.JsonValue;
  cooldownSeconds: number;
  dryRun: boolean;
  overrideUntil: Date | null;
  overrideLabel: string | null;
  overrideReason: string | null;
  lastEvaluatedAt: Date | null;
  lastTriggeredAt: Date | null;
  createdAt: Date;
}

export interface EvaluationOutcome {
  policyId: string;
  policyName: string;
  target: PolicyTarget;
  metric: string;
  operator: string;
  observed: number | null;
  threshold: number;
  evidence: Record<string, unknown>;
  unavailableReason: string | null;
  matched: boolean;
  result: PolicyExecutionResult;
  suppressionReason: string | null;
  actionKey: string | null;
  actionResult: ActionResult | null;
  executionId: string | null;
  message: string;
}

export interface EvaluationSummary {
  policyId: string;
  policyName: string;
  evaluated: number;
  matched: number;
  applied: number;
  noOp: number;
  cooldown: number;
  suppressed: number;
  unmeasurable: number;
  failed: number;
  outcomes: EvaluationOutcome[];
}

/** ISO minute bucket used to collapse repeated identical executions. */
function minuteBucket(now: Date): number {
  return Math.floor(now.getTime() / 60_000);
}

function targetKey(target: PolicyTarget): string {
  return target.id ?? `${target.kind}:system`;
}

async function persistExecution(input: {
  policyId: string;
  now: Date;
  target: PolicyTarget;
  condition: PolicyCondition;
  observation: Observation;
  result: PolicyExecutionResult;
  actionKey?: PolicyActionKey | null;
  actionPayload?: Record<string, unknown> | null;
  actionResult?: ActionResult;
  message: string;
  suppressed?: boolean;
  suppressionReason?: string | null;
  dryRun?: boolean;
  dedupeKey?: string;
}): Promise<PolicyExecutionResult> {
  const data: Prisma.PolicyExecutionUncheckedCreateInput = {
    policyId: input.policyId,
    evaluatedAt: input.now,
    result: input.result,
    targetKind: input.target.kind,
    targetId: input.target.id,
    targetLabel: input.target.label,
    metric: input.condition.metric,
    operator: input.condition.operator,
    observed: input.observation.observed,
    threshold: input.condition.value,
    actionKey: input.actionKey ?? null,
    actionPayload: (input.actionPayload ?? undefined) as Prisma.InputJsonValue | undefined,
    evidence: {
      ...input.observation.evidence,
      windowSeconds: input.condition.windowSeconds,
      unavailableReason: input.observation.unavailableReason ?? null,
    } as Prisma.InputJsonValue,
    message: input.message,
    suppressed: input.suppressed ?? false,
    suppressionReason: input.suppressionReason ?? null,
    dryRun: input.dryRun ?? false,
    dedupeKey: input.dedupeKey,
  };

  try {
    const created = await prisma.policyExecution.upsert({
      where: { dedupeKey: data.dedupeKey as string },
      create: data,
      update: {
        evaluatedAt: input.now,
        observed: input.observation.observed,
        evidence: data.evidence,
        message: input.message,
        ...(input.actionResult ? { actionPayload: { ...(input.actionPayload ?? {}), result: input.actionResult } as unknown as Prisma.InputJsonValue } : {}),
      },
      select: { id: true },
    });
    lastExecutionId = created.id;
    return input.result;
  } catch (error) {
    lastExecutionId = null;
    logger.error("policy execution write failed", { policyId: input.policyId, result: input.result, error });
    return input.result;
  }
}

// The persist helper above is intentionally synchronous with one evaluation; carrying the
// id out via a module variable keeps the hot path free of an extra parameter thread while
// remaining correct because evaluations are sequential inside one policy.
let lastExecutionId: string | null = null;

async function cooldownActive(policy: PolicyRow, target: PolicyTarget, now: Date): Promise<{ active: boolean; since: string | null }> {
  if (policy.cooldownSeconds <= 0) return { active: false, since: null };
  const last = await prisma.policyExecution.findFirst({
    where: { policyId: policy.id, targetId: target.id, result: { in: ["APPLIED", "NO_OP"] }, evaluatedAt: { lt: now } },
    orderBy: { evaluatedAt: "desc" },
    select: { evaluatedAt: true },
  });
  if (!last) return { active: false, since: null };
  const elapsedSeconds = (now.getTime() - last.evaluatedAt.getTime()) / 1000;
  if (elapsedSeconds < policy.cooldownSeconds) return { active: true, since: last.evaluatedAt.toISOString() };
  return { active: false, since: last.evaluatedAt.toISOString() };
}

export interface EvaluateOptions {
  now?: Date;
  /** Force dry-run regardless of the stored flag (used by simulation). */
  forceDryRun?: boolean;
  /** Persist execution rows. Simulation sets this false for pure "what-if" runs. */
  persist?: boolean;
}

/** Evaluates one policy against one target. Pure with respect to side effects unless persist/actions run. */
export async function evaluatePolicyTarget(
  policy: PolicyRow,
  target: PolicyTarget,
  options: EvaluateOptions = {},
): Promise<EvaluationOutcome> {
  const now = options.now ?? new Date();
  const persist = options.persist ?? true;
  const condition = parseCondition(policy.condition);
  const action = parseAction(policy.action);

  const base = {
    policyId: policy.id,
    policyName: policy.name,
    target,
    metric: condition.metric,
    operator: condition.operator,
    threshold: condition.value,
    actionKey: action.key as string,
  };

  const observation = await observeMetric(condition.metric, target, condition);

  if (observation.observed === null) {
    const reason = observation.unavailableReason ?? "Metric could not be measured.";
    if (persist) {
      lastExecutionId = null;
      await persistExecution({
        policyId: policy.id,
        now,
        target,
        condition,
        observation,
        result: "UNMEASURABLE",
        actionKey: action.key,
        message: reason,
        dedupeKey: `${policy.id}:${targetKey(target)}:UNMEASURABLE:${condition.metric}`,
      });
    }
    return {
      ...base,
      observed: null,
      evidence: observation.evidence,
      unavailableReason: reason,
      matched: false,
      result: "UNMEASURABLE",
      suppressionReason: null,
      actionResult: null,
      executionId: lastExecutionId,
      message: reason,
    };
  }

  const matched = compare(observation.observed, condition.operator, condition.value);
  if (!matched) {
    return {
      ...base,
      observed: observation.observed,
      evidence: observation.evidence,
      unavailableReason: null,
      matched: false,
      result: "NO_MATCH",
      suppressionReason: null,
      actionResult: null,
      executionId: null,
      message: `${condition.metric} = ${observation.observed} does not satisfy ${condition.operator} ${condition.value}.`,
    };
  }

  const dryRun = Boolean(options.forceDryRun || policy.dryRun);
  const overrideActive = policy.overrideUntil !== null && policy.overrideUntil.getTime() > now.getTime();

  if (!dryRun && !overrideActive) {
    const cooldown = await cooldownActive(policy, target, now);
    if (cooldown.active) {
      if (persist) {
        lastExecutionId = null;
        await persistExecution({
          policyId: policy.id,
          now,
          target,
          condition,
          observation,
          result: "COOLDOWN",
          actionKey: action.key,
          message: `Cooldown active (last action ${cooldown.since ?? "unknown"}, window ${policy.cooldownSeconds}s).`,
          suppressed: true,
          suppressionReason: "cooldown",
          dedupeKey: `${policy.id}:${targetKey(target)}:COOLDOWN:${minuteBucket(now)}`,
        });
      }
      return {
        ...base,
        observed: observation.observed,
        evidence: observation.evidence,
        unavailableReason: null,
        matched: true,
        result: "COOLDOWN",
        suppressionReason: "cooldown",
        actionResult: null,
        executionId: lastExecutionId,
        message: `Matched, but the ${policy.cooldownSeconds}s cooldown has not elapsed.`,
      };
    }
  }

  if (overrideActive) {
    if (persist) {
      lastExecutionId = null;
      await persistExecution({
        policyId: policy.id,
        now,
        target,
        condition,
        observation,
        result: "SUPPRESSED",
        actionKey: action.key,
        message: `Suppressed by operator override${policy.overrideLabel ? ` from ${policy.overrideLabel}` : ""}${policy.overrideReason ? `: ${policy.overrideReason}` : "."}`,
        suppressed: true,
        suppressionReason: "operator_override",
        dedupeKey: `${policy.id}:${targetKey(target)}:OVERRIDE:${minuteBucket(now)}`,
      });
    }
    return {
      ...base,
      observed: observation.observed,
      evidence: observation.evidence,
      unavailableReason: null,
      matched: true,
      result: "SUPPRESSED",
      suppressionReason: `operator_override${policy.overrideReason ? `: ${policy.overrideReason}` : ""}`,
      actionResult: null,
      executionId: lastExecutionId,
      message: "Condition matched but an operator override is active.",
    };
  }

  if (dryRun) {
    if (persist) {
      lastExecutionId = null;
      await persistExecution({
        policyId: policy.id,
        now,
        target,
        condition,
        observation,
        result: "SUPPRESSED",
        actionKey: action.key,
        actionPayload: action.params,
        message: "Dry run: the condition matched and the action would have run.",
        suppressed: true,
        suppressionReason: "dry_run",
        dryRun: true,
        dedupeKey: `${policy.id}:${targetKey(target)}:DRYRUN:${minuteBucket(now)}`,
      });
    }
    return {
      ...base,
      observed: observation.observed,
      evidence: observation.evidence,
      unavailableReason: null,
      matched: true,
      result: "SUPPRESSED",
      suppressionReason: "dry_run",
      actionResult: { applied: false, detail: "Dry run: no action executed." },
      executionId: lastExecutionId,
      message: "Dry run: matched, action not executed.",
    };
  }

  let actionResult: ActionResult;
  try {
    actionResult = await executeAction(action.key, {
      policyId: policy.id,
      policyName: policy.name,
      target,
      params: action.params,
      metric: condition.metric,
      observed: observation.observed,
      threshold: condition.value,
      evidence: observation.evidence,
      dryRun: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Action failed.";
    if (persist) {
      lastExecutionId = null;
      await persistExecution({
        policyId: policy.id,
        now,
        target,
        condition,
        observation,
        result: "FAILED",
        actionKey: action.key,
        actionPayload: action.params,
        message,
        dedupeKey: `${policy.id}:${targetKey(target)}:FAILED:${action.key}:${minuteBucket(now)}`,
      });
    }
    logger.error("policy action failed", { policyId: policy.id, actionKey: action.key, target: targetKey(target), error });
    return {
      ...base,
      observed: observation.observed,
      evidence: observation.evidence,
      unavailableReason: null,
      matched: true,
      result: "FAILED",
      suppressionReason: null,
      actionResult: null,
      executionId: lastExecutionId,
      message,
    };
  }

  const result: PolicyExecutionResult = actionResult.applied ? "APPLIED" : "NO_OP";
  if (persist) {
    lastExecutionId = null;
    await persistExecution({
      policyId: policy.id,
      now,
      target,
      condition,
      observation,
      result,
      actionKey: action.key as PolicyActionKey,
      actionPayload: action.params,
      actionResult,
      message: actionResult.detail,
      dedupeKey: `${policy.id}:${targetKey(target)}:${action.key}:${minuteBucket(now)}`,
    });
  }

  const executionId = lastExecutionId;

  if (persist) {
    await prisma.policy.update({
      where: { id: policy.id },
      data: { lastEvaluatedAt: now, ...(result === "APPLIED" ? { lastTriggeredAt: now } : {}) },
    });

    await publishDomain("policy.triggered", {
      ts: now.getTime(),
      policyId: policy.id,
      policyName: policy.name,
      executionId: executionId ?? "",
      actionKey: action.key,
      targetKind: target.kind,
      targetId: target.id,
      targetLabel: target.label,
      metric: condition.metric,
      observed: observation.observed,
      threshold: condition.value,
      dryRun: false,
      suppressed: false,
    });
  }

  return {
    ...base,
    observed: observation.observed,
    evidence: observation.evidence,
    unavailableReason: null,
    matched: true,
    result,
    suppressionReason: null,
    actionResult,
    executionId,
    message: actionResult.detail,
  };
}

/** Evaluates one policy across its target list. */
export async function evaluatePolicy(
  policy: PolicyRow,
  options: EvaluateOptions & { targetLimit?: number } = {},
): Promise<EvaluationSummary> {
  const targets = await targetsForPolicy(policy.targetKind, options.targetLimit ?? 500);
  const outcomes: EvaluationOutcome[] = [];

  const summary: EvaluationSummary = {
    policyId: policy.id,
    policyName: policy.name,
    evaluated: targets.length,
    matched: 0,
    applied: 0,
    noOp: 0,
    cooldown: 0,
    suppressed: 0,
    unmeasurable: 0,
    failed: 0,
    outcomes,
  };

  for (const target of targets) {
    let outcome: EvaluationOutcome;
    try {
      outcome = await evaluatePolicyTarget(policy, target, options);
    } catch (error) {
      summary.failed += 1;
      const message = error instanceof Error ? error.message : "Evaluation failed.";
      if (error instanceof SyntaxError || error instanceof TypeError) {
        logger.error("policy stored payload is invalid", { policyId: policy.id, error });
      }
      outcomes.push({
        policyId: policy.id,
        policyName: policy.name,
        target,
        metric: String((policy.condition as { metric?: string } | null)?.metric ?? "unknown"),
        operator: String((policy.condition as { operator?: string } | null)?.operator ?? "unknown"),
        observed: null,
        threshold: Number((policy.condition as { value?: number } | null)?.value ?? 0),
        evidence: {},
        unavailableReason: message,
        matched: false,
        result: "FAILED",
        suppressionReason: null,
        actionKey: null,
        actionResult: null,
        executionId: null,
        message,
      });
      continue;
    }

    outcomes.push(outcome);
    if (outcome.result === "NO_MATCH") continue;
    switch (outcome.result) {
      case "UNMEASURABLE":
        summary.unmeasurable += 1;
        break;
      case "COOLDOWN":
        summary.cooldown += 1;
        summary.matched += 1;
        break;
      case "SUPPRESSED":
        summary.suppressed += 1;
        summary.matched += 1;
        break;
      case "APPLIED":
        summary.applied += 1;
        summary.matched += 1;
        break;
      case "NO_OP":
        summary.noOp += 1;
        summary.matched += 1;
        break;
      case "FAILED":
        summary.failed += 1;
        break;
      default:
        break;
    }
  }

  return summary;
}

let running = false;

/**
 * Runs every ENABLED policy in priority order.
 *
 * A process-wide guard prevents overlapping runs: the scheduler and an operator-triggered
 * "evaluate now" could otherwise double-apply an action before the cooldown row exists.
 */
export async function evaluatePolicies(options: EvaluateOptions & { targetLimit?: number } = {}): Promise<{
  policies: number;
  targetsEvaluated: number;
  matched: number;
  applied: number;
  unmeasurable: number;
  failed: number;
  durationMs: number;
}> {
  if (running) {
    throw errors.conflict("A policy evaluation run is already in progress.");
  }
  running = true;
  const startedAt = Date.now();
  try {
    const policies = await prisma.policy.findMany({
      where: { status: "ENABLED" },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    let targetsEvaluated = 0;
    let matched = 0;
    let applied = 0;
    let unmeasurable = 0;
    let failed = 0;

    for (const policy of policies) {
      const summary = await evaluatePolicy(policy as PolicyRow, options);
      targetsEvaluated += summary.evaluated;
      matched += summary.matched;
      applied += summary.applied;
      unmeasurable += summary.unmeasurable;
      failed += summary.failed;
    }

    return {
      policies: policies.length,
      targetsEvaluated,
      matched,
      applied,
      unmeasurable,
      failed,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    running = false;
  }
}

export async function assertPolicyExists(id: string): Promise<PolicyRow> {
  const policy = await prisma.policy.findUnique({ where: { id } });
  if (!policy) throw errors.notFound("Policy");
  return policy as PolicyRow;
}

/** Manual override (suspend actions while still evaluating) and its audit record. */
export async function setPolicyOverride(input: {
  policyId: string;
  until: Date | null;
  reason?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<PolicyRow> {
  const policy = await assertPolicyExists(input.policyId);
  const updated = (await prisma.policy.update({
    where: { id: policy.id },
    data: {
      overrideUntil: input.until,
      overrideById: input.until ? input.actorId : null,
      overrideLabel: input.until ? input.actorLabel : null,
      overrideReason: input.until ? (input.reason ?? null) : null,
    },
  })) as PolicyRow;

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: input.until ? "policy.override_set" : "policy.override_cleared",
    resource: "policy",
    resourceId: policy.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { until: input.until?.toISOString() ?? null, reason: input.reason ?? null },
  });

  return updated;
}

export type { ActionResult, Observation, PolicyCondition, PolicyAction };
