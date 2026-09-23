/**
 * Typed mirror of the console API contract.
 *
 * These types exist so the browser never guesses at a response shape. They are pure
 * types plus small, side-effect-free label/tone helpers, so importing this module from
 * a server component is safe (no "use client", no React import, no browser API).
 *
 * Byte counts cross the wire as decimal strings (they are Postgres `BigInt` on the
 * server), therefore every byte field here is `string | null` and is parsed through
 * `toNumber`, which answers `null` instead of `NaN` when a value is absent. A missing
 * measurement must reach the UI as `null`: the helpers in `@/lib/format/units` then
 * print "Unavailable" rather than a fabricated zero.
 */

import type { Tone } from "@/components/ui/primitives";
import type { StreamStatus } from "@/lib/realtime/types";

export type { StreamStatus };

/** Byte counts arrive as decimal strings; `null` means "not measured". */
export type ByteString = string | null;

/** Parses a wire byte-count into a number, or `null` when it is not a measurement. */
export function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/* ------------------------------------------------------------------ system --- */

export type ControlPlaneState = "up" | "degraded" | "down";
export type GatewayState = "connected" | "degraded" | "unavailable" | "unknown";
export type DnsState = "up" | "disabled" | "unknown";
export type EngineState = "up" | "unknown";
export type NodeHealth = "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
export type SavingsKind = "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";

export interface SystemStatus {
  controlPlane: ControlPlaneState;
  database: { state: "up" | "down"; latencyMs: number | null };
  realtime: { clients: number; lastTickAt: number | null; status: StreamStatus };
  gateway: {
    state: GatewayState;
    nodesOnline: number;
    nodesTotal: number;
    lastHeartbeatAt: number | null;
    mockOnly: boolean;
  };
  dns: { state: DnsState };
  optimization: { state: EngineState };
  mode: "development" | "production" | "test";
  devMockEnabled: boolean;
  /**
   * Not part of the pinned contract today. The console reads it defensively so a
   * control plane that exposes the maintenance switch renders an honest banner, and
   * stays silent (rather than guessing) when the field is absent.
   */
  maintenance?: { enabled: boolean; message?: string | null } | null;
}

/* ---------------------------------------------------------------- overview --- */

export interface TrafficSeriesPoint {
  t: number;
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  optimizedBytes?: ByteString;
}

export interface RecentNode {
  id: string;
  nodeId: string;
  name: string;
  health: NodeHealth;
  activeSessions: number;
  cpuPercent: number | null;
  ramPercent: number | null;
  lastHeartbeatAt: number | null;
}

export interface OverviewResponse {
  system: SystemStatus;
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
    remainingQuotaBytes: ByteString;
    quotaLimitBytes: ByteString;
    optimizedBytesMonth: ByteString;
    savedBytesMonth: ByteString;
    savingPct: number | null;
    savingsKind: SavingsKind;
    estimatedCostToday: number | null;
    estimatedCostMonth: number | null;
    currency: string;
  };
  quota: { exceededCount: number; warnedCount: number; thresholds: number[] };
  traffic: { granularity: string; series: TrafficSeriesPoint[] };
  consumers: Array<{ rank: number; dimension: string; label: string; bytes: string; sharePct: number | null }>;
  recentNodes: RecentNode[];
  alerts: { openAnomalies: number; unreadNotifications: number };
  quotaEnforcementEnabled: boolean;
  hasRealTraffic: boolean;
  mockDataPresent: boolean;
  generatedAt: number;
}

/* ----------------------------------------------------------------- traffic --- */

export type TrafficPreset = "today" | "7d" | "30d" | "custom";
export type TrafficDirection = "UPLOAD" | "DOWNLOAD";
export type TrafficGranularity = "MINUTE" | "HOUR" | "DAY";
export type TrafficSource = "REAL" | "MOCK" | "ALL";
export type ConsumerDimension = "device" | "user" | "node" | "destination" | "domain" | "category" | "ip";

