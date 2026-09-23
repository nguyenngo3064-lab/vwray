import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { quotaPercent } from "@/lib/format/units";
import { record, recordWithin, userActor } from "@/server/audit";
import { notify } from "@/server/notifications/service";
import { publish } from "@/server/realtime/bus";
import { getSetting, getSettings } from "@/server/settings/service";
import { logger } from "@/server/lib/logger";

/**
 * Quota engine.
 *
 * This module is the ONLY place a quota is evaluated, and it runs on the server,
 * inside the traffic ingest path. The frontend never decides anything: it only
 * renders the state this engine produced.
 *
 * Enforcement model
 * -----------------
 * Crossing the limit is not a warning, it is a state transition executed in a single
 * database transaction:
 *
 *   1. device.connectionStatus = QUOTA_EXCEEDED, quotaExceededAt = now
 *   2. quota.exceededAt = now, usedBytes recorded
 *   3. every open VpnSession for the device is closed with endReason = QUOTA_EXCEEDED
 *   4. GatewayPolicyState (device, node) is upserted to QUOTA_EXCEEDED with a bumped
 *      revision. The gateway agent PULLS this row, blocks the peer locally and
 *      refuses the handshake on reconnect.
 *   5. audit row `quota.exceeded` is written inside the same transaction
 *   6. an out-of-band notification is raised after commit
 *
 * Step 4 is what makes this real enforcement rather than a UI badge: the decision
 * travels to the data plane, and the data plane is the thing that refuses the
 * connection. `graceBytes` only tolerates packets already in flight when the
 * decision lands; it is never a bypass budget.
 */

export type QuotaScopeRef =
  | { scope: "SYSTEM"; scopeRefId: null }
  | { scope: "USER"; scopeRefId: string }
  | { scope: "DEVICE"; scopeRefId: string }
  | { scope: "CONFIG"; scopeRefId: string }
  | { scope: "NODE"; scopeRefId: string };

export interface QuotaEvaluation {
  quotaId: string;
  scope: string;
  scopeRefId: string | null;
  label: string;
  limitBytes: bigint;
  usedBytes: bigint;
  remainingBytes: bigint;
  percent: number | null;
  /** null means the percentage is undefined (a zero limit), not 0% used. */
  state: "ACTIVE" | "WARNED_80" | "WARNED_90" | "QUOTA_EXCEEDED" | "DISABLED";
  exceededAt: Date | null;
  resetAt: Date | null;
  period: string;
}

function evaluateQuota(input: {
  id: string;
  label: string;
  scope: string;
  scopeRefId: string | null;
  limitBytes: bigint;
  usedBytes: bigint;
  enabled: boolean;
  exceededAt: Date | null;
  resetAt: Date | null;
  period: string;
  thresholds: number[];
}): Omit<QuotaEvaluation, "quotaId"> & { quotaId: string } {
  const percent = quotaPercent(input.usedBytes, input.limitBytes);

  let state: QuotaEvaluation["state"] = "ACTIVE";
  if (!input.enabled) state = "DISABLED";
  else if (input.exceededAt) state = "QUOTA_EXCEEDED";
  else if (percent !== null) {
    if (percent >= 100) state = "QUOTA_EXCEEDED";
    else if (percent >= (input.thresholds[1] ?? 90)) state = "WARNED_90";
    else if (percent >= (input.thresholds[0] ?? 80)) state = "WARNED_80";
  }

  const remaining = input.limitBytes - input.usedBytes;

  return {
    quotaId: input.id,
    scope: input.scope,
    scopeRefId: input.scopeRefId,
    label: input.label,
    limitBytes: input.limitBytes,
    usedBytes: input.usedBytes,
    remainingBytes: remaining > 0 ? remaining : 0n,
    percent,
    state,
    exceededAt: input.exceededAt,
    resetAt: input.resetAt,
    period: input.period,
  };
}

/**
 * Adds observed bytes to every quota that covers a device, then evaluates each one.
 *
 * Called from the traffic ingest path, so it is deliberately a small number of
 * targeted queries rather than a broad scan: a data plane pushing 50 batches per
 * second must not turn quota checking into the bottleneck.
 */
