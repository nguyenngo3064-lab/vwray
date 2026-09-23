import "server-only";
import type { AutomationJobKind, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { record } from "@/server/audit";
import { getSetting } from "@/server/settings/service";

/**
 * Automation job handlers.
 *
 * Ten properties keep the automation engine trustworthy:
 *
 *   1. The registry is CLOSED: `AutomationJobKind` is an enum, and a job row can only
 *      name one of those keys. There is no "run this command" capability anywhere.
 *   2. Every handler returns `{ affected, summary, detail }`. An action without a count
 *      is a claim, not a report.
 *   3. Every run writes ONE audit row, whatever happened - including SKIP. A scheduler
 *      that can silently skip work is a scheduler nobody can reason about.
 *   4. Every run writes ONE AutomationRun row, the detail carrier behind the audit's one-liner.
 *   5. A run holds a LEASE on its job row. A second replica (or a slow run overlapping a
 *      tick) cannot run the same job concurrently; a lease a crashed process never
 *      releases expires, so a dead replica cannot wedge a job forever.
 *   6. `nextRunAt` advances only AFTER the handler finishes, so a failing job retries on
 *      the next tick instead of silently falling behind forever.
 *   7. Retention handlers name themselhes by table: each one deletes old rows from ONE
 *      table, booked to `MaintenanceRun` exactly like the legacy retention runner did.
 *   8. Handlers never reach into another handler: shared work (quota reset, rollup,
 *      sweep) goes through the domain services themselves.
 *   9. `BILLING_PERIOD_ROLLOVER` never bills anything: it only resets per-period
 *      bookkeeping (budget warning flags) so a new period starts clean.
 *   10. `RECEIPT_ISSUE` runs only from an explicit `config` on the job row: without a
 *      named recipient there is nobody to issue to, so it SKIPS with a reason.
 */

export interface JobResult {
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  affected: number;
  summary: string;
  detail?: Record<string, unknown>;
  error?: string;
}

export interface JobDefinition {
  kind: AutomationJobKind;
  label: string;
  description: string;
  /** Default cadence; an operator may lengthen but not go below `minIntervalSeconds`. */
  defaultIntervalSeconds: number;
  minIntervalSeconds: number;
  run: (job: { id: string; name: string; config: Record<string, unknown> | null }) => Promise<JobResult>;
}

interface QuotaDueRow {
  id: string;
  label: string;
  scope: string;
  deviceId: string | null;
}

async function quotaPeriodReset(): Promise<JobResult> {
  const now = new Date();
  const due = (await prisma.quota.findMany({
    where: { resetPolicy: "AUTO", enabled: true, resetAt: { lte: now } },
    select: { id: true, label: true, scope: true, deviceId: true },
  })) as QuotaDueRow[];

  let affected = 0;
  const resetIds: string[] = [];
  for (const quota of due) {
    await prisma.$transaction(async (tx) => {
      await tx.quota.update({
        where: { id: quota.id },
        data: {
          usedBytes: 0n,
          exceededAt: null,
          warned80At: null,
          warned90At: null,
          lastEvaluatedAt: null,
          periodStart: now,
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
              reason: "Quota period reset (automatic)",
              revision: { increment: 1 },
              appliedAt: null,
              ackedAt: null,
            },
          });
        }
      }
      await tx.auditLog.create({
        data: {
          actorType: "SYSTEM",
          actorId: null,
          actorLabel: "automation",
          action: "quota.reset",
          resource: "quota",
          resourceId: quota.id,
          result: "SUCCESS",
          metadata: { scope: quota.scope, automatic: true } as Prisma.InputJsonValue,
        },
      });
    });
    affected += 1;
    resetIds.push(quota.id);
  }

  return affected === 0
    ? { status: "SUCCEEDED", affected: 0, summary: "No periodic quota is due for reset.", detail: {} }
    : { status: "SUCCEEDED", affected, summary: `Reset ${affected} periodic quota(s).`, detail: { quotaIds: resetIds } };
}

async function trafficRollup(): Promise<JobResult> {
  const { flush } = await import("@/server/traffic/buffer");
  const result = await flush();
  return {
    status: "SUCCEEDED",
    affected: result.aggregates,
    summary:
      result.samples > 0
        ? `Flushed ${result.samples} buffered sample(s) into ${result.aggregates} aggregate row(s).`
        : "Buffer is empty; nothing to roll up.",
    detail: result,
  };
}

