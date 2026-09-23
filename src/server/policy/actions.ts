import "server-only";
import { prisma } from "@/server/db/client";
import type { Prisma } from "@prisma/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { notify } from "@/server/notifications/service";
import { publishDomain } from "@/server/events/dispatch";
import { recordTimelineEvent } from "@/server/timeline/service";
import { parseActionParams, type PolicyActionKeyLiteral } from "@/server/policy/schema";
import type { PolicyTarget } from "@/server/policy/metrics";

/**
 * The action registry.
 *
 * A policy cannot say "run this". It can only name one of the keys below, and each key
 * maps to one hand-written handler with a typed parameter object. That is the design's
 * answer to "do not turn this into an unsafe arbitrary code execution system": there is
 * no expression language, no script field, no shell, no SQL and no free-form URL anywhere
 * in the policy surface.
 *
 * Handlers are written so that the state they change is always observable elsewhere:
 * a disconnect closes sessions AND bumps the gateway policy revision, a node action
 * updates the node AND publishes a domain event. Nothing is a silent flag flip.
 */

export interface ActionContext {
  policyId: string;
  policyName: string;
  target: PolicyTarget;
  /** Raw params from the stored policy; validated inside each handler. */
  params: Record<string, unknown>;
  metric: string;
  observed: number | null;
  threshold: number | null;
  evidence: Record<string, unknown>;
  /** Set when the engine is running in dry-run mode: handlers must not mutate state. */
  dryRun: boolean;
}

export interface ActionResult {
  /** False when the action found the work already done (a no-op, not a failure). */
  applied: boolean;
  detail: string;
  data?: Record<string, unknown>;
}

function requireDeviceId(target: PolicyTarget): string {
  if (target.kind !== "DEVICE" || !target.id) {
    throw errors.validation("This action can only run against a device.");
  }
  return target.id;
}

function requireNodeId(target: PolicyTarget): string {
  if (target.kind !== "NODE" || !target.id) {
    throw errors.validation("This action can only run against a node.");
  }
  return target.id;
}

async function notifyPolicy(input: {
  severity: "INFO" | "LOW" | "MEDIUM" | "HIGH" | "WARNING" | "CRITICAL";
  message: string;
  policyId: string;
  policyName: string;
  target: PolicyTarget;
  metric: string;
  observed: number | null;
  threshold: number | null;
  dryRun: boolean;
}): Promise<ActionResult> {
  if (input.dryRun) return { applied: false, detail: "Dry run: no notification sent." };

  const observedText = input.observed === null ? "unavailable" : input.observed.toFixed(2);
  const thresholdText = input.threshold === null ? "unavailable" : String(input.threshold);

  await notify({
    type: "policy.triggered",
    severity: input.severity,
    title: `Policy: ${input.policyName}`,
    body: `${input.message} Target ${input.target.label}; ${input.metric} observed ${observedText} vs threshold ${thresholdText}.`,
    resource: "policy",
    resourceId: input.policyId,
  });
  return { applied: true, detail: "Notification created.", data: { severity: input.severity } };
}

async function handlerNotify(ctx: ActionContext): Promise<ActionResult> {
  const params = parseActionParams("NOTIFY", ctx.params);
  return notifyPolicy({
    severity: params.severity,
    message: params.message ?? `Threshold ${ctx.metric} met.`,
    policyId: ctx.policyId,
    policyName: ctx.policyName,
    target: ctx.target,
    metric: ctx.metric,
    observed: ctx.observed,
    threshold: ctx.threshold,
    dryRun: ctx.dryRun,
  });
}

async function handlerQuotaWarning(ctx: ActionContext): Promise<ActionResult> {
  const params = parseActionParams("QUOTA_WARNING", ctx.params);
  return notifyPolicy({
    severity: params.severity,
    message: params.message ?? "Quota threshold reached.",
    policyId: ctx.policyId,
    policyName: ctx.policyName,
    target: ctx.target,
    metric: ctx.metric,
    observed: ctx.observed,
    threshold: ctx.threshold,
    dryRun: ctx.dryRun,
  });
}

