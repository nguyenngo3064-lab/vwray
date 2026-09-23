"use client";

/**
 * Client-safe response shapes for the dashboard payload family:
 * /api/overview, /api/system/status, /api/insights and notifications.
 * Optional blocks are exactly those the coordinator may add later; absent ones
 * render "No data available" instead of being invented by the UI.
 */

import type { StreamStatus } from "@/lib/realtime/types";

export interface OverviewAnomaly {
  id?: string;
  ts?: number | string;
  severity?: string;
  label?: string;
  reason?: string;
}

export interface OverviewPolicyEvent {
  id?: string;
  ts?: number | string;
  policyName?: string;
  actionKey?: string;
  targetLabel?: string;
}

export interface OverviewPayload {
  system: unknown;
  network: {
    activeConnections: number;
    devicesTotal: number;
    devicesOnline: number;
    devicesPending: number;
    devicesBlocked: number;
    devicesQuotaExceeded: number;
    uploadBps: number;
    downloadBps: number;
    totalBps: number;
    realtimeStatus: StreamStatus;
  };
  data: {
    usedTodayBytes: string;
    usedMonthBytes: string;
    remainingQuotaBytes: string | null;
    quotaLimitBytes: string | null;
    optimizedBytesMonth: string | null;
    savedBytesMonth: string | null;
    savingPct: number | null;
    savingsKind: "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";
    estimatedCostToday: number | null;
    estimatedCostMonth: number | null;
    currency: string;
    /** Optional explainability, present only when the API supplies it. */
    explanation?: string | null;
    source?: string | null;
    calculation?: string | null;
    formula?: string | null;
  };
  quota: { exceededCount: number; warnedCount: number; thresholds: number[] };
  traffic: {
    granularity: string;
    series: Array<{ t: number; uploadBytes: string; downloadBytes: string; totalBytes: string }>;
  };
  consumers: Array<{ rank: number; dimension: string; label: string; bytes: string; sharePct: number | null }>;
  recentNodes: Array<{
    id: string;
    nodeId: string;
    name: string;
    health: string;
    activeSessions: number;
    cpuPercent: number | null;
    ramPercent: number | null;
    lastHeartbeatAt: number | null;
  }>;
  alerts: { openAnomalies: number; unreadNotifications: number };
  quotaEnforcementEnabled: boolean;
  hasRealTraffic: boolean;
  mockDataPresent: boolean;
  generatedAt: number;
  anomalies?: OverviewAnomaly[];
  policyEvents?: OverviewPolicyEvent[];
  cost?: {
    explanation?: string | null;
    source?: string | null;
    calculation?: string | null;
    formula?: string | null;
  } | null;
}

export interface SystemStatusPayload {
  ts: number;
  controlPlane: "up" | "degraded" | "down";
  database: { state: "up" | "down"; latencyMs: number | null };
  realtime: { clients: number; lastTickAt: number | null; status: StreamStatus };
  gateway: {
    state: "connected" | "degraded" | "unavailable" | "unknown";
    nodesOnline: number;
    nodesTotal: number;
    lastHeartbeatAt: number | null;
    mockOnly: boolean;
  };
  dns: { state: "up" | "disabled" | "unknown"; provider: string };
  optimization: { state: "up" | "unknown"; profilesEnabled: number };
  mode: "development" | "production" | "test";
  devMockEnabled: boolean;
}

export interface InsightStatement {
  id: string;
  text: string;
  source?: string | null;
  evidence?: unknown;
}

export interface InsightsData {
  statements: InsightStatement[];
}

export type NotificationSeverity = "INFO" | "WARNING" | "CRITICAL";

export interface NotificationItem {
  id: string;
  createdAt: string;
  severity: NotificationSeverity;
  type: string;
  title: string;
  body: string;
  resource: string | null;
  resourceId: string | null;
  readAt: string | null;
}
