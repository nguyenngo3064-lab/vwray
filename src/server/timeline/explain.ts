import "server-only";
import { prisma } from "@/server/db/client";
import { quotaPercent } from "@/lib/format/units";
import { getRoutingState } from "@/server/routing/score";
import { listTimeline } from "@/server/timeline/service";

/**
 * Explainability - the "WHY?" surface.
 *
 * Every explanation is assembled from rows that exist right now: the disconnect event the
 * gateway actually reported, the quota figures the enforcement transaction recorded, the
 * gateway policy revision the agent actually pulled, the policy execution's own evidence.
 *
 * When the platform does not know why, `reason` is null and the console says so. There is
 * no prose generator here that could smooth over missing data, because a plausible
 * explanation with no source is worse than no explanation at all.
 */

export interface ExplanationFact {
  label: string;
  value: string;
  source: string;
  calculation?: string;
}

export interface Explanation {
  available: boolean;
  subject: string;
  id: string;
  question: string;
  title: string;
  reason: string | null;
  facts: ExplanationFact[];
  events: Array<{ ts: string; type: string; reason: string | null; actor: string }>;
  notice?: string;
}

const GB = 1024 ** 3;
const gb = (bytes: bigint | string): string => (Number(bytes) / GB).toFixed(2);

function empty(subject: string, id: string, question: string, title: string, reason: string): Explanation {
  return { available: false, subject, id, question, title, reason, facts: [], events: [] };
}

async function explainDevice(id: string): Promise<Explanation> {
  const question = "WHY WAS THIS DEVICE DISCONNECTED?";
  const title = "Device disconnection";
  const device = await prisma.device.findUnique({ where: { id } });
  if (!device) return empty("device", id, question, title, "Device not found.");

  const timeline = await listTimeline({ deviceId: id, page: 1, pageSize: 25, types: [
    "DEVICE_DISCONNECTED",
    "QUOTA_EXCEEDED",
    "SESSION_REVOKED",
    "POLICY_TRIGGERED",
    "SECURITY_EVENT",
    "CREDENTIAL_REVOKED",
    "DEVICE_BLOCKED",
  ] });

  const [quota, gatewayStates, openSessions, allSessions] = await Promise.all([
    prisma.quota.findFirst({ where: { scope: "DEVICE", scopeRefId: id } }),
    prisma.gatewayPolicyState.findMany({ where: { deviceId: id } }),
    prisma.vpnSession.count({ where: { deviceId: id, endedAt: null } }),
    prisma.vpnSession.count({ where: { deviceId: id } }),
  ]);

  const facts: ExplanationFact[] = [];
  let reason: string | null = null;

  const disconnect = timeline.items.find((entry) => entry.type === "DEVICE_DISCONNECTED");
  const quotaEvent = timeline.items.find((entry) => entry.type === "QUOTA_EXCEEDED");

  if (quota?.exceededAt) {
    const percent = quotaPercent(quota.usedBytes, quota.limitBytes);
    reason = "Quota exceeded";
    facts.push({
      label: "Used",
      value: `${gb(quota.usedBytes)} GB`,
      source: `Quota ${quota.id} (usedBytes)`,
    });
    facts.push({
      label: "Limit",
      value: `${gb(quota.limitBytes)} GB`,
      source: `Quota ${quota.id} (limitBytes)`,
    });
    facts.push({
      label: "Consumption",
      value: percent === null ? "Unavailable" : `${percent.toFixed(2)}%`,
      source: "quotaPercent(usedBytes, limitBytes)",
      calculation: percent === null ? undefined : `${gb(quota.usedBytes)} GB ÷ ${gb(quota.limitBytes)} GB × 100`,
    });
    facts.push({
      label: "Exceeded at",
      value: quota.exceededAt.toISOString(),
      source: "Quota.exceededAt (written inside the enforcement transaction)",
    });
    facts.push({
      label: "Action",
      value: "VPN sessions revoked",
      source: `VpnSession rows closed with endReason=QUOTA_EXCEEDED (${allSessions - openSessions} closed total for this device)`,
    });
    const blocked = gatewayStates.some((state) => state.state === "BLOCKED" || state.state === "QUOTA_EXCEEDED");
    facts.push({
      label: "Reconnect",
      value: blocked ? "Blocked" : "Allowed",
      source: blocked
        ? `GatewayPolicyState state=${gatewayStates.find((s) => s.state === "BLOCKED" || s.state === "QUOTA_EXCEEDED")?.state} (agent enforces)`
        : "No blocking GatewayPolicyState exists for this device",
    });
  } else if (device.blockedAt) {
    reason = device.blockedReason ?? "Device blocked";
    facts.push({ label: "Blocked at", value: device.blockedAt.toISOString(), source: "Device.blockedAt" });
    facts.push({ label: "Blocked reason", value: reason, source: "Device.blockedReason" });
    facts.push({
      label: "Reconnect",
      value: "Blocked",
      source: "GatewayPolicyState BLOCKED rows are pulled by the agent",
    });
  } else if (disconnect?.reason) {
    reason = disconnect.reason;
    facts.push({
      label: "Reported reason",
      value: disconnect.reason,
      source: `ConnectionEvent ${disconnect.id} written from the gateway's disconnect report`,
    });
  }

  facts.push({
    label: "Connection status",
    value: device.connectionStatus,
    source: "Device.connectionStatus",
  });
  facts.push({
    label: "Open sessions",
    value: String(openSessions),
    source: "VpnSession.count(endedAt = null)",
  });
  for (const state of gatewayStates) {
    facts.push({
      label: `Gateway policy (rev ${state.revision})`,
      value: `${state.state} - ${state.reason}`,
      source: `GatewayPolicyState ${state.id}; agent acked ${state.ackedAt ? state.ackedAt.toISOString() : "not yet"}`,
    });
  }
  if (quotaEvent) {
    facts.push({
      label: "Quota event",
      value: quotaEvent.reason ?? "recorded",
      source: `ConnectionEvent ${quotaEvent.id}`,
    });
  }

  return {
    available: true,
    subject: "device",
    id,
    question,
    title: `${title} - ${device.displayName}`,
    // Null is meaningful: the gateway did not report a reason and no quota/block applies.
    reason: reason ?? (disconnect ? disconnect.reason : "Not reported: no disconnect event, quota breach or block applies to this device."),
    facts,
    events: timeline.items.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      reason: entry.reason,
      actor: entry.actorLabel ?? entry.actor,
    })),
    notice: "Generated only from stored events, quota state and gateway policy rows.",
  };
}