async function handlerDisconnectSession(ctx: ActionContext): Promise<ActionResult> {
  const deviceId = requireDeviceId(ctx.target);
  const params = parseActionParams("DISCONNECT_SESSION", ctx.params);

  const open = await prisma.vpnSession.count({ where: { deviceId, endedAt: null } });
  if (open === 0) return { applied: false, detail: "No open session to disconnect.", data: { sessionsClosed: 0 } };
  if (ctx.dryRun) return { applied: true, detail: `Would close ${open} session(s).`, data: { sessionsClosed: open, dryRun: true } };

  await prisma.$transaction(async (tx) => {
    await tx.vpnSession.updateMany({
      where: { deviceId, endedAt: null },
      data: { endedAt: new Date(), endReason: "REVOKED" },
    });
    const device = await tx.device.update({
      where: { id: deviceId },
      data: { connectionStatus: params.allowReconnect ? "OFFLINE" : "REVOKED" },
    });
    const states = await tx.gatewayPolicyState.findMany({ where: { deviceId } });
    for (const state of states) {
      await tx.gatewayPolicyState.update({
        where: { id: state.id },
        data: {
          state: params.allowReconnect ? "ACTIVE" : "BLOCKED",
          reason: params.reason,
          revision: { increment: 1 },
          appliedAt: null,
          ackedAt: null,
        },
      });
    }
    void device;
  });

  await notify({
    type: "policy.triggered",
    severity: "HIGH",
    title: "Session disconnected by policy",
    body: `${ctx.target.label}: ${params.reason}. Reconnect ${params.allowReconnect ? "allowed" : "blocked"}.`,
    resource: "device",
    resourceId: deviceId,
  });

  return {
    applied: true,
    detail: `${open} session(s) closed; reconnect ${params.allowReconnect ? "allowed" : "blocked"}.`,
    data: { sessionsClosed: open, allowReconnect: params.allowReconnect, reason: params.reason },
  };
}

async function handlerBlockReconnect(ctx: ActionContext): Promise<ActionResult> {
  const deviceId = requireDeviceId(ctx.target);
  const params = parseActionParams("BLOCK_DEVICE_RECONNECT", ctx.params);

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { blockedAt: true } });
  if (!device) throw errors.notFound("Device");
  if (device.blockedAt) return { applied: false, detail: "Device is already blocked.", data: { blocked: true } };
  if (ctx.dryRun) return { applied: true, detail: "Would block reconnect for this device.", data: { dryRun: true } };

  await prisma.$transaction(async (tx) => {
    await tx.vpnSession.updateMany({ where: { deviceId, endedAt: null }, data: { endedAt: new Date(), endReason: "REVOKED" } });
    await tx.device.update({
      where: { id: deviceId },
      data: { blockedAt: new Date(), blockedReason: params.reason, connectionStatus: "OFFLINE" },
    });
    const states = await tx.gatewayPolicyState.findMany({ where: { deviceId } });
    for (const state of states) {
      await tx.gatewayPolicyState.update({
        where: { id: state.id },
        data: { state: "BLOCKED", reason: params.reason, revision: { increment: 1 }, appliedAt: null, ackedAt: null },
      });
    }
  });

  await notify({
    type: "policy.triggered",
    severity: "CRITICAL",
    title: "Device blocked by policy",
    body: `${ctx.target.label}: ${params.reason}. Reconnect is blocked until an operator clears it.`,
    resource: "device",
    resourceId: deviceId,
  });

  return { applied: true, detail: `Blocked: ${params.reason}`, data: { reason: params.reason } };
}

async function handlerMarkNodeDegraded(ctx: ActionContext): Promise<ActionResult> {
  const nodeId = requireNodeId(ctx.target);
  const params = parseActionParams("MARK_NODE_DEGRADED", ctx.params);

  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId }, select: { health: true, name: true } });
  if (!node) throw errors.notFound("VPN node");
  if (node.health === "DEGRADED" || node.health === "OFFLINE") {
    return { applied: false, detail: `Node health is already ${node.health}.`, data: { health: node.health } };
  }
  if (ctx.dryRun) return { applied: true, detail: `Would mark ${node.name} DEGRADED.`, data: { dryRun: true } };

  await prisma.vpnNode.update({ where: { id: nodeId }, data: { health: "DEGRADED" } });

  await publishDomain("node.degraded", {
    ts: Date.now(),
    nodeId,
    nodeLabel: node.name,
    from: node.health,
    to: "DEGRADED",
    reason: `${params.reason} (policy ${ctx.policyName})`,
    lastHeartbeatAt: null,
  });

  await record({
    actor: { type: "SYSTEM", id: null, label: "policy engine" },
    action: "node.routing_priority_changed",
    resource: "vpn_node",
    resourceId: nodeId,
    result: "SUCCESS",
    metadata: { policyId: ctx.policyId, change: "health=DEGRADED", from: node.health, reason: params.reason },
  });

  return { applied: true, detail: `Marked DEGRADED: ${params.reason}`, data: { from: node.health } };
}

