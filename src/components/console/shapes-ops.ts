"use client";

/**
 * Client-safe response shapes for heatmap and policies, against the
 * coordinator's contract. Optional fields are exactly those the contract
 * marks optional or omits entirely.
 */

/* -------------------------------------------------------------- heatmap --- */

export interface HeatmapCellDetail {
  ts: string | null;
  bytes: string;
  devices: Array<{ id: string; label: string; bytes: string }>;
  nodes: Array<{ id: string; label: string; bytes: string }>;
}

export interface HeatmapData {
  dim: string;
  cells: Array<{ row: string; col: string; bytes: string; level: "low" | "medium" | "high" | "peak" | null }>;
  rows: Array<{ id: string; label: string }>;
  cols: Array<{ id: string; label: string }>;
  detail?: { bytes: string; devices: number; nodes: number; ts: string | null };
}

/* -------------------------------------------------------------- policies -- */

export interface PolicyConditionShape {
  metric: string;
  operator: string;
  value: number;
  windowSeconds?: number;
}

export interface PolicyActionShape {
  key: string;
  params?: Record<string, unknown>;
}

export interface PolicyRecord {
  id: string;
  name: string;
  description?: string | null;
  targetKind: string;
  condition: PolicyConditionShape;
  action: PolicyActionShape;
  priority?: number | null;
  cooldownSeconds?: number | null;
  dryRun?: boolean | null;
  enabled?: boolean | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastEvaluatedAt?: string | null;
  overrideUntil?: string | null;
  overrideReason?: string | null;
}

export interface PolicyListData {
  items: PolicyRecord[];
  total: number;
}

export interface SimulateTarget {
  id: string;
  label: string;
  observed: number | null;
  threshold: number;
  satisfied: boolean | null;
  reason?: string | null;
}

export interface SimulateData {
  evaluated: number;
  matched: number;
  unavailable: number;
  alreadySatisfied: number;
  byAction: Record<string, number>;
  targets: SimulateTarget[];
  summary?: string | null;
}

/** Closed vocabularies mirrored from the policy schema, for the create form. */
export const POLICY_METRICS = [
  "QUOTA_PERCENT",
  "QUOTA_USED_BYTES",
  "DEVICE_UPLOAD_BYTES_PER_HOUR",
  "DEVICE_DOWNLOAD_BYTES_PER_HOUR",
  "TRAFFIC_SPIKE_FACTOR",
  "DEVICE_CONNECTIONS",
  "DEVICE_RECONNECTS",
  "AUTH_FAILURES",
  "NODE_CPU_PERCENT",
  "NODE_RAM_PERCENT",
  "NODE_PACKET_LOSS_PCT",
  "NODE_LATENCY_MS",
  "NODE_ACTIVE_SESSIONS",
  "NODE_SESSION_HEADROOM_PERCENT",
  "NODE_ONLINE",
  "BUDGET_PERCENT",
  "DEVICE_QUOTA_EXCEEDED",
  "DEVICE_BLOCKED",
] as const;

export const POLICY_ACTIONS = [
  "NOTIFY",
  "QUOTA_WARNING",
  "DISCONNECT_SESSION",
  "BLOCK_DEVICE_RECONNECT",
  "MARK_NODE_DEGRADED",
  "LOWER_NODE_ROUTING_PRIORITY",
  "STOP_NEW_ASSIGNMENTS",
  "CREATE_ANOMALY_EVENT",
  "APPLY_OPTIMIZATION_PROFILE",
  "DRAIN_NODE",
  "SET_DEVICE_SECURITY_REVIEW",
  "REQUEST_REPORT",
] as const;

export const POLICY_TARGET_KINDS = ["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"] as const;
export const POLICY_OPERATORS = ["GTE", "GT", "LTE", "LT", "EQ", "NEQ"] as const;
