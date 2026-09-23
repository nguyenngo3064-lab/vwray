/**
 * Domain event vocabulary.
 *
 * This is the control plane's internal event contract. It is deliberately separate from
 * `src/server/realtime/bus.ts`:
 *
 *   * the realtime bus carries DERIVED STATE to the browser (rates, counters, statuses)
 *     and is allowed to be lossy, because a dropped frame is redrawn a second later;
 *   * these domain events describe FACTS that already happened and that other engines
 *     must react to (analytics, notifications, automation, audit, timeline).
 *
 * Every name below is `resource.past_tense_verb`. Adding one is the only way to emit an
 * event, which keeps the set of facts a subscriber can observe finite and reviewable.
 *
 * Design rule: payloads carry identifiers and measured values, never secrets, never a
 * credential, never a session token. Subscribers re-read whatever else they need from
 * the database, so an event can never become a covert side channel for sensitive data.
 */

import type { DataSource } from "@prisma/client";

export interface DeviceConnectedPayload {
  ts: number;
  deviceId: string;
  deviceLabel: string;
  nodeId: string | null;
  nodeLabel: string | null;
  sessionId: string | null;
  gatewaySessionId: string | null;
  /** Attribution of the connection event itself, for mock/real separation. */
  source: DataSource;
}

export interface DeviceDisconnectedPayload {
  ts: number;
  deviceId: string;
  deviceLabel: string;
  nodeId: string | null;
  nodeLabel: string | null;
  sessionId: string | null;
  /** `null` when the gateway reported no reason: the console must show "not reported". */
  reason: string | null;
  endReason: string | null;
  bytesUp: string;
  bytesDown: string;
  source: DataSource;
}

export interface QuotaEventPayload {
  ts: number;
  quotaId: string;
  scope: string;
  scopeRefId: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  thresholdPct: number;
  usedBytes: string;
  limitBytes: string;
  percent: number | null;
  /** Set for `quota.exceeded`: what the enforcement transaction actually did. */
  sessionsClosed?: number;
  reconnectBlocked?: boolean;
}

export interface NodeHealthChangedPayload {
  ts: number;
  nodeId: string;
  nodeLabel: string;
  from: string;
  to: string;
  /** Why the state changed, in the platform's own words. */
  reason: string;
  lastHeartbeatAt: number | null;
}

export interface TrafficAnomalyPayload {
  ts: number;
  anomalyId: string;
  anomalyType: string;
  severity: string;
  deviceId: string | null;
  nodeId: string | null;
  label: string;
  /** Neutral, factual sentence. Never an accusation. */
  summary: string;
}

export interface OptimizationPayload {
  ts: number;
  deviceId: string | null;
  nodeId: string | null;
  profileKey: string;
  measurementKind: "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";
  savedBytes: string | null;
  savingPct: number | null;
}

export interface PolicyTriggeredPayload {
  ts: number;
  policyId: string;
  policyName: string;
  executionId: string;
  actionKey: string;
  targetKind: string;
  targetId: string | null;
  targetLabel: string | null;
  metric: string;
  observed: number | null;
  threshold: number | null;
  /** True when the policy only recorded what it would have done. */
  dryRun: boolean;
  suppressed: boolean;
}

export interface ReceiptCreatedPayload {
  ts: number;
  receiptId: string;
  receiptNumber: string;
  customerName: string;
  deviceId: string | null;
  currency: string;
  simulatedTotal: string;
  verificationHash: string;
  source: DataSource;
}

export interface CredentialRevokedPayload {
  ts: number;
  deviceId: string;
  deviceLabel: string;
  credentialId: string;
  reason: string;
  sessionsClosed: number;
}

export interface BudgetThresholdPayload {
  ts: number;
  budgetId: string;
  budgetName: string;
  scope: string;
  scopeRefId: string | null;
  thresholdPct: number;
  observedPct: number;
  spentAmount: string;
  limitAmount: string;
  currency: string;
  projectedAmount: string | null;
}

export interface AutomationRunPayload {
  ts: number;
  jobId: string;
  jobName: string;
  kind: string;
  status: "SUCCEEDED" | "FAILED" | "SKIPPED";
  summary: string;
  affectedCount: number;
  error: string | null;
}

export interface MaintenanceModePayload {
  ts: number;
  mode: "NORMAL" | "MAINTENANCE" | "DRAINING";
  reason: string;
  actorLabel: string;
  nodeId?: string | null;
}

export interface NodeDrainPayload {
  ts: number;
  nodeId: string;
  nodeLabel: string;
  /** Sessions still open when the event was raised. */
  remainingSessions: number;
  /** True when a drain has finished and the node has no sessions left. */
  safeToRestart: boolean;
  reason: string;
}

export interface DomainEventMap {
  "device.connected": DeviceConnectedPayload;
  "device.disconnected": DeviceDisconnectedPayload;
  "quota.warning": QuotaEventPayload;
  "quota.exceeded": QuotaEventPayload;
  "quota.reset": QuotaEventPayload;
  "node.offline": NodeHealthChangedPayload;
  "node.degraded": NodeHealthChangedPayload;
  "node.recovered": NodeHealthChangedPayload;
  "node.draining": NodeDrainPayload;
  "traffic.anomaly": TrafficAnomalyPayload;
  "optimization.completed": OptimizationPayload;
  "policy.triggered": PolicyTriggeredPayload;
  "credential.revoked": CredentialRevokedPayload;
  "receipt.created": ReceiptCreatedPayload;
  "budget.threshold": BudgetThresholdPayload;
  "automation.run": AutomationRunPayload;
  "maintenance.mode_changed": MaintenanceModePayload;
}

export type DomainEventName = keyof DomainEventMap;
export type DomainEvent<K extends DomainEventName> = {
  name: K;
  payload: DomainEventMap[K];
};

export const DOMAIN_EVENT_NAMES = [
  "device.connected",
  "device.disconnected",
  "quota.warning",
  "quota.exceeded",
  "quota.reset",
  "node.offline",
  "node.degraded",
  "node.recovered",
  "node.draining",
  "traffic.anomaly",
  "optimization.completed",
  "policy.triggered",
  "credential.revoked",
  "receipt.created",
  "budget.threshold",
  "automation.run",
  "maintenance.mode_changed",
] as const satisfies ReadonlyArray<DomainEventName>;