async function handlerLowerRoutingPriority(ctx: ActionContext): Promise<ActionResult> {
  const nodeId = requireNodeId(ctx.target);
  const params = parseActionParams("LOWER_NODE_ROUTING_PRIORITY", ctx.params);

  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId }, select: { weight: true, name: true } });
  if (!node) throw errors.notFound("VPN node");
  const next = Math.max(0, node.weight - params.weightDelta);
  if (next === node.weight) return { applied: false, detail: "Routing weight is already at zero.", data: { weight: node.weight } };
  if (ctx.dryRun) return { applied: true, detail: `Would lower weight ${node.weight} → ${next}.`, data: { dryRun: true } };

  await prisma.vpnNode.update({ where: { id: nodeId }, data: { weight: next } });
  await record({
    actor: { type: "SYSTEM", id: null, label: "policy engine" },
    action: "node.routing_priority_changed",
    resource: "vpn_node",
    resourceId: nodeId,
    result: "SUCCESS",
    metadata: { policyId: ctx.policyId, from: node.weight, to: next, reason: params.reason, observed: ctx.observed, threshold: ctx.threshold },
  });

  return { applied: true, detail: `Routing weight ${node.weight} → ${next}.`, data: { from: node.weight, to: next } };
}

async function handlerStopNewAssignments(ctx: ActionContext): Promise<ActionResult> {
  const nodeId = requireNodeId(ctx.target);
  const params = parseActionParams("STOP_NEW_ASSIGNMENTS", ctx.params);

  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId }, select: { name: true, poolPolicy: { select: { enabled: true } } } });
  if (!node) throw errors.notFound("VPN node");
  if (node.poolPolicy && !node.poolPolicy.enabled) {
    return { applied: false, detail: "Node already excluded from new assignments.", data: { assigning: false } };
  }
  if (ctx.dryRun) return { applied: true, detail: `Would stop assigning new sessions to ${node.name}.`, data: { dryRun: true } };

  await prisma.nodePoolPolicy.upsert({
    where: { nodeId },
    create: { nodeId, enabled: false },
    update: { enabled: false },
  });

  await recordTimelineEvent({
    type: "NODE_HEALTH_CHANGED",
    nodeId,
    severity: "MEDIUM",
    actor: "POLICY",
    actorLabel: ctx.policyName,
    reason: `${params.reason} New sessions will not be assigned; existing sessions continue.`,
    metadata: { change: "poolPolicy.enabled=false", observed: ctx.observed, threshold: ctx.threshold },
    dedupeParts: [nodeId, "stop_assignments", ctx.policyId],
  });

  return { applied: true, detail: "New session assignments stopped; existing sessions preserved.", data: { assigning: false } };
}

async function handlerCreateAnomaly(ctx: ActionContext): Promise<ActionResult> {
  const params = parseActionParams("CREATE_ANOMALY_EVENT", ctx.params);
  const deviceId = ctx.target.kind === "DEVICE" ? ctx.target.id : null;
  const nodeId = ctx.target.kind === "NODE" ? ctx.target.id : null;
  const dedupeKey = `${ctx.policyId}:${ctx.target.kind}:${ctx.target.id ?? "system"}:${params.anomalyType}`;

  const existing = await prisma.anomalyEvent.findFirst({ where: { dedupeKey, status: "OPEN" } });
  if (existing) return { applied: false, detail: "An identical anomaly is already open.", data: { anomalyId: existing.id } };
  if (ctx.dryRun) return { applied: true, detail: `Would raise a ${params.anomalyType} anomaly.`, data: { dryRun: true } };

  const observedText = ctx.observed === null ? "unavailable" : ctx.observed.toFixed(2);
  const thresholdText = ctx.threshold === null ? "unavailable" : String(ctx.threshold);

  const created = await prisma.anomalyEvent.create({
    data: {
      type: params.anomalyType,
      severity: params.severity,
      nodeId,
      deviceId,
      label: params.label,
      // Neutral wording is enforced here: the summary states an observation, never blame.
      summary: `Unusual traffic pattern detected: ${ctx.metric} was ${observedText} against a threshold of ${thresholdText}.`,
      metrics: {
        policyId: ctx.policyId,
        policyName: ctx.policyName,
        metric: ctx.metric,
        observed: ctx.observed,
        threshold: ctx.threshold,
        evidence: ctx.evidence,
      } as unknown as Prisma.InputJsonValue,
      dedupeKey,
    },
  });

  await publishDomain("traffic.anomaly", {
    ts: Date.now(),
    anomalyId: created.id,
    anomalyType: params.anomalyType,
    severity: params.severity,
    deviceId,
    nodeId,
    label: params.label,
    summary: created.summary,
  });

  await notify({
    type: "anomaly.detected",
    severity: params.severity === "CRITICAL" ? "CRITICAL" : "WARNING",
    title: "Unusual traffic pattern detected",
    body: created.summary,
    resource: "anomaly",
    resourceId: created.id,
  });

  return { applied: true, detail: `Anomaly ${created.id} created.`, data: { anomalyId: created.id } };
}

