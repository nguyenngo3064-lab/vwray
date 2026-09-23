import "server-only";
import { prisma } from "@/server/db/client";
import { quotaPercent } from "@/lib/format/units";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";
import { primaryBudgetConsumption } from "@/server/billing/budget";
import type { PolicyCondition } from "@/server/policy/schema";
import type { PolicyMetric, PolicyTargetKind } from "@prisma/client";

/**
 * Metric observer.
 *
 * This module is the honesty boundary of the policy engine: a condition may only fire on
 * a number that was actually measured. Every observer returns `{ observed, evidence }`
 * where `observed === null` means "could not be measured" - and the engine treats null as
 * UNMEASURABLE rather than as zero. That distinction is why a node with no telemetry can
 * never satisfy `latency < 50ms` just because latency looks like 0.
 *
 * Evidence is the structured record the console's WHY view renders: which row ids, which
 * window, which raw figures produced the number.
 */

export interface PolicyTarget {
  kind: PolicyTargetKind;
  /** Null for SYSTEM, which has no id. */
  id: string | null;
  label: string;
}

export interface Observation {
  observed: number | null;
  evidence: Record<string, unknown>;
  /** Present only when observed is null. Rendered verbatim by the console. */
  unavailableReason?: string;
}

const GB = 1024 ** 3;

function dimKeyFor(target: PolicyTarget): string | null {
  if (target.kind === "SYSTEM") return "system";
  if (!target.id) return null;
  return `${target.kind === "DEVICE" ? "device" : target.kind === "USER" ? "user" : target.kind === "NODE" ? "node" : "config"}:${target.id}`;
}

function quotaScopeFor(target: PolicyTarget): { scope: "SYSTEM" | "USER" | "DEVICE" | "CONFIG" | "NODE"; scopeRefId: string | null } | null {
  if (target.kind === "SYSTEM") return { scope: "SYSTEM", scopeRefId: null };
  if (!target.id) return null;
  if (target.kind === "DEVICE") return { scope: "DEVICE", scopeRefId: target.id };
  if (target.kind === "USER") return { scope: "USER", scopeRefId: target.id };
  if (target.kind === "NODE") return { scope: "NODE", scopeRefId: target.id };
  if (target.kind === "CONFIG") return { scope: "CONFIG", scopeRefId: target.id };
  return null;
}

async function observeQuota(
  target: PolicyTarget,
  field: "percent" | "usedBytes",
): Promise<Observation> {
  const scope = quotaScopeFor(target);
  if (!scope) {
    return { observed: null, evidence: {}, unavailableReason: "This target has no quota scope." };
  }
  const quota = await prisma.quota.findFirst({ where: { scope: scope.scope, scopeRefId: scope.scopeRefId } });
  if (!quota) {
    return { observed: null, evidence: { scope: scope.scope, scopeRefId: scope.scopeRefId }, unavailableReason: "No quota is configured for this target." };
  }
  if (!quota.enabled) {
    return { observed: null, evidence: { quotaId: quota.id }, unavailableReason: "The quota is disabled." };
  }

  const evidence = {
    quotaId: quota.id,
    usedBytes: quota.usedBytes.toString(),
    limitBytes: quota.limitBytes.toString(),
    exceededAt: quota.exceededAt?.toISOString() ?? null,
    periodStart: quota.periodStart?.toISOString() ?? null,
  };

  if (field === "usedBytes") return { observed: Number(quota.usedBytes), evidence };
  const percent = quotaPercent(quota.usedBytes, quota.limitBytes);
  if (percent === null) {
    return { observed: null, evidence, unavailableReason: "The quota limit is zero, so a percentage is undefined." };
  }
  return { observed: percent, evidence };
}