export interface Channel {
  id: string | null;
  label: string;
  bytes: string;
  optimizedBytes: ByteString;
}

export interface FilterOption {
  id: string;
  label: string;
}

export interface TrafficResponse {
  range: { start: string; end: string; preset: string; granularity: string };
  series: TrafficSeriesPoint[];
  summary: {
    downloadBytes: string;
    uploadBytes: string;
    totalBytes: string;
    optimizedBytes: ByteString;
    savedBytes: ByteString;
    savingPct: number | null;
    savingsKind: SavingsKind;
    peakBps: number | null;
    avgBps: number | null;
    peakBucketStart: string | null;
    packets: number | null;
    connections: number | null;
  };
  breakdown: { byNode: Channel[]; byDevice: Channel[]; byUser: Channel[]; byCategory: Channel[] };
  filters: {
    devices: FilterOption[];
    nodes: FilterOption[];
    users: FilterOption[];
    categories: string[];
  };
  mockRowsExcluded: number;
  unavailable: { packets: boolean; connections: boolean; latency: boolean };
}

export type AttributionKind = "DNS" | "SNI" | "HOST_HEADER" | "IP_ONLY" | "NONE" | null;

export interface ConsumerItem {
  rank: number;
  dimension: string;
  label: string;
  sublabel: string | null;
  bytes: string;
  sharePct: number | null;
  optimizedBytes: ByteString;
  savedBytes: ByteString;
  savingPct: number | null;
  category: string | null;
  protocol: string | null;
  attribution: AttributionKind;
  confidence: number | null;
}

export interface ConsumersResponse {
  dimension: string;
  appAttributionAvailable: false;
  /** Rendered verbatim: it is the API's own statement about attribution limits. */
  note: string;
  items: ConsumerItem[];
}

/* -------------------------------------------------------------------- data --- */

export interface DataBucket {
  key: string;
  downloadBytes: string;
  uploadBytes: string;
  totalBytes: string;
}

export interface QuotaItem {
  id: string;
  scope: string;
  label: string;
  limitBytes: string;
  usedBytes: string;
  remainingBytes: string;
  percent: number | null;
  state: string;
  resetAt: string | null;
}

export interface DataOverviewResponse {
  realtime: {
    status: StreamStatus;
    uploadBps: number;
    downloadBps: number;
    totalBps: number;
    activeConnections: number;
    nodes: Array<{ nodeId: string; uploadBps: number; downloadBps: number; sessions: number }>;
  };
  history: { daily: DataBucket[]; weekly: DataBucket[]; monthly: DataBucket[] };
  consumers: { items: ConsumerItem[] };
  quota: { items: QuotaItem[]; thresholds: number[]; enforcementEnabled: boolean };
  optimization: {
    originalBytes: string;
    optimizedBytes: string;
    savedBytes: string;
    actualSavingPct: number | null;
    kind: SavingsKind;
    target: { min: number; max: number };
  };
  cost: {
    currency: string;
    periodStart: string;
    periodEnd: string;
    rawBytes: string;
    optimizedBytes: string;
    savedBytes: string;
    billableGb: number;
    computedCost: number;
    costWithoutOptimization: number;
    savedCost: number;
    projection: { available: boolean; projectedCost: number | null; reason: string | null };
  };
  mockDataPresent: boolean;
  hasRealTraffic: boolean;
  generatedAt: number;
}

/* -------------------------------------------------------------- auth, bell --- */

export interface ConsoleUser {
  username: string;
  displayName: string;
  role: string;
}

export interface AuthStateResponse {
  needsBootstrap: boolean;
  authenticated: boolean;
  user: ConsoleUser | null;
  expiresAt: string | null;
}

export interface LoginResponse {
  user: ConsoleUser;
  expiresAt: string;
  csrfToken: string;
}

export interface BootstrapResponse {
  created: boolean;
  username?: string;
  accessCode?: string;
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
  webhookDeliveredAt: string | null;
  webhookStatus: string | null;
}

export interface NotificationsResponse {
  items: NotificationItem[];
  total: number;
  unread: number;
}