async function handlerApplyOptimization(ctx: ActionContext): Promise<ActionResult> {
  const deviceId = requireDeviceId(ctx.target);
  const params = parseActionParams("APPLY_OPTIMIZATION_PROFILE", ctx.params);

  const [profile, device] = await Promise.all([
    prisma.optimizationProfile.findUnique({ where: { key: params.profileKey } }),
    prisma.device.findUnique({ where: { id: deviceId }, select: { optimizationProfileId: true, displayName: true } }),
  ]);
  if (!profile) throw errors.notFound(`Optimization profile ${params.profileKey}`);
  if (!device) throw errors.notFound("Device");
  if (device.optimizationProfileId === profile.id) {
    return { applied: false, detail: `Already using ${params.profileKey}.`, data: { profileKey: params.profileKey } };
  }
  if (ctx.dryRun) return { applied: true, detail: `Would apply ${params.profileKey}.`, data: { dryRun: true } };

  await prisma.device.update({ where: { id: deviceId }, data: { optimizationProfileId: profile.id } });

  await publishDomain("optimization.completed", {
    ts: Date.now(),
    deviceId,
    nodeId: null,
    profileKey: params.profileKey,
    measurementKind: "ESTIMATED",
    savedBytes: null,
    savingPct: null,
  });

  await notify({
    type: "optimization.changed",
    severity: "INFO",
    title: "Optimization profile changed",
    body: `${device.displayName} → ${params.profileKey} (policy ${ctx.policyName}). Savings figures are reported separately as measured or estimated.`,
    resource: "device",
    resourceId: deviceId,
  });

  return { applied: true, detail: `Applied ${params.profileKey}.`, data: { profileKey: params.profileKey } };
}

async function handlerDrainNode(ctx: ActionContext): Promise<ActionResult> {
  const nodeId = requireNodeId(ctx.target);
  const params = parseActionParams("DRAIN_NODE", ctx.params);

  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId }, select: { name: true, draining: true } });
  if (!node) throw errors.notFound("VPN node");

  const openSessions = await prisma.vpnSession.count({ where: { nodeId, endedAt: null } });
  if (node.draining && openSessions === 0) {
    return { applied: false, detail: "Node is already drained and empty.", data: { remainingSessions: 0 } };
  }
  if (ctx.dryRun) {
    return { applied: true, detail: `Would drain ${node.name} with ${openSessions} session(s) open.`, data: { dryRun: true, remainingSessions: openSessions } };
  }

  if (params.disconnectExisting && openSessions > 0) {
    // Only ever when the policy states it explicitly - never as a side effect of draining.
    await prisma.vpnSession.updateMany({
      where: { nodeId, endedAt: null },
      data: { endedAt: new Date(), endReason: "NODE_DRAINED" },
    });
  }

  await prisma.$transaction([
    prisma.vpnNode.update({ where: { id: nodeId }, data: { draining: true } }),
    prisma.nodePoolPolicy.upsert({ where: { nodeId }, create: { nodeId, enabled: false }, update: { enabled: false } }),
  ]);

  const remaining = params.disconnectExisting ? 0 : openSessions;

  await publishDomain("node.draining", {
    ts: Date.now(),
    nodeId,
    nodeLabel: node.name,
    remainingSessions: remaining,
    safeToRestart: remaining === 0,
    reason: `${params.reason} (policy ${ctx.policyName})`,
  });

  await record({
    actor: { type: "SYSTEM", id: null, label: "policy engine" },
    action: "node.drain_started",
    resource: "vpn_node",
    resourceId: nodeId,
    result: "SUCCESS",
    metadata: { policyId: ctx.policyId, remainingSessions: remaining, disconnectExisting: params.disconnectExisting, reason: params.reason },
  });

  return {
    applied: true,
    detail: `Draining; ${remaining} session(s) remaining.`,
    data: { remainingSessions: remaining, disconnectExisting: params.disconnectExisting },
  };
}

