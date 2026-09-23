import "server-only";
import { logger } from "@/server/lib/logger";
import { onDomainEvent } from "@/server/events/bus";
import type { DomainEventMap, DomainEventName } from "@/server/events/types";
import { recordTimelineEvent } from "@/server/timeline/service";
import { publish as publishRealtime, type RealtimeEventMap } from "@/server/realtime/bus";
import { record, systemActor } from "@/server/audit";
import type { NotificationSeverity } from "@prisma/client";
import type { NotificationType } from "@/server/notifications/service";

/**
 * Core subscribers.
 *
 * This is the "EVENT ENGINE" layer of the architecture: one place where a domain fact
 * fans out to the systems that need it, so those systems never have to be imported by
 * the engine that produced the fact.
 *
 *   domain event -> timeline        (searchable history + "WHY?")
 *   domain event -> notifications   (operator attention)
 *   domain event -> realtime bus    (live dashboard, no polling)
 *   domain event -> audit           (only for actions that must be attributable)
 *
 * Registration is idempotent because Next.js dev mode re-evaluates modules: every
 * subscriber is marked on a global flag, and duplicate registrations are skipped rather
 * than producing a second copy of every timeline row.
 *
 * Every handler is wrapped: a throwing subscriber is logged with the event name and
 * dropped. The publisher never sees it. That is deliberate - the quota transaction must
 * not be able to fail because the notification table is unavailable.
 */

declare global {
  // eslint-disable-next-line no-var
  var __vwrayCoreSubscribers: boolean | undefined;
}

function safe<K extends DomainEventName>(name: K, handler: (payload: DomainEventMap[K]) => void) {
  onDomainEvent(name, (payload) => {
    try {
      handler(payload);
    } catch (error) {
      logger.error("domain subscriber threw", { event: name, error });
    }
  });
}

/** Bridges a domain event onto the realtime bus so the dashboard updates without polling. */
function bridge<K extends DomainEventName, R extends keyof RealtimeEventMap>(
  from: K,
  to: R,
  map: (payload: DomainEventMap[K]) => RealtimeEventMap[R] | null,
) {
  onDomainEvent(from, (payload) => {
    try {
      const value = map(payload);
      if (value) publishRealtime(to, value);
    } catch (error) {
      logger.error("realtime bridge threw", { event: from, error });
    }
  });
}