export async function recordUsage(input: {
  deviceId: string;
  uploadBytes: bigint;
  downloadBytes: bigint;
  nodeId?: string | null;
  userId?: string | null;
  configId?: string | null;
}): Promise<QuotaEvaluation[]> {
  const total = input.uploadBytes + input.downloadBytes;
  if (total <= 0n) return [];

  const warnSettings = await getSettings([
    "quota.warnThresholds",
    "quota.enforcementEnabled",
    "quota.graceBytes",
  ]);
  const warnThresholds = (warnSettings["quota.warnThresholds"] as number[]) ?? [80, 90];
  const enforcementEnabled = warnSettings["quota.enforcementEnabled"] as boolean;
  const graceBytes = BigInt(warnSettings["quota.graceBytes"] as number);

  const quotas = await prisma.quota.findMany({
    where: {
      enabled: true,
      OR: [
        { scope: "DEVICE", scopeRefId: input.deviceId },
        ...(input.userId ? [{ scope: "USER" as const, scopeRefId: input.userId }] : []),
        ...(input.configId ? [{ scope: "CONFIG" as const, scopeRefId: input.configId }] : []),
        ...(input.nodeId ? [{ scope: "NODE" as const, scopeRefId: input.nodeId }] : []),
        // `system` sentinel: a compound unique key cannot be keyed on NULL.
        { scope: "SYSTEM", scopeRefId: "system" },
      ],
    },
    include: { device: { select: { id: true, deviceId: true, approvalState: true } } },
  });

  if (quotas.length === 0) return [];

  const evaluations: QuotaEvaluation[] = [];

  for (const quota of quotas) {
    const updated = await prisma.quota.update({
      where: { id: quota.id },
      data: {
        usedBytes: { increment: total },
        lastEvaluatedAt: new Date(),
      },
    });

    const evaluation = evaluateQuota({
      id: updated.id,
      label: updated.label,
      scope: updated.scope,
      scopeRefId: updated.scopeRefId,
      limitBytes: updated.limitBytes,
      usedBytes: updated.usedBytes,
      enabled: updated.enabled,
      exceededAt: updated.exceededAt,
      resetAt: updated.resetAt,
      period: updated.period,
      thresholds: warnThresholds,
    });
    evaluations.push(evaluation);

    if (evaluation.state === "QUOTA_EXCEEDED" && !updated.exceededAt) {
      if (!enforcementEnabled) {
        logger.warn("quota exceeded but enforcement is disabled", { quotaId: quota.id });
      } else {
        await enforceHardLimit({
          quotaId: quota.id,
          deviceId: input.deviceId,
          nodeId: input.nodeId ?? null,
          evaluation,
          graceBytes,
        });
      }
    } else if (
      (evaluation.state === "WARNED_80" || evaluation.state === "WARNED_90") &&
      !isWarned(evaluation.state, updated)
    ) {
      await raiseWarning(evaluation, updated, input.deviceId);
    }
  }

  return evaluations;
}

function isWarned(
  state: QuotaEvaluation["state"],
  quota: { warned80At: Date | null; warned90At: Date | null },
): boolean {
  if (state === "WARNED_80") return quota.warned80At !== null;
  if (state === "WARNED_90") return quota.warned90At !== null;
  return true;
}