async function explainNode(id: string): Promise<Explanation> {
  const question = "WHY WAS THIS NODE SELECTED?";
  const title = "Node selection";
  const node = await prisma.vpnNode.findUnique({ where: { id } });
  if (!node) return empty("node", id, question, title, "Node not found.");

  const state = await getRoutingState();
  const view = state.nodes.find((entry) => entry.id === id);
  const facts: ExplanationFact[] = [];

  facts.push({ label: "Routing mode", value: state.mode, source: "Setting nodes.autoSelectionEnabled" });
  facts.push({
    label: "Active sessions",
    value: String(node.activeSessions),
    source: "VpnNode.activeSessions (reported by the agent)",
  });
  facts.push({
    label: "Assigned weight",
    value: String(node.weight),
    source: "VpnNode.weight (operator/policy configured)",
  });

  if (!view) {
    return {
      available: false,
      subject: "node",
      id,
      question,
      title: `${title} - ${node.name}`,
      reason: "No routing evaluation exists for this node.",
      facts,
      events: [],
    };
  }

  facts.push({
    label: "Routing score",
    value: view.routeScore === null ? "Unavailable" : `${view.routeScore} / 100`,
    source:
      view.routeScore === null
        ? "No metric could be measured, so no score exists."
        : "Weighted normalisation of the measured metrics listed below, divided by the weight that was actually measurable.",
    calculation:
      view.routeScore === null
        ? undefined
        : `coverage ${Math.round((view.coverage ?? 0) * 100)}% of total weight; weights ${JSON.stringify(state.weights)}`,
  });
  facts.push({
    label: "Eligible for new sessions",
    value: view.eligible ? "Yes" : "No",
    source: view.ineligibleReason ?? "Health, drain, maintenance and pool policy checks passed.",
  });

  for (const metric of view.metrics) {
    facts.push({
      label: metric.label,
      value: metric.available ? `${metric.value}${metric.unit}` : "Unavailable",
      source: metric.available
        ? `${metric.source ?? "measured"}; contributes ${metric.contribution?.toFixed(1) ?? "0"} of ${metric.weight} weight points`
        : (metric.unavailableReason ?? "Not measured."),
      calculation: metric.available ? `normalised ${metric.normalized?.toFixed(0)} × weight ${metric.weight} / 100` : undefined,
    });
  }

  const recommended = state.recommendation.nodeId === id;
  const reason =
    state.mode === "MANUAL"
      ? "Routing is MANUAL: the operator assigns nodes, so the engine did not choose this one."
      : view.eligible && view.routeScore !== null
        ? recommended
          ? `Highest routing score (${view.routeScore}) among eligible nodes on the configured weights.`
          : `Eligible with score ${view.routeScore}; not the highest.`
        : (view.ineligibleReason ?? "Not eligible for automatic selection.");

  const timeline = await listTimeline({ nodeId: id, page: 1, pageSize: 10 });

  return {
    available: true,
    subject: "node",
    id,
    question,
    title: `${title} - ${node.name}`,
    reason,
    facts,
    events: timeline.items.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      reason: entry.reason,
      actor: entry.actorLabel ?? entry.actor,
    })),
    notice: "Active sessions are never moved by the routing engine; this explains placement of NEW sessions only.",
  };
}