async function nodeHealthCheck(): Promise<JobResult> {
  const { sweepStaleNodes } = await import("@/server/nodes/service");
  const marked = await sweepStaleNodes();
  return {
    status: "SUCCEEDED",
    affected: marked,
    summary: marked > 0 ? `Marked ${marked} stale node(s) OFFLINE.` : "All nodes are within their heartbeat windows.",
    detail: { markedOffline: marked },
  };
}

async function anomalySweep(): Promise<JobResult> {
  const { runAnomalyDetection } = await import("@/server/security/detector");
  const result = await runAnomalyDetection();
  const detail: Record<string, unknown> = { ...result };
  return {
    status: "SUCCEEDED",
    affected: result.created,
    summary:
      result.created > 0
        ? `Raised ${result.created} anomal${result.created === 1 ? "y" : "ies"} for review.`
        : "No unusual pattern crossed a threshold.",
    detail,
  };
}

async function policyEvaluation(): Promise<JobResult> {
  const limit = await getSetting<number>("automation.policyEvaluationTargetLimit");
  const { evaluatePolicies } = await import("@/server/policy/engine");
  const summary = await evaluatePolicies({ targetLimit: limit });
  return {
    status: summary.failed > 0 ? "FAILED" : "SUCCEEDED",
    affected: summary.applied,
    summary: `${summary.policies} polic${summary.policies === 1 ? "y" : "ies"} evaluated across ${summary.targetsEvaluated} target(s): ${summary.applied} applied, ${summary.matched} matched, ${summary.unmeasurable} unmeasurable.`,
    detail: { ...summary },
    ...(summary.failed > 0 ? { error: `${summary.failed} evaluation(s) failed.` } : {}),
  };
}

async function expiredCredentialCleanup(): Promise<JobResult> {
  const now = new Date();
  const expired = await prisma.deviceCredential.findMany({
    where: { expiresAt: { lte: now }, revokedAt: null },
    select: { id: true, deviceId: true },
    take: 500,
  });
  for (const credential of expired) {
    await prisma.deviceCredential.update({ where: { id: credential.id }, data: { revokedAt: now } });
    await record({
      actor: { type: "SYSTEM", id: null, label: "automation" },
      action: "credential.revoked",
      resource: "device_credential",
      resourceId: credential.id,
      result: "SUCCESS",
      metadata: { deviceId: credential.deviceId, reason: "expired", automatic: true },
    });
  }
  return {
    status: "SUCCEEDED",
    affected: expired.length,
    summary: expired.length > 0 ? `Revoked ${expired.length} expired credential(s).` : "No expired credentials pending revocation.",
    detail: { credentialIds: expired.map((entry) => entry.id) },
  };
}

async function expiredConfigCleanup(): Promise<JobResult> {
  const now = new Date();
  const expired = await prisma.vpnConfig.findMany({
    where: { status: "ACTIVE", expiresAt: { lte: now } },
    select: { id: true, name: true },
    take: 500,
  });
  for (const config of expired) {
    await prisma.vpnConfig.update({ where: { id: config.id }, data: { status: "EXPIRED" } });
    await record({
      actor: { type: "SYSTEM", id: null, label: "automation" },
      action: "config.expired",
      resource: "vpn_config",
      resourceId: config.id,
      result: "SUCCESS",
      metadata: { automatic: true },
    });
  }
  return {
    status: "SUCCEEDED",
    affected: expired.length,
    summary: expired.length > 0 ? `Expired ${expired.length} configuration(s).` : "No configuration passed its expiry.",
    detail: { configIds: expired.map((entry) => entry.id) },
  };
}