/** Persists the advisory state at the data plane and tells the console about it. */
async function raiseWarning(
  evaluation: QuotaEvaluation,
  quota: { id: string; warned80At: Date | null; warned90At: Date | null },
  deviceId: string,
): Promise<void> {
  const now = new Date();
  const isNinety = evaluation.state === "WARNED_90";
  const alreadyRaised = isNinety ? quota.warned90At : quota.warned80At;
  if (alreadyRaised) return;

  await prisma.quota.update({
    where: { id: quota.id },
    data: isNinety ? { warned90At: now } : { warned80At: now },
  });

  const percent = evaluation.percent ?? 0;
  await notify({
    type: "quota.warning",
    severity: evaluation.state === "WARNED_90" ? "WARNING" : "INFO",
    title: `Quota ${Math.round(percent)}% used`,
    body: `${evaluation.label} has used ${percent.toFixed(1)}% of its ${evaluation.period.toLowerCase()} limit.`,
    resource: "quota",
    resourceId: quota.id,
  });

  publish("quota.update", {
    ts: now.getTime(),
    deviceId,
    // Narrow explicitly: this path only ever raises advisory thresholds, and the
    // realtime event type has no DISABLED/BLOCKED variants.
    state: evaluation.state === "WARNED_90" ? "WARNED_90" : "WARNED_80",
    percent: evaluation.percent,
    usedBytes: evaluation.usedBytes.toString(),
    limitBytes: evaluation.limitBytes.toString(),
  });
}

/**
 * Executes the hard limit. Everything except the final notification happens inside
 * one transaction, so the console can never observe a half-enforced state (device
 * marked blocked but the gateway still allowed, or vice versa).
 */
export async function enforceHardLimit(input: {
  quotaId: string;
  deviceId: string;
  nodeId: string | null;
  evaluation: QuotaEvaluation;
  graceBytes: bigint;
}): Promise<void> {
  const { quotaId, deviceId, nodeId, evaluation, graceBytes } = input;
  const now = new Date();
  const reason = `Quota exceeded: ${evaluation.usedBytes.toString()} of ${evaluation.limitBytes.toString()} bytes used`;

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Quota state.
      await tx.quota.update({
        where: { id: quotaId },
        data: { exceededAt: now },
      });

      // 2. Device state: the console must show the breach immediately.
      await tx.device.update({
        where: { id: deviceId },
        data: { connectionStatus: "QUOTA_EXCEEDED", quotaExceededAt: now },
      });

      // 3. Close live sessions with an explicit reason, so session history explains
      //    why the tunnel dropped instead of just stopping.
      await tx.vpnSession.updateMany({
        where: { deviceId, endedAt: null },
        data: { endedAt: now, endReason: "QUOTA_EXCEEDED" },
      });

      // 4. The data-plane contract. `revision` bumps so an agent that already pulled
      //    this row can tell there is a newer decision. A compound `upsert` cannot be
      //    used here because `nodeId` may be NULL and Postgres treats NULLs in a
      //    unique index as distinct, which would silently create duplicate rows.
      const existingPolicy = await tx.gatewayPolicyState.findFirst({
        where: { deviceId, nodeId },
        orderBy: { revision: "desc" },
      });

      if (existingPolicy) {
        await tx.gatewayPolicyState.update({
          where: { id: existingPolicy.id },
          data: {
            state: "QUOTA_EXCEEDED",
            reason,
            revision: { increment: 1 },
            appliedAt: null,
            ackedAt: null,
          },
        });
      } else {
        await tx.gatewayPolicyState.create({
          data: { deviceId, nodeId, state: "QUOTA_EXCEEDED", reason, revision: 1 },
        });
      }

      // 5. Audit inside the same transaction: an enforcement action without a trail
      //    is worse than a failed enforcement action.
      await recordWithin(tx, {
        actor: { type: "SYSTEM", id: null, label: "quota-engine" },
        action: "quota.exceeded",
        resource: "quota",
        resourceId: quotaId,
        result: "SUCCESS",
        metadata: {
          device: deviceId,
          quota: quotaId,
          used: evaluation.usedBytes.toString(),
          limit: evaluation.limitBytes.toString(),
          percent: evaluation.percent,
          node: nodeId,
          action: "session_revoked_and_reconnect_blocked",
          graceBytes: graceBytes.toString(),
          timestamp: now.toISOString(),
        },
      });
    });
  } catch (error) {
    logger.error("quota enforcement failed", { quotaId, deviceId, error });
    throw errors.internal("Quota enforcement could not be applied.", error);
  }

  // Post-commit: out-of-band effects that must not risk the rollback of step 1-5.
  publish("quota.update", {
    ts: now.getTime(),
    deviceId,
    state: "QUOTA_EXCEEDED",
    percent: evaluation.percent,
    usedBytes: evaluation.usedBytes.toString(),
    limitBytes: evaluation.limitBytes.toString(),
  });

  await notify({
    type: "quota.exceeded",
    severity: "WARNING",
    title: "Quota exceeded",
    body: `${evaluation.label} reached its limit. The active session was revoked and reconnection is blocked at the gateway.`,
    resource: "quota",
    resourceId: quotaId,
  });

  logger.warn("quota hard limit enforced", {
    quotaId,
    deviceId,
    nodeId,
    used: evaluation.usedBytes.toString(),
    limit: evaluation.limitBytes.toString(),
  });
}