async function handlerSecurityReview(ctx: ActionContext): Promise<ActionResult> {
  const deviceId = requireDeviceId(ctx.target);
  const params = parseActionParams("SET_DEVICE_SECURITY_REVIEW", ctx.params);

  const device = await prisma.device.findUnique({ where: { id: deviceId }, select: { securityState: true, displayName: true } });
  if (!device) throw errors.notFound("Device");
  if (device.securityState === "REVIEW" || device.securityState === "LOCKED") {
    return { applied: false, detail: `Already in ${device.securityState}.`, data: { securityState: device.securityState } };
  }
  if (ctx.dryRun) return { applied: true, detail: "Would flag for review.", data: { dryRun: true } };

  await prisma.device.update({ where: { id: deviceId }, data: { securityState: "REVIEW" } });

  await recordTimelineEvent({
    type: "SECURITY_EVENT",
    deviceId,
    severity: "MEDIUM",
    actor: "POLICY",
    actorLabel: ctx.policyName,
    // Neutral: the device was flagged for an operator to look at, not accused.
    reason: `${params.reason} Flagged for operator review.`,
    metadata: { from: device.securityState, to: "REVIEW", observed: ctx.observed, threshold: ctx.threshold },
    dedupeParts: [deviceId, "security_review", ctx.policyId],
  });

  return { applied: true, detail: "Flagged for operator review.", data: { securityState: "REVIEW" } };
}

async function handlerRequestReport(ctx: ActionContext): Promise<ActionResult> {
  const params = parseActionParams("REQUEST_REPORT", ctx.params);
  if (ctx.dryRun) return { applied: true, detail: `Would generate a ${params.reportType} report.`, data: { dryRun: true } };

  const { generateReport } = await import("@/server/reports/service");
  const report = await generateReport({
    type: params.reportType,
    format: "JSON",
    actorId: null,
    actorLabel: `policy:${ctx.policyName}`,
  });

  return {
    applied: true,
    detail: `Report generated (${report.sectionCount} section(s), ${report.byteLength} bytes).`,
    data: { reportId: report.id, sections: report.sectionNames },
  };
}

const HANDLERS: Record<PolicyActionKeyLiteral, (ctx: ActionContext) => Promise<ActionResult>> = {
  NOTIFY: handlerNotify,
  QUOTA_WARNING: handlerQuotaWarning,
  DISCONNECT_SESSION: handlerDisconnectSession,
  BLOCK_DEVICE_RECONNECT: handlerBlockReconnect,
  MARK_NODE_DEGRADED: handlerMarkNodeDegraded,
  LOWER_NODE_ROUTING_PRIORITY: handlerLowerRoutingPriority,
  STOP_NEW_ASSIGNMENTS: handlerStopNewAssignments,
  CREATE_ANOMALY_EVENT: handlerCreateAnomaly,
  APPLY_OPTIMIZATION_PROFILE: handlerApplyOptimization,
  DRAIN_NODE: handlerDrainNode,
  SET_DEVICE_SECURITY_REVIEW: handlerSecurityReview,
  REQUEST_REPORT: handlerRequestReport,
};