async function sumBytes(
  dimKey: string,
  from: Date,
  to: Date,
  direction?: "UPLOAD" | "DOWNLOAD",
): Promise<{ bytes: number; buckets: number }> {
  const rows = await prisma.trafficAggregate.groupBy({
    by: ["direction"],
    where: {
      dimKey,
      bucketStart: { gte: from, lt: to },
      ...(direction ? { direction } : {}),
    },
    _sum: { bytes: true },
    _count: { _all: true },
  });
  let bytes = 0;
  let buckets = 0;
  for (const row of rows) {
    bytes += Number(row._sum.bytes ?? 0n);
    buckets += row._count._all;
  }
  return { bytes, buckets };
}

async function observeRatePerHour(
  target: PolicyTarget,
  condition: PolicyCondition,
  direction: "UPLOAD" | "DOWNLOAD",
): Promise<Observation> {
  const dimKey = dimKeyFor(target);
  if (!dimKey) return { observed: null, evidence: {}, unavailableReason: "This target has no traffic dimension." };

  const now = Date.now();
  const from = new Date(now - condition.windowSeconds * 1000);
  const to = new Date(now);
  const { bytes, buckets } = await sumBytes(dimKey, from, to, direction);

  const evidence = { dimKey, from: from.toISOString(), to: to.toISOString(), bytes, buckets, windowSeconds: condition.windowSeconds };
  if (buckets < condition.minSamples) {
    return { observed: null, evidence, unavailableReason: `Only ${buckets} sample bucket(s) in the window; at least ${condition.minSamples} required.` };
  }
  const hours = condition.windowSeconds / 3600;
  return { observed: bytes / hours, evidence: { ...evidence, rateBytesPerHour: bytes / hours } };
}

async function observeSpikeFactor(target: PolicyTarget, condition: PolicyCondition): Promise<Observation> {
  const dimKey = dimKeyFor(target);
  if (!dimKey) return { observed: null, evidence: {}, unavailableReason: "This target has no traffic dimension." };

  const now = Date.now();
  const windowMs = condition.windowSeconds * 1000;
  const baselineMs = (condition.baselineWindowSeconds ?? condition.windowSeconds * 24) * 1000;
  const recentFrom = new Date(now - windowMs);
  const baselineFrom = new Date(now - windowMs - baselineMs);

  const [recent, baseline] = await Promise.all([
    sumBytes(dimKey, recentFrom, new Date(now)),
    sumBytes(dimKey, baselineFrom, recentFrom),
  ]);

  const evidence = {
    dimKey,
    recentFrom: recentFrom.toISOString(),
    baselineFrom: baselineFrom.toISOString(),
    recentBytes: recent.bytes,
    baselineBytes: baseline.bytes,
    recentBuckets: recent.buckets,
    baselineBuckets: baseline.buckets,
    windowSeconds: condition.windowSeconds,
    baselineWindowSeconds: condition.baselineWindowSeconds ?? condition.windowSeconds * 24,
  };

  if (recent.buckets < condition.minSamples || baseline.buckets < condition.minSamples) {
    return { observed: null, evidence, unavailableReason: "Not enough history to compare against a baseline." };
  }
  if (baseline.bytes === 0) {
    return { observed: null, evidence, unavailableReason: "The baseline window recorded no traffic, so a ratio is undefined." };
  }

  const factor = recent.bytes / baseline.bytes;
  return { observed: factor, evidence: { ...evidence, factor } };
}

async function observeConnections(target: PolicyTarget, condition: PolicyCondition): Promise<Observation> {
  if (target.kind !== "DEVICE" || !target.id) {
    return { observed: null, evidence: {}, unavailableReason: "Connection counts are only reported per device." };
  }
  const from = new Date(Date.now() - condition.windowSeconds * 1000);
  const rows = await prisma.trafficAggregate.findMany({
    where: { dimKey: `device:${target.id}`, bucketStart: { gte: from }, connections: { not: null } },
    orderBy: { bucketStart: "desc" },
    take: 200,
    select: { connections: true, bucketStart: true },
  });
  if (rows.length === 0) {
    return { observed: null, evidence: { dimKey: `device:${target.id}` }, unavailableReason: "The data plane did not report connection counts in this window." };
  }
  const peak = Math.max(...rows.map((row) => row.connections ?? 0));
  return { observed: peak, evidence: { dimKey: `device:${target.id}`, peakConnections: peak, reportedBuckets: rows.length } };
}