// ------------------------------------------------------------ admin ops -----

export interface QuotaView extends QuotaEvaluation {
  deviceLabel: string | null;
  /** Which advisory thresholds this quota has already raised this period. */
  warned80At: Date | null;
  warned90At: Date | null;
}

/** Lists every quota with allocated/used/remaining and its derived state. */
export async function listQuotas(filters?: {
  scope?: string;
  exceededOnly?: boolean;
}): Promise<QuotaView[]> {
  const warnSettings = await getSettings(["quota.warnThresholds"]);
  const thresholds = (warnSettings["quota.warnThresholds"] as number[]) ?? [80, 90];

  const rows = await prisma.quota.findMany({
    where: {
      ...(filters?.scope ? { scope: filters.scope as never } : {}),
      ...(filters?.exceededOnly ? { exceededAt: { not: null } } : {}),
    },
    orderBy: [{ scope: "asc" }, { label: "asc" }],
    include: { device: { select: { displayName: true } } },
  });

  return rows.map((row) => ({
    ...evaluateQuota({
      id: row.id,
      label: row.label,
      scope: row.scope,
      scopeRefId: row.scopeRefId,
      limitBytes: row.limitBytes,
      usedBytes: row.usedBytes,
      enabled: row.enabled,
      exceededAt: row.exceededAt,
      resetAt: row.resetAt,
      period: row.period,
      thresholds,
    }),
    deviceLabel: row.device?.displayName ?? null,
    warned80At: row.warned80At,
    warned90At: row.warned90At,
  }));
}

/**
 * Creates or replaces a quota for a scope, auditing the change.
 *
 * Lowering a limit below current usage does NOT silently re-trigger enforcement here;
 * it takes effect on the next `recordUsage` evaluation, so exactly one code path can
 * ever decide to block a device.
 */
export async function setQuota(input: {
  scope: "SYSTEM" | "USER" | "DEVICE" | "CONFIG" | "NODE";
  scopeRefId: string | null;
  label: string;
  limitBytes: bigint;
  period: "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
  resetPolicy?: "AUTO" | "MANUAL";
  resetAt?: Date | null;
  enabled?: boolean;
  graceBytes?: bigint;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<string> {
  if (input.limitBytes < 0n) {
    throw errors.validation("A quota limit cannot be negative.");
  }

  // A compound unique index treats NULL as distinct in Postgres, so a SYSTEM row
  // keyed on (SYSTEM, NULL) would be duplicated on every upsert. The sentinel keeps
  // the key stable instead.
  if (input.scope !== "SYSTEM" && !input.scopeRefId) {
    throw errors.validation(`A ${input.scope} quota needs a scope reference id.`);
  }
  // NULL is impossible here: SYSTEM uses the "system" sentinel and every other scope
  // is validated above, which is what the compound-unique key type requires.
  const scopeRefId: string = input.scope === "SYSTEM" ? "system" : input.scopeRefId!;

  const quota = await prisma.quota.upsert({
    where: { scope_scopeRefId: { scope: input.scope, scopeRefId } },
    create: {
      scope: input.scope,
      scopeRefId,
      label: input.label,
      limitBytes: input.limitBytes,
      period: input.period,
      resetPolicy: input.resetPolicy ?? "MANUAL",
      resetAt: input.resetAt ?? null,
      periodStart: new Date(),
      enabled: input.enabled ?? true,
      graceBytes: input.graceBytes ?? 0n,
      deviceId: input.scope === "DEVICE" ? input.scopeRefId : null,
      nodeId: input.scope === "NODE" ? input.scopeRefId : null,
      configId: input.scope === "CONFIG" ? input.scopeRefId : null,
    },
    update: {
      label: input.label,
      limitBytes: input.limitBytes,
      period: input.period,
      resetPolicy: input.resetPolicy ?? "MANUAL",
      resetAt: input.resetAt ?? null,
      enabled: input.enabled ?? true,
      graceBytes: input.graceBytes ?? 0n,
    },
  });

  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: "quota.updated",
    resource: "quota",
    resourceId: quota.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: {
      scope: input.scope,
      scopeRefId,
      limitBytes: input.limitBytes.toString(),
      period: input.period,
    },
  });

  return quota.id;
}

