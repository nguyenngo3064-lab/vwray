import "server-only";
import { prisma } from "@/server/db/client";
import { record } from "@/server/audit";
import { compare, observeMetric, targetsForPolicy, type PolicyTarget } from "@/server/policy/metrics";
import { isAlreadySatisfied } from "@/server/policy/actions";
import { parseAction, parseCondition } from "@/server/policy/schema";
import type { PolicyRow } from "@/server/policy/engine";

/**
 * Policy simulation - "TEST POLICY" before "ACTIVATE POLICY".
 *
 * The simulation walks the SAME observation path as the live engine, so a dry run cannot
 * quietly disagree with what production would do. What it refuses to do is anything with
 * a side effect: no action executes, no execution row is written, no notification is
 * raised. The only write is the `policy.simulated` audit entry, because a test that
 * nobody can trace afterwards is indistinguishable from a live trigger.
 *
 * It is also where "already satisfied" comes from: knowing that 1 of the 3 matched
 * devices is already blocked changes what an operator should do next, and the live engine
 * reports the same thing as a NO_OP.
 */

export interface SimulationTargetOutcome {
  id: string | null;
  label: string;
  kind: string;
  observed: number | null;
  threshold: number;
  operator: string;
  matched: boolean;
  unavailableReason: string | null;
  /** The action's end state is already true - running it would be a no-op. */
  alreadySatisfied: boolean;
  reason: string;
}

export interface SimulationResult {
  targetKind: string;
  metric: string;
  operator: string;
  threshold: number;
  windowSeconds: number;
  actionKey: string;
  evaluated: number;
  matched: number;
  unavailable: number;
  alreadySatisfied: number;
  byAction: Record<string, number>;
  /** Split of matched targets, so quota-style thresholds read naturally. */
  breakdown: {
    affected: number;
    warnings: number;
    alreadyExceeded: number;
    alreadySatisfied: number;
    unmeasurable: number;
  };
  targets: SimulationTargetOutcome[];
  truncated: boolean;
  summary: string;
  durationMs: number;
  /** Always states that nothing was changed. */
  notice: string;
}

const NOTICE =
  "Simulation only: no action ran, no state changed, and no notification was sent.";