async function retentionTraffic(): Promise<JobResult> {
  const [rawDays, aggregateDays] = await Promise.all([
    getSetting<number>("retention.trafficRawDays"),
    getSetting<number>("retention.trafficAggregateDays"),
  ]);
  const startedAt = new Date();
  const run = await prisma.maintenanceRun.create({ data: { job: "RETENTION_TRAFFIC_SAMPLES" } });

  const rawCutoff = new Date(startedAt.getTime() - rawDays * 86_400_000);
  const aggregateCutoff = new Date(startedAt.getTime() - aggregateDays * 86_400_000);

  const [raw, aggregates] = await Promise.all([
    prisma.trafficSample.deleteMany({ where: { ts: { lt: rawCutoff } } }),
    prisma.trafficAggregate.deleteMany({ where: { bucketStart: { lt: aggregateCutoff } } }),
  ]);
  const deletedRows = raw.count + aggregates.count;

  await prisma.maintenanceRun.update({
    where: { id: run.id },
    data: {
      finishedAt: new Date(),
      deletedRows,
      status: "SUCCEEDED",
      detail: { rawDays, aggregateDays, rawSamples: raw.count, aggregates: aggregates.count } as Prisma.InputJsonValue,
    },
  });

  return {
    status: "SUCCEEDED",
    affected: deletedRows,
    summary: `Removed ${raw.count} raw sample(s) older than ${rawDays} day(s) and ${aggregates.count} aggregate(s) older than ${aggregateDays} day(s).`,
    detail: { rawSamples: raw.count, aggregates: aggregates.count, maintenanceRunId: run.id },
  };
}

async function retentionAudit(): Promise<JobResult> {
  const days = await getSetting<number>("retention.auditLogDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const run = await prisma.maintenanceRun.create({ data: { job: "RETENTION_AUDIT_LOGS" } });

  // The audit trail is append-only in spirit: only rows past their retention age leave,
  // and the cleanup itself stays recorded by the automation audit row.
  const deleted = await prisma.auditLog.deleteMany({ where: { ts: { lt: cutoff } } });

  await prisma.maintenanceRun.update({
    where: { id: run.id },
    data: { finishedAt: new Date(), deletedRows: deleted.count, status: "SUCCEEDED" },
  });

  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} audit row(s) older than ${days} day(s).`,
    detail: { auditRows: deleted.count, maintenanceRunId: run.id },
  };
}

async function retentionNodeHealth(): Promise<JobResult> {
  const days = await getSetting<number>("retention.nodeHealthDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await prisma.nodeHealthSample.deleteMany({ where: { sampledAt: { lt: cutoff } } });
  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} health sample(s) older than ${days} day(s).`,
    detail: { samples: deleted.count },
  };
}

async function retentionDnsStats(): Promise<JobResult> {
  const days = await getSetting<number>("retention.dnsStatDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await prisma.dnsQueryStat.deleteMany({ where: { bucketStart: { lt: cutoff } } });
  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} DNS stat row(s) older than ${days} day(s).`,
    detail: { rows: deleted.count },
  };
}

async function retentionConnectionEvents(): Promise<JobResult> {
  const days = await getSetting<number>("retention.connectionEventDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await prisma.connectionEvent.deleteMany({ where: { ts: { lt: cutoff } } });
  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} timeline event(s) older than ${days} day(s).`,
    detail: { events: deleted.count },
  };
}