/**
 * Resets usage to zero and, when the quota had been enforced, releases the device:
 * clears `exceededAt`, clears the device's QUOTA_EXCEEDED state and flips the
 * gateway policy back to ACTIVE so the agent allows the handshake again.
 *
 * Clearing the policy is part of the same transaction on purpose: an operator who
 * resets a quota obviously wants the device working again, and a forgotten policy row
 * would leave it blocked with no visible reason anywhere in the console.
 */
export async function resetQuota(input: {
  quotaId: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const quota = await prisma.quota.findUnique({ where: { id: input.quotaId } });
  if (!quota) throw errors.notFound("Quota");

  await prisma.$transaction(async (tx) => {
    await tx.quota.update({
      where: { id: quota.id },
      data: {
        usedBytes: 0n,
        exceededAt: null,
        warned80At: null,
        warned90At: null,
        lastEvaluatedAt: null,
        periodStart: new Date(),
      },
    });

    if (quota.deviceId) {
      await tx.device.update({
        where: { id: quota.deviceId },
        data: { connectionStatus: "OFFLINE", quotaExceededAt: null },
      });

      const policies = await tx.gatewayPolicyState.findMany({
        where: { deviceId: quota.deviceId, state: { in: ["QUOTA_EXCEEDED", "BLOCKED"] } },
      });
      for (const policy of policies) {
        await tx.gatewayPolicyState.update({
          where: { id: policy.id },
          data: {
            state: "ACTIVE",
            reason: "Quota reset by operator",
            revision: { increment: 1 },
            appliedAt: null,
            ackedAt: null,
          },
        });
      }
    }

    await recordWithin(tx, {
      actor: userActor(input.actorId, input.actorLabel),
      action: "quota.reset",
      resource: "quota",
      resourceId: quota.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp,
      metadata: {
        scope: quota.scope,
        scopeRefId: quota.scopeRefId,
        previousUsed: quota.usedBytes.toString(),
        clearedBlock: Boolean(quota.deviceId),
      },
    });
  });
}

/** Clears an operator- or system-imposed block without touching quota usage. */
export async function unblockDevice(input: {
  deviceId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: input.deviceId },
      data: {
        connectionStatus: "OFFLINE",
        blockedAt: null,
        blockedReason: null,
        quotaExceededAt: null,
        securityState: "NORMAL",
      },
    });

    const policies = await tx.gatewayPolicyState.findMany({
      where: { deviceId: input.deviceId, state: { in: ["QUOTA_EXCEEDED", "BLOCKED", "REVOKED"] } },
    });
    for (const policy of policies) {
      await tx.gatewayPolicyState.update({
        where: { id: policy.id },
        data: {
          state: "ACTIVE",
          reason: input.reason,
          revision: { increment: 1 },
          appliedAt: null,
          ackedAt: null,
        },
      });
    }

    await recordWithin(tx, {
      actor: userActor(input.actorId, input.actorLabel),
      action: "device.unblocked",
      resource: "device",
      resourceId: input.deviceId,
      result: "SUCCESS",
      sourceIp: input.sourceIp,
      metadata: { reason: input.reason, policiesCleared: policies.length },
    });
  });
}