export async function simulatePolicy(input: {
  condition: unknown;
  action: unknown;
  targetKind: "DEVICE" | "USER" | "NODE" | "CONFIG" | "SYSTEM";
  targetLimit?: number;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
  policyId?: string | null;
  policyName?: string;
}): Promise<SimulationResult> {
  const startedAt = Date.now();
  const condition = parseCondition(input.condition);
  const action = parseAction(input.action);
  const limit = Math.min(Math.max(input.targetLimit ?? 200, 1), 2000);

  const targets = await targetsForPolicy(input.targetKind, limit);
  const outcomes: SimulationTargetOutcome[] = [];
  const byAction: Record<string, number> = {};

  let matched = 0;
  let unavailable = 0;
  let satisfiedCount = 0;
  let warnings = 0;
  let alreadyExceeded = 0;

  for (const target of targets) {
    const observation = await observeMetric(condition.metric, target, condition);

    if (observation.observed === null) {
      unavailable += 1;
      outcomes.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        observed: null,
        threshold: condition.value,
        operator: condition.operator,
        matched: false,
        unavailableReason: observation.unavailableReason ?? "Metric could not be measured.",
        alreadySatisfied: false,
        reason: observation.unavailableReason ?? "Metric could not be measured.",
      });
      continue;
    }

    const isMatch = compare(observation.observed, condition.operator, condition.value);
    if (!isMatch) {
      outcomes.push({
        id: target.id,
        label: target.label,
        kind: target.kind,
        observed: observation.observed,
        threshold: condition.value,
        operator: condition.operator,
        matched: false,
        unavailableReason: null,
        alreadySatisfied: false,
        reason: `${condition.metric} = ${observation.observed.toFixed(2)} does not satisfy ${condition.operator} ${condition.value}.`,
      });
      continue;
    }

    matched += 1;
    byAction[action.key] = (byAction[action.key] ?? 0) + 1;

    const alreadySatisfied = await isAlreadySatisfied(action.key, target, action.params);
    if (alreadySatisfied) satisfiedCount += 1;

    if (condition.metric === "QUOTA_PERCENT") {
      if (observation.observed >= 100) alreadyExceeded += 1;
      else warnings += 1;
    }

    outcomes.push({
      id: target.id,
      label: target.label,
      kind: target.kind,
      observed: observation.observed,
      threshold: condition.value,
      operator: condition.operator,
      matched: true,
      unavailableReason: null,
      alreadySatisfied,
      reason: alreadySatisfied
        ? `${condition.metric} = ${observation.observed.toFixed(2)} matches, but the action is already in effect.`
        : `${condition.metric} = ${observation.observed.toFixed(2)} matches ${condition.operator} ${condition.value}.`,
    });
  }

  const truncated = targets.length >= limit;
  const suffix = unavailable > 0 ? ` · ${unavailable} could not be measured` : "";
  const summary =
    condition.metric === "QUOTA_PERCENT"
      ? `${matched} of ${targets.length} target(s) affected · ${warnings} warning(s) · ${alreadyExceeded} already exceeded${suffix}`
      : `${matched} of ${targets.length} target(s) match ${condition.metric} ${condition.operator} ${condition.value} → ${action.key}${matched > 0 && satisfiedCount > 0 ? ` · ${satisfiedCount} already satisfied` : ""}${suffix}`;

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "policy.simulated",
    resource: input.policyId ? "policy" : "policy_draft",
    resourceId: input.policyId ?? null,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: {
      policyName: input.policyName ?? input.policyId ?? "draft",
      metric: condition.metric,
      operator: condition.operator,
      threshold: condition.value,
      actionKey: action.key,
      targetKind: input.targetKind,
      evaluated: targets.length,
      matched,
      unavailable,
      alreadySatisfied: satisfiedCount,
      truncated,
    },
  });

  return {
    targetKind: input.targetKind,
    metric: condition.metric,
    operator: condition.operator,
    threshold: condition.value,
    windowSeconds: condition.windowSeconds,
    actionKey: action.key,
    evaluated: targets.length,
    matched,
    unavailable,
    alreadySatisfied: satisfiedCount,
    byAction,
    breakdown: {
      affected: matched,
      warnings,
      alreadyExceeded,
      alreadySatisfied: satisfiedCount,
      unmeasurable: unavailable,
    },
    targets: outcomes.filter((entry) => entry.matched || entry.unavailableReason !== null),
    truncated,
    summary,
    durationMs: Date.now() - startedAt,
    notice: NOTICE,
  };
}

/** Simulates an already-saved policy (the per-policy TEST button). */
export async function simulateStoredPolicy(
  policy: PolicyRow,
  input: { targetLimit?: number; actorId: string; actorLabel: string; sourceIp?: string | null },
): Promise<SimulationResult> {
  return simulatePolicy({
    condition: policy.condition,
    action: policy.action,
    targetKind: policy.targetKind,
    targetLimit: input.targetLimit,
    actorId: input.actorId,
    actorLabel: input.actorLabel,
    sourceIp: input.sourceIp,
    policyId: policy.id,
    policyName: policy.name,
  });
}

export type { PolicyTarget };

/** How many targets exist for a kind - shown next to a simulation so "0 of 0" is explainable. */
export async function targetCounts(): Promise<Record<string, number>> {
  const [devices, nodes, users, configs] = await Promise.all([
    prisma.device.count(),
    prisma.vpnNode.count(),
    prisma.adminUser.count(),
    prisma.vpnConfig.count(),
  ]);
  return { DEVICE: devices, NODE: nodes, USER: users, CONFIG: configs, SYSTEM: 1 };
}