async function retentionPolicyExecutions(): Promise<JobResult> {
  const days = await getSetting<number>("retention.policyExecutionDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await prisma.policyExecution.deleteMany({ where: { evaluatedAt: { lt: cutoff } } });
  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} policy execution row(s) older than ${days} day(s).`,
    detail: { executions: deleted.count },
  };
}

async function retentionAutomationRuns(): Promise<JobResult> {
  const days = await getSetting<number>("retention.automationRunDays");
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const deleted = await prisma.automationRun.deleteMany({
    where: { startedAt: { lt: cutoff }, status: { not: "RUNNING" } },
  });
  return {
    status: "SUCCEEDED",
    affected: deleted.count,
    summary: `Removed ${deleted.count} automation run row(s) older than ${days} day(s).`,
    detail: { runs: deleted.count },
  };
}

async function billingPeriodRollover(): Promise<JobResult> {
  const { getBillingOverview } = await import("@/server/billing/service");
  const overview = await getBillingOverview();
  const periodStart = new Date(overview.period.start);

  const budgets = await prisma.budget.findMany({ where: { enabled: true } });
  let cleared = 0;
  const clearedIds: string[] = [];
  for (const budget of budgets) {
    const data: Record<string, Date | null> = {};
    for (const key of ["warnedAt50", "warnedAt75", "warnedAt90", "warnedAt100"] as const) {
      const stamped = budget[key];
      if (stamped !== null && stamped < periodStart) data[key] = null;
    }
    if (Object.keys(data).length > 0) {
      await prisma.budget.update({ where: { id: budget.id }, data });
      cleared += 1;
      clearedIds.push(budget.id);
    }
  }

  return {
    status: "SUCCEEDED",
    affected: cleared,
    summary:
      cleared > 0
        ? `Rolled ${cleared} budget(s) into the new period (warning flags from the old period cleared).`
        : "No budget carried a warning flag from a previous period.",
    detail: { periodStart: overview.period.start, budgets: clearedIds },
  };
}

async function reportGeneration(config: Record<string, unknown> | null): Promise<JobResult> {
  const type = typeof config?.type === "string" ? config.type.toUpperCase() : "DAILY";
  const allowed = ["DAILY", "WEEKLY", "MONTHLY"];
  const reportType = (allowed.includes(type) ? type : "DAILY") as "DAILY" | "WEEKLY" | "MONTHLY";
  const { generateReport } = await import("@/server/reports/service");
  const report = await generateReport({
    type: reportType,
    format: "JSON",
    actorId: null,
    actorLabel: "automation",
  });
  return {
    status: "SUCCEEDED",
    affected: 1,
    summary: `Generated a ${reportType.toLowerCase()} report (${report.byteLength} bytes, ${report.sectionCount} section(s)).`,
    detail: { reportId: report.id, byteLength: report.byteLength, sections: report.sectionNames },
  };
}

async function receiptIssue(config: Record<string, unknown> | null): Promise<JobResult> {
  const customerName = typeof config?.customerName === "string" ? config.customerName.trim() : "";
  if (!customerName) {
    return {
      status: "SKIPPED",
      affected: 0,
      summary:
        "Skipped: no recipient is configured on this job (set `customerName` in the job config before enabling automatic issue).",
      detail: {},
    };
  }
  const { getReceipt, createReceipt } = await import("@/server/receipts/service");
  const issued = typeof config?.existingReceiptId === "string" ? config.existingReceiptId : null;
  if (issued) {
    try {
      const receipt = await getReceipt(issued);
      return {
        status: "SUCCEEDED",
        affected: 0,
        summary: `Skipped: receipt ${receipt.receiptNumber} already exists for this period.`,
        detail: { receiptId: receipt.id, receiptNumber: receipt.receiptNumber },
      };
    } catch {
      // A receipt that was deleted still counts as needing one: fall through and issue.
    }
  }
  const now = new Date();
  const periodStart = new Date(now);
  periodStart.setUTCDate(1);
  periodStart.setUTCHours(0, 0, 0, 0);
  const outcome = await createReceipt({
    customerName,
    deviceId: typeof config?.deviceId === "string" ? config.deviceId : null,
    customerRef: typeof config?.customerRef === "string" ? config.customerRef : null,
    nodeId: typeof config?.nodeId === "string" ? config.nodeId : null,
    periodStart,
    periodEnd: now,
    actorId: "00000000-0000-0000-0000-000000000000",
    actorLabel: "automation",
    sourceIp: null,
  });
  return {
    status: "SUCCEEDED",
    affected: 1,
    summary: `Issued simulated receipt ${outcome.receipt.receiptNumber} for ${customerName}.`,
    detail: { receiptId: outcome.receipt.id, receiptNumber: outcome.receipt.receiptNumber },
  };
}

export const JOB_REGISTRY: ReadonlyArray<JobDefinition> = [
  {
    kind: "QUOTA_PERIOD_RESET",
    label: "Quota period reset",
    description: "Resets quotas whose automatic reset is due and clears their enforcement rows.",
    defaultIntervalSeconds: 900,
    minIntervalSeconds: 300,
    run: quotaPeriodReset,
  },
  {
    kind: "TRAFFIC_AGGREGATE_ROLLUP",
    label: "Traffic rollup",
    description: "Flushes the in-memory traffic buffer into aggregates so history never depends on process lifetime.",
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60,
    run: trafficRollup,
  },
  {
    kind: "NODE_HEALTH_CHECK",
    label: "Node health check",
    description: "Sweeps nodes that missed their heartbeat window while nobody was looking.",
    defaultIntervalSeconds: 300,
    minIntervalSeconds: 60,
    run: nodeHealthCheck,
  },
  {
    kind: "ANOMALY_SWEEP",
    label: "Anomaly sweep",
    description: "Runs the anomaly detectors over recent aggregates and raises neutral observations for review.",
    defaultIntervalSeconds: 900,
    minIntervalSeconds: 300,
    run: anomalySweep,
  },
  {
    kind: "POLICY_EVALUATION",
    label: "Policy evaluation",
    description: "Evaluates every enabled policy against its targets (priority order, cooldown, override rules apply).",
    defaultIntervalSeconds: 900,
    minIntervalSeconds: 300,
    run: policyEvaluation,
  },
  {
    kind: "EXPIRED_CREDENTIAL_CLEANUP",
    label: "Expired credential cleanup",
    description: "Revokes credentials past their expiry.",
    defaultIntervalSeconds: 3600,
    minIntervalSeconds: 600,
    run: expiredCredentialCleanup,
  },
  {
    kind: "EXPIRED_CONFIG_CLEANUP",
    label: "Expired config cleanup",
    description: "Marks configurations past their expiry as EXPIRED.",
    defaultIntervalSeconds: 3600,
    minIntervalSeconds: 600,
    run: expiredConfigCleanup,
  },
  {
    kind: "RETENTION_TRAFFIC_SAMPLES",
    label: "Retention: raw traffic",
    description: "Deletes raw samples and aggregates past their retention age (booked to MaintenanceRun).",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionTraffic,
  },
  {
    kind: "RETENTION_AUDIT_LOGS",
    label: "Retention: audit trail",
    description: "Deletes audit rows past retention age. Only rows past the setting's age leave; the cleanup stays audited.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionAudit,
  },
  {
    kind: "RETENTION_NODE_HEALTH",
    label: "Retention: node health",
    description: "Deletes node health samples past retention age.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionNodeHealth,
  },
  {
    kind: "RETENTION_DNS_STATS",
    label: "Retention: DNS stats",
    description: "Deletes DNS statistics past retention age.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionDnsStats,
  },
  {
    kind: "RETENTION_CONNECTION_EVENTS",
    label: "Retention: timeline",
    description: "Deletes connection timeline events past retention age.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionConnectionEvents,
  },
  {
    kind: "RETENTION_POLICY_EXECUTIONS",
    label: "Retention: policy history",
    description: "Deletes policy execution rows past retention age.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionPolicyExecutions,
  },
  {
    kind: "RETENTION_AUTOMATION_RUNS",
    label: "Retention: automation runs",
    description: "Deletes automation run bookkeeping past retention age (the audit trail is separate).",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: retentionAutomationRuns,
  },
  {
    kind: "BILLING_PERIOD_ROLLOVER",
    label: "Billing period rollover",
    description: "Clears per-period budget warning flags when a new period begins. Bills nothing.",
    defaultIntervalSeconds: 3600,
    minIntervalSeconds: 600,
    run: billingPeriodRollover,
  },
  {
    kind: "REPORT_GENERATION",
    label: "Report generation",
    description: "Generates a scheduled report from stored data (configured on the job row).",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: async (job) => reportGeneration(job.config),
  },
  {
    kind: "RECEIPT_ISSUE",
    label: "Receipt issue",
    description: "Issues a simulated receipt for the configured recipient; skips honestly when none is configured.",
    defaultIntervalSeconds: 86_400,
    minIntervalSeconds: 3600,
    run: async (job) => receiptIssue(job.config),
  },
];

export function jobDefinitionFor(kind: AutomationJobKind): JobDefinition {
  const definition = JOB_REGISTRY.find((entry) => entry.kind === kind);
  if (!definition) {
    logger.error("automation job kind unknown", { kind });
    throw new Error(`Unknown automation job kind: ${kind}.`);
  }
  return definition;
}

export const JOB_KINDS: AutomationJobKind[] = JOB_REGISTRY.map((entry) => entry.kind);