/* ------------------------------------------------------------------ helpers --- */

/**
 * Tone for a realtime feed state. `mock` is a warning, not info: a mock feed is a
 * development-only condition that must be impossible to miss.
 */
export function streamStatusTone(status: StreamStatus | null): Tone {
  switch (status) {
    case "live":
      return "info";
    case "idle":
      return "neutral";
    case "stale":
      return "danger";
    case "mock":
      return "warning";
    default:
      return "neutral";
  }
}

/** Human wording for a feed state. `stale` never renders as a zero line. */
export function streamStatusLabel(status: StreamStatus | null): string {
  switch (status) {
    case "live":
      return "live";
    case "idle":
      return "No realtime traffic data";
    case "stale":
      return "Gateway unavailable";
    case "mock":
      return "DEV - mock feed";
    default:
      return "Unavailable";
  }
}

export function controlPlaneTone(state: ControlPlaneState): Tone {
  return state === "up" ? "success" : state === "degraded" ? "warning" : "danger";
}

export function gatewayTone(state: GatewayState): Tone {
  switch (state) {
    case "connected":
      return "success";
    case "degraded":
      return "warning";
    case "unavailable":
      return "danger";
    default:
      return "neutral";
  }
}

/** Shared tone for the `up | degraded | disabled | down` vocabulary of the services. */
export function serviceTone(state: string): Tone {
  switch (state) {
    case "up":
    case "connected":
    case "ok":
      return "success";
    case "degraded":
      return "warning";
    case "disabled":
      return "neutral";
    case "down":
    case "unavailable":
      return "danger";
    default:
      return "neutral";
  }
}

export function healthTone(health: NodeHealth): Tone {
  switch (health) {
    case "ONLINE":
      return "success";
    case "DEGRADED":
      return "warning";
    case "OFFLINE":
      return "danger";
    default:
      return "neutral";
  }
}

export function severityTone(severity: NotificationSeverity): Tone {
  switch (severity) {
    case "CRITICAL":
      return "danger";
    case "WARNING":
      return "warning";
    default:
      return "info";
  }
}

/**
 * Savings are only ever claimed at the strength the API reports. ESTIMATED is shown as
 * an estimate and INSUFFICIENT_DATA is shown as exactly that, never as 0%.
 */
export function savingsKindLabel(kind: SavingsKind): string {
  switch (kind) {
    case "MEASURED":
      return "measured";
    case "ESTIMATED":
      return "estimated";
    default:
      return "insufficient data";
  }
}

export function savingsKindTone(kind: SavingsKind): Tone {
  switch (kind) {
    case "MEASURED":
      return "info";
    case "ESTIMATED":
      return "warning";
    default:
      return "neutral";
  }
}

/** Quota state strings are rendered verbatim; only the tone is inferred from them. */
export function quotaStateTone(state: string): Tone {
  const normalised = state.toUpperCase();
  if (normalised.includes("EXCEED") || normalised.includes("BLOCK") || normalised.includes("OVER")) return "danger";
  if (normalised.includes("WARN") || normalised.includes("NEAR")) return "warning";
  if (normalised.includes("OK") || normalised.includes("ACTIVE") || normalised.includes("NORMAL")) return "success";
  return "neutral";
}

export function attributionLabel(attribution: AttributionKind): string {
  switch (attribution) {
    case "DNS":
      return "DNS";
    case "SNI":
      return "SNI";
    case "HOST_HEADER":
      return "Host header";
    case "IP_ONLY":
      return "IP only";
    case "NONE":
      return "None";
    default:
      return "Unavailable";
  }
}

export function consumerDimensionLabel(dimension: string): string {
  switch (dimension) {
    case "device":
      return "Device";
    case "user":
      return "User";
    case "node":
      return "VPN node";
    case "destination":
      return "Destination";
    case "domain":
      return "Domain";
    case "category":
      return "Category";
    case "ip":
      return "IP address";
    default:
      return dimension;
  }
}