export function registerCoreSubscribers(): void {
  if (globalThis.__vwrayCoreSubscribers) return;
  globalThis.__vwrayCoreSubscribers = true;

  // ------------------------------------------------------------ timeline ----

  safe("device.connected", (payload) =>
    recordTimelineEvent({
      type: "DEVICE_CONNECTED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      nodeId: payload.nodeId,
      sessionId: payload.sessionId,
      actor: "GATEWAY",
      actorLabel: payload.nodeLabel,
      reason: payload.nodeLabel ? `Connected through ${payload.nodeLabel}` : "Connected",
      metadata: { gatewaySessionId: payload.gatewaySessionId, source: payload.source },
      dedupeParts: [payload.deviceId, payload.gatewaySessionId ?? payload.sessionId ?? "session"],
    }),
  );

  safe("device.disconnected", (payload) =>
    recordTimelineEvent({
      type: "DEVICE_DISCONNECTED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      nodeId: payload.nodeId,
      sessionId: payload.sessionId,
      bytesUp: BigInt(payload.bytesUp),
      bytesDown: BigInt(payload.bytesDown),
      actor: "GATEWAY",
      actorLabel: payload.nodeLabel,
      // `reason` is the gateway's own end reason. When the gateway reported none, the
      // field stays null so the console can say "not reported" instead of guessing.
      reason: payload.reason ?? payload.endReason,
      metadata: { reportedReason: payload.reason, endReason: payload.endReason },
      dedupeParts: [payload.deviceId, payload.sessionId ?? payload.endReason ?? "session"],
    }),
  );

  safe("quota.warning", (payload) =>
    recordTimelineEvent({
      type: "QUOTA_WARNING",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      severity: payload.thresholdPct >= 90 ? "HIGH" : "MEDIUM",
      actor: "SYSTEM",
      actorLabel: "quota engine",
      reason: `Quota at ${payload.percent === null ? "unavailable" : `${payload.percent.toFixed(1)}%`} of limit`,
      metadata: {
        quotaId: payload.quotaId,
        scope: payload.scope,
        scopeRefId: payload.scopeRefId,
        thresholdPct: payload.thresholdPct,
        usedBytes: payload.usedBytes,
        limitBytes: payload.limitBytes,
        percent: payload.percent,
      },
      dedupeParts: [payload.quotaId, payload.thresholdPct, payload.usedBytes],
    }),
  );

  safe("quota.exceeded", (payload) =>
    recordTimelineEvent({
      type: "QUOTA_EXCEEDED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      severity: "CRITICAL",
      actor: "SYSTEM",
      actorLabel: "quota engine",
      reason: `Quota exceeded: used ${payload.usedBytes} of ${payload.limitBytes} bytes`,
      metadata: {
        quotaId: payload.quotaId,
        usedBytes: payload.usedBytes,
        limitBytes: payload.limitBytes,
        percent: payload.percent,
        sessionsClosed: payload.sessionsClosed ?? null,
        reconnectBlocked: payload.reconnectBlocked ?? null,
      },
      dedupeParts: [payload.quotaId, "exceeded"],
    }),
  );

  safe("quota.reset", (payload) =>
    recordTimelineEvent({
      type: "QUOTA_RESET",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      actor: "SYSTEM",
      actorLabel: "quota engine",
      reason: "Quota period reset",
      metadata: { quotaId: payload.quotaId, previousUsedBytes: payload.usedBytes },
      dedupeParts: [payload.quotaId, "reset", payload.usedBytes],
    }),
  );

  safe("node.offline", (payload) =>
    recordTimelineEvent({
      type: "NODE_HEALTH_CHANGED",
      ts: new Date(payload.ts),
      nodeId: payload.nodeId,
      severity: "CRITICAL",
      actor: "SYSTEM",
      actorLabel: "node monitor",
      reason: payload.reason,
      metadata: { from: payload.from, to: payload.to, lastHeartbeatAt: payload.lastHeartbeatAt },
      dedupeParts: [payload.nodeId, payload.to],
    }),
  );

  safe("node.degraded", (payload) =>
    recordTimelineEvent({
      type: "NODE_HEALTH_CHANGED",
      ts: new Date(payload.ts),
      nodeId: payload.nodeId,
      severity: "MEDIUM",
      actor: "SYSTEM",
      actorLabel: "node monitor",
      reason: payload.reason,
      metadata: { from: payload.from, to: payload.to, lastHeartbeatAt: payload.lastHeartbeatAt },
      dedupeParts: [payload.nodeId, payload.to],
    }),
  );

  safe("node.recovered", (payload) =>
    recordTimelineEvent({
      type: "NODE_HEALTH_CHANGED",
      ts: new Date(payload.ts),
      nodeId: payload.nodeId,
      severity: "INFO",
      actor: "SYSTEM",
      actorLabel: "node monitor",
      reason: payload.reason,
      metadata: { from: payload.from, to: payload.to },
      dedupeParts: [payload.nodeId, payload.to],
    }),
  );

  safe("node.draining", (payload) =>
    recordTimelineEvent({
      type: payload.safeToRestart ? "NODE_DRAIN_COMPLETED" : "NODE_DRAIN_STARTED",
      ts: new Date(payload.ts),
      nodeId: payload.nodeId,
      severity: payload.safeToRestart ? "INFO" : "MEDIUM",
      actor: "USER",
      actorLabel: "operator",
      reason: payload.reason,
      metadata: {
        remainingSessions: payload.remainingSessions,
        safeToRestart: payload.safeToRestart,
      },
      dedupeParts: [payload.nodeId, payload.safeToRestart ? "drain_complete" : "drain_start"],
    }),
  );

  safe("policy.triggered", (payload) =>
    recordTimelineEvent({
      type: "POLICY_TRIGGERED",
      ts: new Date(payload.ts),
      deviceId: payload.targetKind === "DEVICE" ? payload.targetId : null,
      nodeId: payload.targetKind === "NODE" ? payload.targetId : null,
      userId: payload.targetKind === "USER" ? payload.targetId : null,
      actor: "POLICY",
      actorLabel: payload.policyName,
      severity: payload.suppressed || payload.dryRun ? "INFO" : "MEDIUM",
      reason:
        payload.suppressed
          ? `Policy "${payload.policyName}" matched but was suppressed`
          : payload.dryRun
            ? `Policy "${payload.policyName}" matched (dry run - no action taken)`
            : `Policy "${payload.policyName}" applied ${payload.actionKey}`,
      metadata: {
        policyId: payload.policyId,
        executionId: payload.executionId,
        actionKey: payload.actionKey,
        metric: payload.metric,
        observed: payload.observed,
        threshold: payload.threshold,
        targetKind: payload.targetKind,
        targetId: payload.targetId,
        dryRun: payload.dryRun,
        suppressed: payload.suppressed,
      },
      dedupeParts: [payload.policyId, payload.targetId, payload.observed, payload.actionKey],
    }),
  );

  safe("credential.revoked", (payload) =>
    recordTimelineEvent({
      type: "CREDENTIAL_REVOKED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      severity: "HIGH",
      actor: "USER",
      actorLabel: "operator",
      reason: payload.reason,
      metadata: { credentialId: payload.credentialId, sessionsClosed: payload.sessionsClosed },
      dedupeParts: [payload.credentialId, "revoked"],
    }),
  );

  safe("receipt.created", (payload) =>
    recordTimelineEvent({
      type: "RECEIPT_CREATED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId ?? null,
      actor: "USER",
      actorLabel: payload.customerName,
      reason: `Simulated receipt ${payload.receiptNumber} issued`,
      metadata: {
        receiptId: payload.receiptId,
        receiptNumber: payload.receiptNumber,
        simulatedTotal: payload.simulatedTotal,
        currency: payload.currency,
        verificationHash: payload.verificationHash,
      },
      dedupeParts: [payload.receiptId, "issued"],
    }),
  );

  safe("budget.threshold", (payload) =>
    recordTimelineEvent({
      type: "BUDGET_THRESHOLD",
      ts: new Date(payload.ts),
      severity: payload.thresholdPct >= 100 ? "CRITICAL" : payload.thresholdPct >= 90 ? "HIGH" : "MEDIUM",
      actor: "SYSTEM",
      actorLabel: "budget monitor",
      reason: `Budget "${payload.budgetName}" reached ${payload.thresholdPct}%`,
      metadata: {
        budgetId: payload.budgetId,
        scope: payload.scope,
        scopeRefId: payload.scopeRefId,
        thresholdPct: payload.thresholdPct,
        observedPct: payload.observedPct,
        spentAmount: payload.spentAmount,
        limitAmount: payload.limitAmount,
        currency: payload.currency,
      },
      dedupeParts: [payload.budgetId, payload.thresholdPct],
    }),
  );

  safe("automation.run", (payload) =>
    recordTimelineEvent({
      type: "AUTOMATION_RUN",
      ts: new Date(payload.ts),
      severity: payload.status === "FAILED" ? "HIGH" : "INFO",
      actor: "AUTOMATION",
      actorLabel: payload.jobName,
      reason: payload.summary,
      metadata: {
        jobId: payload.jobId,
        kind: payload.kind,
        status: payload.status,
        affectedCount: payload.affectedCount,
        error: payload.error,
      },
      dedupeParts: [payload.jobId, payload.status, payload.summary],
    }),
  );

  safe("optimization.completed", (payload) =>
    recordTimelineEvent({
      type: payload.profileKey ? "OPTIMIZATION_CHANGED" : "OPTIMIZATION_ENABLED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      nodeId: payload.nodeId,
      actor: "SYSTEM",
      actorLabel: "optimization engine",
      reason: `Optimization profile ${payload.profileKey} applied`,
      metadata: {
        profileKey: payload.profileKey,
        measurementKind: payload.measurementKind,
        savedBytes: payload.savedBytes,
        savingPct: payload.savingPct,
      },
      dedupeParts: [payload.deviceId ?? payload.nodeId, payload.profileKey],
    }),
  );

  safe("traffic.anomaly", (payload) =>
    recordTimelineEvent({
      type: "ANOMALY_DETECTED",
      ts: new Date(payload.ts),
      deviceId: payload.deviceId,
      nodeId: payload.nodeId,
      severity: payload.severity as never,
      actor: "SYSTEM",
      actorLabel: "anomaly detection",
      // Neutral wording is a hard requirement: the entry states that a pattern was
      // observed, never that a person did anything wrong.
      reason: payload.summary,
      metadata: { anomalyId: payload.anomalyId, anomalyType: payload.anomalyType, label: payload.label },
      dedupeParts: [payload.anomalyId, "detected"],
    }),
  );

  // -------------------------------------------------------- notifications ----

  const notify = async (input: {
    type: NotificationType;
    severity: NotificationSeverity;
    title: string;
    body: string;
    resource: string;
    resourceId?: string | null;
  }) => {
    const { notify: fire } = await import("@/server/notifications/service");
    void fire(input);
  };

  safe("quota.warning", (payload) =>
    void notify({
      type: "quota.warning",
      severity: payload.thresholdPct >= 90 ? "HIGH" : "WARNING",
      title: `Quota ${payload.thresholdPct}% used`,
      body: `${payload.deviceLabel ?? payload.scope} has used ${payload.usedBytes} of ${payload.limitBytes} bytes (${payload.percent === null ? "percent unavailable" : `${payload.percent.toFixed(1)}%`}).`,
      resource: "quota",
      resourceId: payload.quotaId,
    }),
  );

  safe("quota.exceeded", (payload) =>
    void notify({
      type: "quota.exceeded",
      severity: "CRITICAL",
      title: "Quota exceeded",
      body: `${payload.deviceLabel ?? payload.scope} exceeded its quota. Sessions closed: ${payload.sessionsClosed ?? "unknown"}; reconnect blocked: ${payload.reconnectBlocked ? "yes" : "no"}.`,
      resource: "quota",
      resourceId: payload.quotaId,
    }),
  );

  safe("node.offline", (payload) =>
    void notify({
      type: "node.offline",
      severity: "CRITICAL",
      title: "Node offline",
      body: `${payload.nodeLabel} transitioned ${payload.from} → ${payload.to}. ${payload.reason}`,
      resource: "vpn_node",
      resourceId: payload.nodeId,
    }),
  );

  safe("node.degraded", (payload) =>
    void notify({
      type: "node.degraded",
      severity: "MEDIUM",
      title: "Node degraded",
      body: `${payload.nodeLabel} transitioned ${payload.from} → ${payload.to}. ${payload.reason}`,
      resource: "vpn_node",
      resourceId: payload.nodeId,
    }),
  );

  safe("node.draining", (payload) =>
    void notify({
      type: "node.drain",
      severity: payload.safeToRestart ? "INFO" : "MEDIUM",
      title: payload.safeToRestart ? "Node ready for maintenance" : "Node draining",
      body: `${payload.nodeLabel}: ${payload.remainingSessions} session(s) remaining. ${payload.reason}`,
      resource: "vpn_node",
      resourceId: payload.nodeId,
    }),
  );

  safe("budget.threshold", (payload) =>
    void notify({
      type: "budget.threshold",
      severity: payload.thresholdPct >= 100 ? "CRITICAL" : payload.thresholdPct >= 90 ? "HIGH" : "WARNING",
      title: `Budget ${payload.thresholdPct}% reached`,
      // Budgets never disconnect anything on their own - the copy says so explicitly.
      body: `Simulated budget "${payload.budgetName}" at ${payload.thresholdPct}% (${payload.spentAmount} of ${payload.limitAmount} ${payload.currency}). No session was affected; disconnecting requires a policy action.`,
      resource: "budget",
      resourceId: payload.budgetId,
    }),
  );

  safe("policy.triggered", (payload) => {
    if (payload.suppressed || payload.dryRun) return;
    void notify({
      type: "policy.triggered",
      severity: "MEDIUM",
      title: "Policy triggered",
      body: `"${payload.policyName}" applied ${payload.actionKey} to ${payload.targetLabel ?? payload.targetId ?? payload.targetKind} (${payload.metric} observed ${payload.observed ?? "unavailable"} vs threshold ${payload.threshold ?? "unavailable"}).`,
      resource: "policy",
      resourceId: payload.policyId,
    });
  });

  safe("maintenance.mode_changed", (payload) =>
    void notify({
      type: "maintenance.mode",
      severity: payload.mode === "NORMAL" ? "INFO" : "WARNING",
      title: `Maintenance mode: ${payload.mode}`,
      body: `${payload.actorLabel}: ${payload.reason}`,
      resource: "system_setting",
      resourceId: payload.nodeId ?? null,
    }),
  );

  // ------------------------------------------------------------ realtime ----

  bridge("quota.warning", "quota.update", (payload) => ({
    ts: payload.ts,
    deviceId: payload.deviceId ?? payload.scopeRefId ?? "",
    state: payload.thresholdPct >= 90 ? "WARNED_90" : "WARNED_80",
    percent: payload.percent,
    usedBytes: payload.usedBytes,
    limitBytes: payload.limitBytes,
  }));

  bridge("quota.exceeded", "quota.update", (payload) => ({
    ts: payload.ts,
    deviceId: payload.deviceId ?? payload.scopeRefId ?? "",
    state: "QUOTA_EXCEEDED",
    percent: payload.percent,
    usedBytes: payload.usedBytes,
    limitBytes: payload.limitBytes,
  }));

  bridge("quota.reset", "quota.update", (payload) => ({
    ts: payload.ts,
    deviceId: payload.deviceId ?? payload.scopeRefId ?? "",
    state: "ACTIVE",
    percent: payload.percent,
    usedBytes: payload.usedBytes,
    limitBytes: payload.limitBytes,
  }));

  bridge("node.offline", "node.update", (payload) => ({
    ts: payload.ts,
    nodeId: payload.nodeId,
    health: "OFFLINE",
    lastHeartbeatAt: payload.lastHeartbeatAt,
  }));

  bridge("node.degraded", "node.update", (payload) => ({
    ts: payload.ts,
    nodeId: payload.nodeId,
    health: "DEGRADED",
    lastHeartbeatAt: payload.lastHeartbeatAt,
  }));

  bridge("node.recovered", "node.update", (payload) => ({
    ts: payload.ts,
    nodeId: payload.nodeId,
    health: "ONLINE",
    lastHeartbeatAt: payload.lastHeartbeatAt,
  }));

  // --------------------------------------------------------------- audit ----

  // Only actions that must be attributable to a decision-maker land in the audit trail:
  // a policy that acted, an automation that ran. Read-only timeline entries are not
  // audited, because auditing every read would bury the writes that matter.
  safe("policy.triggered", (payload) => {
    if (payload.dryRun) return;
    void record({
      actor: systemActor,
      action: "policy.triggered",
      resource: "policy",
      resourceId: payload.policyId,
      result: payload.suppressed ? "FAILURE" : "SUCCESS",
      metadata: {
        policyName: payload.policyName,
        executionId: payload.executionId,
        actionKey: payload.actionKey,
        targetKind: payload.targetKind,
        targetId: payload.targetId,
        metric: payload.metric,
        observed: payload.observed,
        threshold: payload.threshold,
        suppressed: payload.suppressed,
        suppressionReason: payload.suppressed ? "override_or_suppression" : null,
      },
    });
  });

  safe("automation.run", (payload) => {
    void record({
      actor: systemActor,
      action: "automation.job_run",
      resource: "automation_job",
      resourceId: payload.jobId,
      result: payload.status === "FAILED" ? "FAILURE" : "SUCCESS",
      metadata: {
        jobName: payload.jobName,
        kind: payload.kind,
        status: payload.status,
        affectedCount: payload.affectedCount,
        summary: payload.summary,
        error: payload.error,
      },
    });
  });

  logger.debug("domain event subscribers registered");
}