async function explainQuota(id: string): Promise<Explanation> {
  const question = "WHY DID THIS QUOTA TRIGGER?";
  const title = "Quota trigger";
  const quota = await prisma.quota.findUnique({ where: { id } });
  if (!quota) return empty("quota", id, question, title, "Quota not found.");

  const percent = quotaPercent(quota.usedBytes, quota.limitBytes);
  const executions = await prisma.policyExecution.findMany({
    where: { metric: { in: ["QUOTA_PERCENT", "QUOTA_USED_BYTES"] }, targetId: quota.scopeRefId },
    orderBy: { evaluatedAt: "desc" },
    take: 5,
    include: { policy: { select: { name: true } } },
  });

  const facts: ExplanationFact[] = [
    { label: "Used", value: `${gb(quota.usedBytes)} GB`, source: `Quota ${quota.id} (usedBytes)` },
    { label: "Limit", value: `${gb(quota.limitBytes)} GB`, source: `Quota ${quota.id} (limitBytes)` },
    {
      label: "Consumption",
      value: percent === null ? "Unavailable" : `${percent.toFixed(2)}%`,
      source: "quotaPercent(usedBytes, limitBytes)",
      calculation: percent === null ? undefined : `${gb(quota.usedBytes)} ÷ ${gb(quota.limitBytes)} × 100`,
    },
    { label: "State", value: quota.exceededAt ? "EXCEEDED" : "within limit", source: "Quota.exceededAt" },
    { label: "Period", value: quota.period, source: "Quota.period" },
    { label: "Period start", value: (quota.periodStart ?? quota.createdAt).toISOString(), source: "Quota.periodStart" },
  ];

  for (const execution of executions) {
    facts.push({
      label: `Policy ${execution.policy.name}`,
      value: `${execution.result}: ${execution.message}`,
      source: `PolicyExecution ${execution.id} at ${execution.evaluatedAt.toISOString()}`,
      calculation:
        execution.observed === null
          ? "observed = Unavailable"
          : `observed ${execution.observed} ${execution.operator} ${execution.threshold}`,
    });
  }

  const timeline = await listTimeline({
    deviceId: quota.deviceId,
    types: ["QUOTA_WARNING", "QUOTA_EXCEEDED", "QUOTA_RESET", "QUOTA_CHANGED"],
    page: 1,
    pageSize: 10,
  });

  return {
    available: true,
    subject: "quota",
    id,
    question,
    title: `${title} - ${quota.label}`,
    reason: quota.exceededAt
      ? `Quota exceeded at ${quota.exceededAt.toISOString()} (${percent?.toFixed(1)}% of limit).`
      : percent !== null && percent >= 80
        ? `Quota crossed the ${percent >= 90 ? 90 : 80}% warning threshold (${percent.toFixed(1)}%).`
        : "Quota has not crossed a threshold.",
    facts,
    events: timeline.items.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      reason: entry.reason,
      actor: entry.actorLabel ?? entry.actor,
    })),
  };
}