/** UI-facing description of every action, served by GET /api/policies/registry. */
export const ACTION_CATALOG = [
  { key: "NOTIFY", label: "Create a notification", mutating: false, targets: ["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"] },
  { key: "QUOTA_WARNING", label: "Raise a quota warning", mutating: false, targets: ["DEVICE", "USER", "CONFIG", "NODE", "SYSTEM"] },
  { key: "DISCONNECT_SESSION", label: "Disconnect the active session", mutating: true, targets: ["DEVICE"] },
  { key: "BLOCK_DEVICE_RECONNECT", label: "Disconnect and block reconnect", mutating: true, targets: ["DEVICE"] },
  { key: "MARK_NODE_DEGRADED", label: "Mark node DEGRADED", mutating: true, targets: ["NODE"] },
  { key: "LOWER_NODE_ROUTING_PRIORITY", label: "Lower routing priority", mutating: true, targets: ["NODE"] },
  { key: "STOP_NEW_ASSIGNMENTS", label: "Stop assigning new sessions", mutating: true, targets: ["NODE"] },
  { key: "CREATE_ANOMALY_EVENT", label: "Raise an anomaly for review", mutating: false, targets: ["DEVICE", "NODE"] },
  { key: "APPLY_OPTIMIZATION_PROFILE", label: "Apply an optimization profile", mutating: true, targets: ["DEVICE"] },
  { key: "DRAIN_NODE", label: "Drain the node", mutating: true, targets: ["NODE"] },
  { key: "SET_DEVICE_SECURITY_REVIEW", label: "Flag device for security review", mutating: true, targets: ["DEVICE"] },
  { key: "REQUEST_REPORT", label: "Generate a report", mutating: false, targets: ["SYSTEM", "DEVICE", "USER", "NODE", "CONFIG"] },
] as const;

export async function executeAction(
  key: PolicyActionKeyLiteral,
  ctx: Omit<ActionContext, "params"> & { params: Record<string, unknown> },
): Promise<ActionResult> {
  const handler = HANDLERS[key];
  if (!handler) throw errors.validation(`Unknown policy action "${key}".`);
  return handler(ctx as ActionContext);
}

/**
 * Whether the action's end state is already true for this target. Used by simulation so
 * it can report "1 already exceeded" instead of implying work that would do nothing.
 */
export async function isAlreadySatisfied(
  key: PolicyActionKeyLiteral,
  target: PolicyTarget,
  params: Record<string, unknown>,
): Promise<boolean> {
  try {
    if (key === "BLOCK_DEVICE_RECONNECT" && target.kind === "DEVICE" && target.id) {
      const device = await prisma.device.findUnique({ where: { id: target.id }, select: { blockedAt: true } });
      return Boolean(device?.blockedAt);
    }
    if (key === "DISCONNECT_SESSION" && target.kind === "DEVICE" && target.id) {
      const open = await prisma.vpnSession.count({ where: { deviceId: target.id, endedAt: null } });
      return open === 0;
    }
    if (key === "MARK_NODE_DEGRADED" && target.kind === "NODE" && target.id) {
      const node = await prisma.vpnNode.findUnique({ where: { id: target.id }, select: { health: true } });
      return node?.health === "DEGRADED" || node?.health === "OFFLINE";
    }
    if (key === "DRAIN_NODE" && target.kind === "NODE" && target.id) {
      const node = await prisma.vpnNode.findUnique({ where: { id: target.id }, select: { draining: true } });
      return Boolean(node?.draining);
    }
    if (key === "STOP_NEW_ASSIGNMENTS" && target.kind === "NODE" && target.id) {
      const pool = await prisma.nodePoolPolicy.findUnique({ where: { nodeId: target.id }, select: { enabled: true } });
      return pool !== null && !pool.enabled;
    }
    if (key === "SET_DEVICE_SECURITY_REVIEW" && target.kind === "DEVICE" && target.id) {
      const device = await prisma.device.findUnique({ where: { id: target.id }, select: { securityState: true } });
      return device?.securityState === "REVIEW" || device?.securityState === "LOCKED";
    }
    if (key === "APPLY_OPTIMIZATION_PROFILE" && target.kind === "DEVICE" && target.id) {
      const profileKey = params.profileKey as string | undefined;
      if (!profileKey) return false;
      const device = await prisma.device.findUnique({
        where: { id: target.id },
        select: { optimizationProfile: { select: { key: true } } },
      });
      return device?.optimizationProfile?.key === profileKey;
    }
    if (key === "CREATE_ANOMALY_EVENT") {
      const anomalyType = params.anomalyType as string | undefined;
      if (!anomalyType) return false;
      const existing = await prisma.anomalyEvent.findFirst({
        where: { dedupeKey: `${"draft"}:${target.kind}:${target.id ?? "system"}:${anomalyType}` },
      });
      return Boolean(existing);
    }
  } catch {
    return false;
  }
  return false;
}