async function observeReconnects(target: PolicyTarget, condition: PolicyCondition): Promise<Observation> {
  if (target.kind !== "DEVICE" || !target.id) {
    return { observed: null, evidence: {}, unavailableReason: "Reconnect counting is only available per device." };
  }
  const from = new Date(Date.now() - condition.windowSeconds * 1000);
  const [sessions, activity] = await Promise.all([
    prisma.vpnSession.count({ where: { deviceId: target.id, startedAt: { gte: from } } }),
    prisma.trafficAggregate.count({ where: { dimKey: `device:${target.id}`, bucketStart: { gte: from } } }),
  ]);
  if (sessions === 0 && activity === 0) {
    return { observed: null, evidence: { from: from.toISOString(), sessions: 0, trafficBuckets: 0 }, unavailableReason: "The device showed no activity in this window, so reconnects cannot be distinguished from silence." };
  }
  return { observed: sessions, evidence: { from: from.toISOString(), sessions, trafficBuckets: activity } };
}

async function observeAuthFailures(condition: PolicyCondition): Promise<Observation> {
  const from = new Date(Date.now() - condition.windowSeconds * 1000);
  const [failed, total] = await Promise.all([
    prisma.authAttempt.count({ where: { success: false, createdAt: { gte: from } } }),
    prisma.authAttempt.count({ where: { createdAt: { gte: from } } }),
  ]);
  return {
    observed: failed,
    evidence: { from: from.toISOString(), failedAttempts: failed, totalAttempts: total, scope: "operator logins" },
  };
}

async function latestHealthSample(nodeId: string, windowSeconds: number) {
  const from = new Date(Date.now() - windowSeconds * 1000);
  return prisma.nodeHealthSample.findFirst({
    where: { nodeId, sampledAt: { gte: from } },
    orderBy: { sampledAt: "desc" },
  });
}