async function explainAnomaly(id: string): Promise<Explanation> {
  const question = "WHY WAS THIS TRAFFIC MARKED ANOMALOUS?";
  const title = "Anomaly observation";
  const anomaly = await prisma.anomalyEvent.findUnique({ where: { id } });
  if (!anomaly) return empty("anomaly", id, question, title, "Anomaly not found.");

  const metrics = anomaly.metrics as Record<string, unknown> | null;
  const observed = typeof metrics?.observed === "number" ? metrics.observed : null;
  const threshold = typeof metrics?.threshold === "number" ? metrics.threshold : null;
  const metricName = typeof metrics?.metric === "string" ? metrics.metric : null;

  const facts: ExplanationFact[] = [
    { label: "Type", value: anomaly.type, source: "AnomalyEvent.type" },
    { label: "Detected at", value: anomaly.detectedAt.toISOString(), source: "AnomalyEvent.detectedAt" },
    { label: "Severity", value: anomaly.severity, source: "AnomalyEvent.severity" },
    { label: "Status", value: anomaly.status, source: "AnomalyEvent.status (operator review)" },
  ];
  if (metricName) facts.push({ label: "Metric", value: metricName, source: "AnomalyEvent.metrics.metric" });
  facts.push({
    label: "Observed",
    value: observed === null ? "Unavailable" : String(observed),
    source: "AnomalyEvent.metrics.observed (the measurement that triggered this)",
  });
  facts.push({
    label: "Threshold",
    value: threshold === null ? "Unavailable" : String(threshold),
    source: "AnomalyEvent.metrics.threshold",
    calculation: observed !== null && threshold !== null ? `observed ${observed} vs threshold ${threshold}` : undefined,
  });
  if (typeof metrics?.policyName === "string") {
    facts.push({
      label: "Raised by",
      value: `policy ${metrics.policyName}`,
      source: `PolicyExecution ${String(metrics.executionId ?? metrics.policyId ?? "")}`,
    });
  }

  return {
    available: true,
    subject: "anomaly",
    id,
    question,
    title: `${title} - ${anomaly.label}`,
    reason: anomaly.summary,
    facts,
    events: [],
    notice: "Anomalies are neutral observations for operator review. Nothing here asserts intent by any user.",
  };
}

async function explainOptimization(deviceId: string): Promise<Explanation> {
  const question = "WHY WAS THIS OPTIMIZATION APPLIED?";
  const title = "Optimization";
  const device = await prisma.device.findUnique({
    where: { id: deviceId },
    select: {
      id: true,
      displayName: true,
      optimizationProfile: { select: { id: true, key: true, name: true, description: true } },
    },
  });
  if (!device) return empty("optimization", deviceId, question, title, "Device not found.");

  const records = await prisma.optimizationRecord.findMany({
    where: { deviceId },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  const facts: ExplanationFact[] = [];
  if (device.optimizationProfile) {
    facts.push({
      label: "Profile",
      value: `${device.optimizationProfile.key} (${device.optimizationProfile.name})`,
      source: "OptimizationProfile assigned to this device",
    });
  } else {
    facts.push({ label: "Profile", value: "None assigned", source: "Device.optimizationProfileId is null" });
  }
  for (const record of records) {
    facts.push({
      label: `Record ${record.id.slice(0, 8)}`,
      value: `${record.kind}: saved ${record.savedBytes.toString()} bytes (${record.savingPct === null ? "pct unavailable" : `${record.savingPct}%`})`,
      source: `OptimizationRecord created ${record.createdAt.toISOString()}${record.estimationBasis ? ` - ${record.estimationBasis}` : ""}`,
    });
  }
  if (records.length === 0) {
    facts.push({
      label: "Savings",
      value: "No data available",
      source: "No OptimizationRecord exists for this device yet",
    });
  }

  const timeline = await listTimeline({ deviceId, types: ["OPTIMIZATION_ENABLED", "OPTIMIZATION_CHANGED"], page: 1, pageSize: 10 });

  return {
    available: true,
    subject: "optimization",
    id: deviceId,
    question,
    title: `${title} - ${device.displayName}`,
    reason: device.optimizationProfile
      ? `Profile ${device.optimizationProfile.key} is assigned to this device.`
      : "No optimization profile is assigned.",
    facts,
    events: timeline.items.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      reason: entry.reason,
      actor: entry.actorLabel ?? entry.actor,
    })),
    notice: "Savings figures are labelled MEASURED or ESTIMATED. A 30-60% range is a target, never a guarantee.",
  };
}

