"use client";

/**
 * Client-safe response shapes for automation, device timeline, explain,
 * routing, node health history, quota forecast and the A/B benchmark -
 * all against the coordinator's contract.
 */

/* ------------------------------------------------------------ automation -- */

export interface AutomationJobRecord {
  id: string;
  name: string;
  kind: string;
  enabled: boolean;
  intervalSeconds: number;
  nextRunAt?: string | null;
  lastRunAt?: string | null;
  lastStatus?: string | null;
  lastSummary?: string | null;
}

export interface AutomationRunRecord {
  id: string;
  jobId: string;
  jobName?: string | null;
  startedAt: string;
  finishedAt?: string | null;
  status: string;
  summary?: string | null;
  affectedCount?: number | null;
  error?: string | null;
}

export const AUTOMATION_JOB_KINDS = [
  "QUOTA_PERIOD_RESET",
  "TRAFFIC_AGGREGATE_ROLLUP",
  "NODE_HEALTH_CHECK",
  "ANOMALY_SWEEP",
  "POLICY_EVALUATION",
  "EXPIRED_CREDENTIAL_CLEANUP",
  "EXPIRED_CONFIG_CLEANUP",
  "RETENTION_TRAFFIC_SAMPLES",
  "RETENTION_AUDIT_LOGS",
  "RETENTION_NODE_HEALTH",
  "RETENTION_DNS_STATS",
  "BILLING_PERIOD_ROLLOVER",
  "REPORT_GENERATION",
  "RECEIPT_ISSUE",
] as const;

/* --------------------------------------------------------------- devices -- */

export interface TimelineEvent {
  id: string;
  ts: string;
  type: string;
  typeLabel?: string | null;
  reason?: string | null;
  nodeLabel?: string | null;
  bytesUp?: string | null;
  bytesDown?: string | null;
  actor?: string | null;
  actorLabel?: string | null;
  severity?: string | null;
  repeatCount?: number | null;
  metadata?: unknown;
}

export interface TimelinePageData {
  items: TimelineEvent[];
  total: number;
}

export interface ExplainFact {
  label: string;
  value: string;
  source?: string | null;
  calculation?: string | null;
}

export interface ExplainData {
  title: string;
  question: string;
  reason: string | null;
  facts: ExplainFact[];
  events: Array<{ ts: string; type: string; reason?: string | null }>;
  available: boolean;
}

/* ---------------------------------------------------------------- nodes --- */

export interface RoutingData {
  mode: "AUTO" | "MANUAL";
  autoMoveActiveSessions: boolean;
  weights: { latency: number; jitter: number; packetLoss: number; load: number; stability: number };
  nodes: Array<{
    nodeId: string;
    id: string;
    name: string;
    eligible: boolean;
    ineligibleReason: string | null;
    routeScore: number | null;
    metrics: Array<{
      key: string;
      label: string;
      value: number | null;
      weight: number;
      contribution: number | null;
      available: boolean;
    }>;
  }>;
}

export interface NodeHealthHistoryData {
  samples: Array<{
    ts: string;
    cpuPercent: number | null;
    ramPercent: number | null;
    bandwidthMbps: number | null;
    latencyMs: number | null;
    packetLossPct: number | null;
    activeSessions: number | null;
  }>;
  timeline: Array<{ ts: string; type: string; label: string; reason?: string | null }>;
  stateTransitions: Array<{ ts: string; from: string; to: string; reason?: string | null }>;
}

/* -------------------------------------------------------------- forecast -- */

export interface QuotaForecastData {
  available: boolean;
  reason?: string | null;
  usedBytes?: string | null;
  limitBytes?: string | null;
  remainingBytes?: string | null;
  rateBytesPerHour?: string | number | null;
  etaSeconds?: number | null;
  confidence?: "LOW" | "MEDIUM" | "HIGH" | null;
  historyHours?: number | null;
}

/* ----------------------------------------------------------- optimization - */

export interface BenchmarkVariant {
  key?: string;
  label?: string;
  name?: string;
  [metric: string]: unknown;
}

export interface BenchmarkPayload {
  variants?: BenchmarkVariant[];
  a?: BenchmarkVariant | null;
  b?: BenchmarkVariant | null;
  baseline?: BenchmarkVariant | null;
  candidate?: BenchmarkVariant | null;
  summary?: string | null;
  disclaimer?: string | null;
  available?: boolean;
  reason?: string | null;
  [key: string]: unknown;
}