async function observeNode(
  target: PolicyTarget,
  condition: PolicyCondition,
  metric: "NODE_CPU_PERCENT" | "NODE_RAM_PERCENT" | "NODE_PACKET_LOSS_PCT" | "NODE_LATENCY_MS" | "NODE_ACTIVE_SESSIONS" | "NODE_SESSION_HEADROOM_PERCENT" | "NODE_ONLINE",
): Promise<Observation> {
  if (target.kind !== "NODE" || !target.id) {
    return { observed: null, evidence: {}, unavailableReason: "This metric requires a node target." };
  }
  const node = await prisma.vpnNode.findUnique({ where: { id: target.id } });
  if (!node) return { observed: null, evidence: {}, unavailableReason: "The node no longer exists." };

  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");

  if (metric === "NODE_ONLINE") {
    const health = deriveHealth({
      lastHeartbeatAt: node.lastHeartbeatAt,
      staleSeconds,
      maintenance: node.maintenance,
      draining: node.draining,
    });
    const online = health === "ONLINE" || health === "DEGRADED";
    return { observed: online ? 100 : 0, evidence: { health, lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null, staleSeconds } };
  }

  if (metric === "NODE_ACTIVE_SESSIONS") {
    return { observed: node.activeSessions, evidence: { activeSessions: node.activeSessions, lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null } };
  }

  if (metric === "NODE_SESSION_HEADROOM_PERCENT") {
    if (!node.maxSessions || node.maxSessions <= 0) {
      return { observed: null, evidence: { activeSessions: node.activeSessions }, unavailableReason: "The node declares no session capacity, so headroom is undefined." };
    }
    const headroom = ((node.maxSessions - node.activeSessions) / node.maxSessions) * 100;
    return { observed: headroom, evidence: { activeSessions: node.activeSessions, maxSessions: node.maxSessions, headroomPct: headroom } };
  }

  if (metric === "NODE_CPU_PERCENT") {
    if (node.cpuPercent === null) {
      return { observed: null, evidence: { lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null }, unavailableReason: "The agent has never reported CPU load." };
    }
    return { observed: node.cpuPercent, evidence: { cpuPercent: node.cpuPercent, lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null } };
  }

  if (metric === "NODE_RAM_PERCENT") {
    if (node.ramPercent === null) {
      return { observed: null, evidence: { lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null }, unavailableReason: "The agent has never reported memory load." };
    }
    return { observed: node.ramPercent, evidence: { ramPercent: node.ramPercent, lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null } };
  }

  const sample = await latestHealthSample(node.id, condition.windowSeconds);
  if (!sample) {
    return { observed: null, evidence: { from: new Date(Date.now() - condition.windowSeconds * 1000).toISOString() }, unavailableReason: "No telemetry sample in the window." };
  }

  if (metric === "NODE_PACKET_LOSS_PCT") {
    if (sample.packetLossPct === null) {
      return { observed: null, evidence: { sampleId: sample.id, sampledAt: sample.sampledAt.toISOString() }, unavailableReason: "The agent does not report packet loss." };
    }
    return { observed: sample.packetLossPct, evidence: { sampleId: sample.id, sampledAt: sample.sampledAt.toISOString(), packetLossPct: sample.packetLossPct } };
  }

  if (sample.latencyMs === null) {
    return { observed: null, evidence: { sampleId: sample.id, sampledAt: sample.sampledAt.toISOString() }, unavailableReason: "The agent does not report latency." };
  }
  return { observed: sample.latencyMs, evidence: { sampleId: sample.id, sampledAt: sample.sampledAt.toISOString(), latencyMs: sample.latencyMs } };
}

async function observeDeviceState(target: PolicyTarget, metric: "DEVICE_QUOTA_EXCEEDED" | "DEVICE_BLOCKED"): Promise<Observation> {
  if (target.kind !== "DEVICE" || !target.id) {
    return { observed: null, evidence: {}, unavailableReason: "This metric requires a device target." };
  }
  const device = await prisma.device.findUnique({ where: { id: target.id } });
  if (!device) return { observed: null, evidence: {}, unavailableReason: "The device no longer exists." };
  if (metric === "DEVICE_QUOTA_EXCEEDED") {
    return { observed: device.quotaExceededAt ? 100 : 0, evidence: { quotaExceededAt: device.quotaExceededAt?.toISOString() ?? null, connectionStatus: device.connectionStatus } };
  }
  const blocked = device.blockedAt !== null || device.approvalState === "BLOCKED";
  return { observed: blocked ? 100 : 0, evidence: { blockedAt: device.blockedAt?.toISOString() ?? null, approvalState: device.approvalState } };
}

async function observeBudget(): Promise<Observation> {
  const consumption = await primaryBudgetConsumption();
  if (!consumption) {
    return { observed: null, evidence: {}, unavailableReason: "No budget is configured." };
  }
  if (!consumption.available || consumption.percent === null) {
    return { observed: null, evidence: { reason: consumption.reason }, unavailableReason: consumption.reason ?? "Budget consumption is unavailable." };
  }
  return {
    observed: consumption.percent,
    evidence: {
      spentAmount: consumption.spentAmount,
      limitAmount: consumption.limitAmount,
      percent: consumption.percent,
      currency: consumption.currency,
      calculation: consumption.calculation,
      periodStart: consumption.periodStart,
      periodEnd: consumption.periodEnd,
    },
  };
}