async function explainPolicy(id: string): Promise<Explanation> {
  const question = "WHY DID THIS POLICY ACT?";
  const title = "Policy execution";
  const policy = await prisma.policy.findUnique({ where: { id } });
  if (!policy) return empty("policy", id, question, title, "Policy not found.");

  const latest = await prisma.policyExecution.findFirst({
    where: { policyId: id },
    orderBy: { evaluatedAt: "desc" },
  });

  const facts: ExplanationFact[] = [
    { label: "Priority", value: String(policy.priority), source: "Policy.priority (lower runs first)" },
    { label: "Status", value: policy.status, source: "Policy.status" },
    { label: "Target", value: policy.targetKind, source: "Policy.targetKind" },
    {
      label: "Cooldown",
      value: `${policy.cooldownSeconds}s`,
      source: "Policy.cooldownSeconds (per target)",
    },
    { label: "Dry run", value: policy.dryRun ? "on" : "off", source: "Policy.dryRun" },
  ];
  if (policy.overrideUntil) {
    facts.push({
      label: "Override",
      value: `active until ${policy.overrideUntil.toISOString()}${policy.overrideReason ? ` - ${policy.overrideReason}` : ""}`,
      source: `set by ${policy.overrideLabel ?? "operator"}`,
    });
  }
  if (latest) {
    const evidence = (latest.evidence ?? {}) as Record<string, unknown>;
    facts.push({
      label: "Latest result",
      value: `${latest.result} - ${latest.message}`,
      source: `PolicyExecution ${latest.id} at ${latest.evaluatedAt.toISOString()}`,
      calculation:
        latest.observed === null
          ? `observed = Unavailable (${String(evidence.unavailableReason ?? "not measured")})`
          : `observed ${latest.observed} ${latest.operator} ${latest.threshold}`,
    });
  }

  const executions = await prisma.policyExecution.findMany({
    where: { policyId: id },
    orderBy: { evaluatedAt: "desc" },
    take: 10,
  });

  return {
    available: true,
    subject: "policy",
    id,
    question,
    title: `${title} - ${policy.name}`,
    reason: latest
      ? latest.observed === null
        ? `Last run could not measure the metric: ${latest.message}`
        : `${policy.name}: observed ${latest.observed} vs threshold ${latest.threshold} → ${latest.result}.`
      : "This policy has not been evaluated yet.",
    facts,
    events: executions.map((entry) => ({
      ts: entry.evaluatedAt.toISOString(),
      type: entry.result,
      reason: entry.message,
      actor: entry.suppressed ? `suppressed (${entry.suppressionReason ?? "unknown"})` : "policy engine",
    })),
  };
}

export async function explain(input: { subject: string; id: string }): Promise<Explanation> {
  const subject = input.subject.trim().toLowerCase();
  const id = input.id.trim();
  switch (subject) {
    case "device":
    case "device_disconnected":
    case "disconnected":
      return explainDevice(id);
    case "node":
    case "node_selection":
    case "selection":
      return explainNode(id);
    case "quota":
      return explainQuota(id);
    case "anomaly":
      return explainAnomaly(id);
    case "optimization":
      return explainOptimization(id);
    case "policy":
      return explainPolicy(id);
    default:
      return empty(subject, id, "WHY?", "Unknown subject", `No explanation source for "${subject}".`);
  }
}