/** Single entry point used by the engine and by simulation. */
export async function observeMetric(
  metric: PolicyMetric,
  target: PolicyTarget,
  condition: PolicyCondition,
): Promise<Observation> {
  switch (metric) {
    case "QUOTA_PERCENT":
      return observeQuota(target, "percent");
    case "QUOTA_USED_BYTES":
      return observeQuota(target, "usedBytes");
    case "DEVICE_UPLOAD_BYTES_PER_HOUR":
      return observeRatePerHour(target, condition, "UPLOAD");
    case "DEVICE_DOWNLOAD_BYTES_PER_HOUR":
      return observeRatePerHour(target, condition, "DOWNLOAD");
    case "TRAFFIC_SPIKE_FACTOR":
      return observeSpikeFactor(target, condition);
    case "DEVICE_CONNECTIONS":
      return observeConnections(target, condition);
    case "DEVICE_RECONNECTS":
      return observeReconnects(target, condition);
    case "AUTH_FAILURES":
      return observeAuthFailures(condition);
    case "NODE_CPU_PERCENT":
    case "NODE_RAM_PERCENT":
    case "NODE_PACKET_LOSS_PCT":
    case "NODE_LATENCY_MS":
    case "NODE_ACTIVE_SESSIONS":
    case "NODE_SESSION_HEADROOM_PERCENT":
    case "NODE_ONLINE":
      return observeNode(target, condition, metric);
    case "BUDGET_PERCENT":
      return observeBudget();
    case "DEVICE_QUOTA_EXCEEDED":
    case "DEVICE_BLOCKED":
      return observeDeviceState(target, metric);
    default:
      return { observed: null, evidence: { metric }, unavailableReason: `Metric ${metric} is not implemented.` };
  }
}

export function compare(observed: number, operator: "GTE" | "GT" | "LTE" | "LT" | "EQ" | "NEQ", threshold: number): boolean {
  switch (operator) {
    case "GTE":
      return observed >= threshold;
    case "GT":
      return observed > threshold;
    case "LTE":
      return observed <= threshold;
    case "LT":
      return observed < threshold;
    case "EQ":
      return observed === threshold;
    case "NEQ":
      return observed !== threshold;
  }
}

/**
 * Builds the evaluation target list for a policy. Bounded deliberately: the engine runs
 * on a schedule, so a fleet of thousands is handled by prioritising recently-active
 * devices rather than by loading every row ever recorded.
 */
export async function targetsForPolicy(kind: PolicyTargetKind, limit = 500): Promise<PolicyTarget[]> {
  if (kind === "SYSTEM") return [{ kind: "SYSTEM", id: null, label: "System" }];

  if (kind === "NODE") {
    const nodes = await prisma.vpnNode.findMany({ orderBy: { name: "asc" }, take: limit, select: { id: true, name: true } });
    return nodes.map((node) => ({ kind: "NODE" as const, id: node.id, label: node.name }));
  }

  if (kind === "USER") {
    const users = await prisma.adminUser.findMany({ orderBy: { username: "asc" }, take: limit, select: { id: true, username: true } });
    return users.map((user) => ({ kind: "USER" as const, id: user.id, label: user.username }));
  }

  if (kind === "CONFIG") {
    const configs = await prisma.vpnConfig.findMany({ orderBy: { createdAt: "desc" }, take: limit, select: { id: true, name: true } });
    return configs.map((config) => ({ kind: "CONFIG" as const, id: config.id, label: config.name }));
  }

  // Devices: most recently seen first, because those are the ones a threshold can act on.
  const devices = await prisma.device.findMany({
    orderBy: [{ lastSeenAt: "desc" }, { createdAt: "desc" }],
    take: limit,
    select: { id: true, displayName: true, deviceId: true },
  });
  return devices.map((device) => ({
    kind: "DEVICE" as const,
    id: device.id,
    label: `${device.displayName} (${device.deviceId.slice(0, 8)})`,
  }));
}

export { GB as POLICY_GB };
