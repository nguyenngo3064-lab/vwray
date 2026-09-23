/**
 * Frozen API contract types and presentation maps for the operations pages
 * (devices, VPN nodes, configurations, quota, optimization, DNS).
 *
 * This module mirrors the served envelope field for field. Nothing here invents a
 * value: every formatter accepts null and refuses to turn it into a zero, because a
 * metric that could not be measured must render as "Unavailable" rather than 0.
 */

import type { Tone } from "@/components/ui/primitives";
import { ApiError } from "@/lib/api/client";
import { UNAVAILABLE } from "@/lib/format/units";

// ---------------------------------------------------------------- primitives --

export type ApprovalState = "PENDING" | "APPROVED" | "REJECTED" | "BLOCKED";
export type ConnectionStatus = "ONLINE" | "OFFLINE" | "CONNECTING" | "QUOTA_EXCEEDED" | "REVOKED";
export type SecurityState = "NORMAL" | "REVIEW" | "LOCKED";
export type NodeHealth = "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
export type NodeProtocol = "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
export type ConfigStatus = "ACTIVE" | "SUSPENDED" | "REVOKED" | "EXPIRED";
export type QuotaState = "ACTIVE" | "WARNED_80" | "WARNED_90" | "QUOTA_EXCEEDED" | "DISABLED";
export type QuotaScope = "SYSTEM" | "USER" | "DEVICE" | "CONFIG" | "NODE";
export type QuotaPeriod = "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
export type SavingKind = "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";
export type ByteAccounting = "none" | "counters" | "byte-exact";
export type ConnectionQuality = "none" | "basic" | "full";

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

/** `null` means the ratio is undefined (a zero limit), not 0% used. */
export interface QuotaView {
  quotaId: string;
  scope: QuotaScope;
  scopeRefId: string | null;
  label: string;
  limitBytes: string;
  usedBytes: string;
  remainingBytes: string;
  percent: number | null;
  state: QuotaState;
  exceededAt: string | null;
  resetAt: string | null;
  period: QuotaPeriod;
  deviceLabel: string | null;
  warned80At: string | null;
  warned90At: string | null;
}

export interface NodeRef {
  nodeId: string;
  name: string;
}

// ------------------------------------------------------------------- devices --

export interface DeviceCounts {
  total: number;
  online: number;
  pending: number;
  blocked: number;
  quotaExceeded: number;
}

export interface DeviceRow {
  id: string;
  deviceId: string;
  displayName: string;
  client: string;
  platform: string;
  publicSourceIp: string | null;
  firstSeenAt: string;
  lastSeenAt: string | null;
  connectionStatus: ConnectionStatus;
  approvalState: ApprovalState;
  securityState: SecurityState;
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  quotaExceededAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  assignedNodeId: string | null;
  assignedConfigId: string | null;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  qualityScore: number | null;
  reconnectCount: number;
  createdAt: string;
  updatedAt: string;
  approvalNote: string | null;
  assignedNode: NodeRef | null;
  blocked: boolean;
}

export interface DeviceSessionRow {
  id: string;
  nodeLabel: string;
  configLabel: string | null;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  endReason: string | null;
  bytesUp: string;
  bytesDown: string;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  reconnectCount: number;
  sourceIpMasked: string | null;
  qualityScore: number | null;
}

export interface CredentialRow {
  id: string;
  kind: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface DeviceConfigRow {
  id: string;
  name: string;
  protocol: string;
  status: ConfigStatus;
  version: number;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface DeviceTotals {
  uploadBytes: string;
  downloadBytes: string;
  totalBytes: string;
  sessionCount: number;
  qualityScore: number | null;
}

export interface DeviceDetail extends DeviceRow {
  owner: { id: string; username: string; displayName: string } | null;
  optimizationProfile: { id: string; key: string; name: string } | null;
  observedSourceIps: string[];
  sessions: DeviceSessionRow[];
  credentials: CredentialRow[];
  configs: DeviceConfigRow[];
  quotas: QuotaView[];
  activeQuota: QuotaView | null;
  totals: DeviceTotals;
}

export interface RegisteredDevice {
  id: string;
  deviceId: string;
  approvalState: ApprovalState;
}

export interface BulkResultRow {
  id: string;
  ok: boolean;
  error: string | null;
}

/** Masks the host part of an IP for display. Accepts null/undefined and returns "unknown". */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return "unknown";
  if (ip.includes(":")) {
    const parts = ip.split(":");
    if (parts.length <= 3) return ip;
    return `${parts[0]}:${parts[1]}:${parts[2]}:xxxx`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.xxx`;
}

export interface BulkResult {
  affected: number;
  failed: number;
  results: BulkResultRow[];
}

export type DeviceBulkAction =
  | "approve"
  | "reject"
  | "block"
  | "unblock"
  | "disconnect"
  | "reset-quota"
  | "assign-node"
  | "assign-profile";

// --------------------------------------------------------------------- nodes --

export interface AdapterCapabilities {
  createClient: boolean;
  revokeClient: boolean;
  disconnectClient: boolean;
  getStatus: boolean;
  getTraffic: boolean;
  applyQuota: boolean;
  generateConfig: boolean;
  byteAccounting: ByteAccounting;
  connectionQuality: ConnectionQuality;
  supportsUdpStability: boolean;
  supportsLatencyControl: boolean;
  supportsSafeCompression: boolean;
  supportsDnsFiltering: boolean;
  isDevelopmentOnly: boolean;
}

export interface NodeRow {
  id: string;
  nodeId: string;
  name: string;
  location: string;
  provider: string | null;
  publicEndpoint: string;
  port: number;
  protocol: NodeProtocol;
  adapterKey: string;
  isRealGateway: boolean;
  health: NodeHealth;
  storedHealth: string;
  version: string | null;
  agentVersion: string | null;
  cpuPercent: number | null;
  ramPercent: number | null;
  bandwidthMbps: number | null;
  activeSessions: number;
  maxSessions: number | null;
  weight: number;
  draining: boolean;
  maintenance: boolean;
  lastHeartbeatAt: string | null;
  registeredAt: string;
  updatedAt: string;
  tokenHint: string | null;
  /** Derived by the control plane from heartbeat freshness. May lag the derived value. */
  healthReason: string;
}

export interface NodeAdapterInfo {
  key: string;
  displayName: string;
  protocol: NodeProtocol;
  capabilities: AdapterCapabilities;
}

export interface NodeAdapterStatus {
  online: boolean;
  version: string | null;
  activePeers: number;
  uptimeSeconds: number | null;
  checkedAt: string;
  error: string | null;
}

export interface NodeHealthSample {
  sampledAt: string;
  cpuPercent: number | null;
  ramPercent: number | null;
  bandwidthMbps: number | null;
  activeSessions: number | null;
  latencyMs: number | null;
  packetLossPct: number | null;
}

export interface NodeSessionRow {
  id: string;
  deviceLabel: string;
  startedAt: string;
  endedAt: string | null;
  bytesUp: string;
  bytesDown: string;
  endReason: string | null;
}

export interface EnforcementRow {
  id: string;
  deviceLabel: string;
  state: "ACTIVE" | "WARNED_80" | "WARNED_90" | "QUOTA_EXCEEDED" | "BLOCKED" | "REVOKED";
  reason: string;
  revision: number;
  appliedAt: string | null;
  ackedAt: string | null;
  updatedAt: string;
}

export interface NodeDetail {
  node: NodeRow;
  adapter: NodeAdapterInfo;
  adapterStatus: NodeAdapterStatus | null;
  healthSamples: NodeHealthSample[];
  sessions: NodeSessionRow[];
  quotas: QuotaView[];
  enforcement: EnforcementRow[];
  staleSeconds: number;
  pendingPolicyCount: number;
}

export interface NodeHealthReport {
  derived: NodeHealth;
  staleSeconds: number;
  samples: NodeHealthSample[];
}

export interface NodeCreateResult {
  node: NodeRow;
  agentToken: string;
  note: string;
}

export interface NodeTokenResult {
  id: string;
  agentToken?: string;
  note?: string;
}
// ------------------------------------------------------------ configurations --

export interface ConfigRow {
  id: string;
  name: string;
  protocol: string;
  status: ConfigStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  device: { id: string; displayName: string; approvalState: ApprovalState } | null;
  node: { id: string; nodeId: string; name: string } | null;
  currentVersion: { checksum: string; createdAt: string } | null;
  summary: string;
}

export interface ConfigVersionRow {
  id: string;
  version: number;
  checksum: string;
  summary: string;
  isActive: boolean;
  changeNote: string | null;
  createdAt: string;
  supersededAt: string | null;
}

export interface ConfigDetail {
  config: ConfigRow;
  versions: ConfigVersionRow[];
  credentials: CredentialRow[];
}

export type ConfigPayloadFormat =
  | "wireguard"
  | "text"
  | "xray-json"
  | "vless-uri"
  | "vmess-uri"
  | "trojan-uri";

export interface ConfigPayload {
  payload: string;
  format: ConfigPayloadFormat;
  version: number;
  checksum: string;
  warning: string;
}

export interface GeneratedConfig {
  configId: string;
  version: number;
  payload: string;
  format: ConfigPayloadFormat;
  qrPayload: string;
  fingerprint: string;
  expiresAt: string | null;
  summary: string;
}

// --------------------------------------------------------------------- quota --

export interface QuotaOverview {
  items: QuotaView[];
  thresholds: number[];
  enforcementEnabled: boolean;
  graceBytes: string;
  resetSchedule: { autoResetEnabled: boolean };
}

// -------------------------------------------------------------- optimization --

export type OptimizationProfileKey =
  | "BALANCED"
  | "DATA_SAVER"
  | "GAMING"
  | "VIDEO_SAVER"
  | "MAXIMUM_SAVING";

export interface OptimizationProfile {
  id: string;
  key: OptimizationProfileKey;
  name: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  dnsFilteringLevel: string;
  dnsBlocklistCategories: string[];
  compressionEnabled: boolean;
  mediaOptimization: boolean;
  latencyPriority: boolean;
  udpStability: boolean;
  lowQueueing: boolean;
  aggressiveFiltering: boolean;
  routingPolicy: string;
  targetSavingMinPct: number;
  targetSavingMaxPct: number;
  requiredCapabilities: string[];
  deviceCount: number;
  updatedAt: string;
}

export interface CapabilityMatrixRow {
  adapterKey: string;
  protocol: string;
  capabilities: AdapterCapabilities;
  supportedProfiles: string[];
  unsupportedProfileReasons: Record<string, string>;
}

export interface OptimizationOverview {
  profiles: OptimizationProfile[];
  defaultProfileKey: string;
  targetRange: { min: number; max: number };
  minSampleBytesForActualSavings: string;
  capabilityMatrix: CapabilityMatrixRow[];
  assignedCounts: { profileId: string; label: string; deviceCount: number }[];
}

export interface AnalyticsSeriesPoint {
  t: number;
  originalBytes: string;
  optimizedBytes: string;
  savedBytes: string;
}

export interface AnalyticsBreakdownRow {
  key: string;
  label: string;
  originalBytes: string;
  optimizedBytes: string;
  savedBytes: string;
  savingPct: number | null;
  kind: SavingKind;
}

export interface EfficiencyRow {
  category: string;
  originalBytes: string;
  savedBytes: string;
  savingPct: number | null;
  band: "HIGH" | "MODERATE" | "LOW" | "NONE" | "UNKNOWN";
  note: string;
}

export interface AnalyticsSummary {
  originalBytes: string;
  optimizedBytes: string;
  savedBytes: string;
  actualSavingPct: number | null;
  kind: SavingKind;
  dataSufficient: boolean;
  minimumSampleBytes: string;
  target: { min: number; max: number };
  disclaimer: string;
}

export interface OptimizationAnalytics {
  range: { start: string; end: string; preset: string };
  groupBy: string;
  summary: AnalyticsSummary;
  series: AnalyticsSeriesPoint[];
  breakdown: AnalyticsBreakdownRow[];
  efficiency: EfficiencyRow[];
}

export type AnalyticsPreset = "today" | "7d" | "30d" | "custom";
export type AnalyticsGroupBy = "device" | "user" | "node" | "category" | "profile";
export type AnalyticsSource = "REAL" | "MOCK" | "ALL";

// ----------------------------------------------------------------------- DNS --

export interface DnsList {
  id: string;
  name: string;
  kind: "BLOCKLIST" | "ALLOWLIST";
  category: string | null;
  source: string | null;
  enabled: boolean;
  entryCount: number;
  updatedAt: string;
  sampleEntries: string[];
}

export interface DnsTopEntry {
  domain: string;
  count: string;
  category: string | null;
}

export interface DnsOverview {
  enabled: boolean;
  provider: string;
  providerConfigured: boolean;
  lists: DnsList[];
  stats: {
    blocked: string;
    allowed: string;
    blockedPct: number | null;
    topBlocked: DnsTopEntry[];
    topAllowed: DnsTopEntry[];
  };
  estimatedBytesSaved: string | null;
  estimationBasis: string | null;
  disclaimer: string;
}

export interface DnsSeriesPoint {
  t: number;
  blocked: string;
  allowed: string;
}

export interface DnsStats {
  range: { start: string; end: string; preset: string };
  series: DnsSeriesPoint[];
  topBlocked: DnsTopEntry[];
  topAllowed: DnsTopEntry[];
  totals: { blocked: string; allowed: string; blockedPct: number | null };
  estimatedBytesSaved: string | null;
  estimationBasis: string | null;
}

export interface DnsListMutationResult {
  id: string;
  entryCount: number;
  skipped: number;
}

export interface DnsRuleResult {
  id: string;
  action: "ALLOW" | "BLOCK";
  domain: string;
}

// ------------------------------------------------------------- formatters ----

const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", year: "numeric" });
const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

function toDate(value: string | number | null | undefined): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTime(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? DATE_TIME_FORMAT.format(date) : UNAVAILABLE;
}

export function formatDate(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? DATE_FORMAT.format(date) : UNAVAILABLE;
}

export function formatTime(value: string | number | null | undefined): string {
  const date = toDate(value);
  return date ? TIME_FORMAT.format(date) : UNAVAILABLE;
}

/** Age of a timestamp in words. Clock skew is stated, never rendered as a negative. */
export function formatRelative(value: string | number | null | undefined): string {
  const date = toDate(value);
  if (!date) return UNAVAILABLE;
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < -5) return "timestamp is in the future";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 h ago" : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 d ago" : `${days} d ago`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNAVAILABLE;
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} m`;
  return `${minutes} m`;
}

/** Byte counts arrive as decimal strings; BigInt keeps large values exact. */
export function parseByteCount(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined || value === "") return null;
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return Number.isFinite(value) ? BigInt(Math.round(value)) : null;
    return BigInt(value);
  } catch {
    return null;
  }
}

export function truncateMiddle(value: string | null | undefined, head = 10, tail = 6): string {
  if (!value) return UNAVAILABLE;
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

/** Normalises a list field the contract promises but a lagging build may omit. */
export function safeArray<T>(value: readonly T[] | null | undefined): T[] {
  return Array.isArray(value) ? [...value] : [];
}

const ENUM_LABELS: Record<string, string> = {
  PENDING: "Pending",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  BLOCKED: "Blocked",
  ONLINE: "Online",
  OFFLINE: "Offline",
  CONNECTING: "Connecting",
  QUOTA_EXCEEDED: "Quota exceeded",
  REVOKED: "Revoked",
  SUSPENDED: "Suspended",
  EXPIRED: "Expired",
  DISABLED: "Disabled",
  NORMAL: "Normal",
  REVIEW: "Review",
  LOCKED: "Locked",
  DEGRADED: "Degraded",
  UNKNOWN: "Unknown",
  ACTIVE: "Active",
  WARNED_80: "Warning at 80%",
  WARNED_90: "Warning at 90%",
  SYSTEM: "System wide",
  USER: "User",
  DEVICE: "Device",
  CONFIG: "Configuration",
  NODE: "VPN node",
  WIREGUARD: "WireGuard",
  XRAY_VLESS: "Xray VLESS",
  XRAY_VMESS: "Xray VMess",
  XRAY_TROJAN: "Xray Trojan",
  MOCK: "Mock gateway",
  DAILY: "Daily",
  WEEKLY: "Weekly",
  MONTHLY: "Monthly",
  CUSTOM: "Custom",
  AUTO: "Automatic",
  MANUAL: "Manual",
  BLOCKLIST: "Blocklist",
  ALLOWLIST: "Allowlist",
  ALLOW: "Allow",
  BLOCK: "Block",
  MEASURED: "Measured",
  ESTIMATED: "Estimated",
  INSUFFICIENT_DATA: "Insufficient data",
  HIGH: "High",
  MODERATE: "Moderate",
  LOW: "Low",
  NONE: "None",
  REAL: "Real",
  ALL: "All",
  "byte-exact": "Byte exact",
  counters: "Gateway counters",
  basic: "Basic",
  full: "Full",
  none: "Not available",
};

/** Human label for a machine token. Unknown tokens keep their readable form. */
export function enumLabel(value: string | null | undefined): string {
  if (!value) return UNAVAILABLE;
  const known = ENUM_LABELS[value];
  if (known) return known;
  const spaced = value.replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const APPROVAL_TONES: Record<string, Tone> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  BLOCKED: "danger",
};
const CONNECTION_TONES: Record<string, Tone> = {
  ONLINE: "success",
  CONNECTING: "info",
  OFFLINE: "neutral",
  QUOTA_EXCEEDED: "danger",
  REVOKED: "danger",
};
const SECURITY_TONES: Record<string, Tone> = { NORMAL: "neutral", REVIEW: "warning", LOCKED: "danger" };
const HEALTH_TONES: Record<string, Tone> = {
  ONLINE: "success",
  DEGRADED: "warning",
  OFFLINE: "danger",
  UNKNOWN: "neutral",
};
const QUOTA_TONES: Record<string, Tone> = {
  ACTIVE: "neutral",
  WARNED_80: "warning",
  WARNED_90: "warning",
  QUOTA_EXCEEDED: "danger",
  DISABLED: "neutral",
};
const CONFIG_STATUS_TONES: Record<string, Tone> = {
  ACTIVE: "success",
  SUSPENDED: "warning",
  REVOKED: "danger",
  EXPIRED: "neutral",
};
const SAVING_KIND_TONES: Record<string, Tone> = {
  MEASURED: "success",
  ESTIMATED: "warning",
  INSUFFICIENT_DATA: "neutral",
};
const ENFORCEMENT_TONES: Record<string, Tone> = {
  ACTIVE: "neutral",
  WARNED_80: "warning",
  WARNED_90: "warning",
  QUOTA_EXCEEDED: "danger",
  BLOCKED: "danger",
  REVOKED: "danger",
};

export const approvalTone = (state: string): Tone => APPROVAL_TONES[state] ?? "neutral";
export const connectionTone = (status: string): Tone => CONNECTION_TONES[status] ?? "neutral";
export const securityTone = (state: string): Tone => SECURITY_TONES[state] ?? "neutral";
export const protocolTone = (protocol: string): Tone => PROTOCOL_TONES[protocol] ?? "neutral";

const PROTOCOL_TONES: Record<string, Tone> = {
  WIREGUARD: "info",
  XRAY_VLESS: "info",
  XRAY_VMESS: "info",
  XRAY_TROJAN: "info",
  MOCK: "warning",
};

export const healthTone = (health: string): Tone => HEALTH_TONES[health] ?? "neutral";
export const quotaTone = (state: string): Tone => QUOTA_TONES[state] ?? "neutral";
export const configStatusTone = (status: string): Tone => CONFIG_STATUS_TONES[status] ?? "neutral";
export const savingKindTone = (kind: string): Tone => SAVING_KIND_TONES[kind] ?? "neutral";
export const enforcementTone = (state: string): Tone => ENFORCEMENT_TONES[state] ?? "neutral";

export function savingKindNote(kind: string): string {
  if (kind === "MEASURED") return "Computed from per-peer counters reported by the gateway.";
  if (kind === "ESTIMATED") return "Derived from an assumed response size, not from a measurement.";
  if (kind === "INSUFFICIENT_DATA") return "Not enough measured volume to state a figure.";
  return "The source of this figure was not stated by the API.";
}

// -------------------------------------------------------- derived statements --

/**
 * Why a node reads the way it reads. The API's own reason wins when present; when it
 * is absent the sentence is derived from the heartbeat clock, never assumed. A node
 * without a heartbeat can never be described as online.
 */
export function nodeHealthReason(node: {
  health: string;
  lastHeartbeatAt: string | null;
  healthReason?: string;
}): string {
  const provided = typeof node.healthReason === "string" ? node.healthReason.trim() : "";
  if (provided.length > 0) return provided;
  if (!node.lastHeartbeatAt) return "No heartbeat has ever been recorded for this node.";
  const age = formatRelative(node.lastHeartbeatAt);
  if (node.health === "ONLINE") return `Health is derived from a heartbeat received ${age}.`;
  if (node.health === "DEGRADED") return `Heartbeat is late: last received ${age}.`;
  if (node.health === "OFFLINE") return `No heartbeat since ${age}.`;
  return "Heartbeat freshness could not be derived.";
}

export type BoolCapabilityKey = {
  [K in keyof AdapterCapabilities]: AdapterCapabilities[K] extends boolean ? K : never;
}[keyof AdapterCapabilities];

const CAPABILITY_ROWS: { key: BoolCapabilityKey; label: string }[] = [
  { key: "createClient", label: "Create client" },
  { key: "revokeClient", label: "Revoke client" },
  { key: "disconnectClient", label: "Disconnect client" },
  { key: "getStatus", label: "Report status" },
  { key: "getTraffic", label: "Report traffic" },
  { key: "applyQuota", label: "Enforce quota" },
  { key: "generateConfig", label: "Generate config" },
  { key: "supportsUdpStability", label: "UDP stability" },
  { key: "supportsLatencyControl", label: "Latency control" },
  { key: "supportsSafeCompression", label: "Safe compression" },
  { key: "supportsDnsFiltering", label: "DNS filtering" },
];

/** Adapter capability list, ready for the KeyValue primitive. */
export function capabilityItems(capabilities: AdapterCapabilities): { label: string; value: string }[] {
  const items = CAPABILITY_ROWS.map((row) => ({
    label: row.label,
    value: capabilities[row.key] ? "Supported" : "Not supported",
  }));
  items.push({ label: "Byte accounting", value: enumLabel(capabilities.byteAccounting) });
  items.push({ label: "Connection quality", value: enumLabel(capabilities.connectionQuality) });
  items.push({
    label: "Adapter class",
    value: capabilities.isDevelopmentOnly ? "Development only" : "Production",
  });
  return items;
}

/**
 * What this adapter cannot do, in plain sentences. This is the honest half of the
 * capability matrix: an absent capability is why a figure reads "Unavailable".
 */
export function capabilityCaveats(capabilities: AdapterCapabilities): string[] {
  const caveats: string[] = [];
  if (capabilities.isDevelopmentOnly) {
    caveats.push(
      "This is a development-only adapter. Anything it reports is labelled DEV and is never a real measurement.",
    );
  }
  if (capabilities.byteAccounting === "none") {
    caveats.push(
      "Per-peer byte accounting is not available, so traffic volume and any saving derived from it cannot be measured on this node.",
    );
  }
  if (capabilities.byteAccounting === "counters") {
    caveats.push("Byte accounting comes from gateway counters rather than an exact per-peer read.");
  }
  if (capabilities.connectionQuality === "none") {
    caveats.push("Latency, jitter and packet loss cannot be measured through this adapter.");
  } else if (capabilities.connectionQuality === "basic") {
    caveats.push("Only basic connection quality is available: latency and loss, without a jitter breakdown.");
  }
  if (!capabilities.getTraffic) caveats.push("The adapter does not report traffic counters.");
  if (!capabilities.applyQuota) {
    caveats.push("The adapter cannot enforce a quota at the gateway, so a breach cannot disconnect a device here.");
  }
  if (!capabilities.generateConfig) caveats.push("The adapter cannot render a client configuration.");
  if (!capabilities.supportsSafeCompression) {
    caveats.push("Safe compression is not supported, so data-saving profiles cannot compress on this node.");
  }
  if (!capabilities.supportsDnsFiltering) caveats.push("DNS filtering is not supported on this adapter.");
  if (!capabilities.supportsUdpStability) caveats.push("UDP stability tuning is not supported on this adapter.");
  if (!capabilities.supportsLatencyControl) caveats.push("Latency control is not supported on this adapter.");
  return caveats;
}

/** Reads the device counts the list envelope carries, or null when it does not. */
export function readDeviceCounts(rawMeta: unknown): DeviceCounts | null {
  if (typeof rawMeta !== "object" || rawMeta === null) return null;
  const counts = (rawMeta as { counts?: unknown }).counts;
  if (typeof counts !== "object" || counts === null) return null;
  const record = counts as Record<string, unknown>;
  const total = record.total;
  const online = record.online;
  const pending = record.pending;
  const blocked = record.blocked;
  const quotaExceeded = record.quotaExceeded;
  if (
    typeof total !== "number" ||
    typeof online !== "number" ||
    typeof pending !== "number" ||
    typeof blocked !== "number" ||
    typeof quotaExceeded !== "number"
  ) {
    return null;
  }
  return { total, online, pending, blocked, quotaExceeded };
}

// ------------------------------------------------------------ error mapping ---

export type ApiStateKind =
  | "unauthenticated"
  | "forbidden"
  | "offline"
  | "notFound"
  | "rateLimited"
  | "error";

export interface ApiStateDescriptor {
  kind: ApiStateKind;
  title: string;
  message: string;
  requestId: string | null;
  retryable: boolean;
}

/**
 * Maps a failure onto the six states every page must be able to show. The API's own
 * message is preferred over a generic sentence; only the title is ours.
 */
export function describeApiError(error: ApiError, subject: string): ApiStateDescriptor {
  const requestId = error.requestId;
  if (error.status === 0) {
    return {
      kind: "offline",
      title: "Cannot reach the control plane",
      message: "The request never reached the API. Check the connection and retry.",
      requestId,
      retryable: true,
    };
  }
  if (error.status === 401 || error.code === "UNAUTHENTICATED") {
    return {
      kind: "unauthenticated",
      title: "Session expired",
      message: "Your session is no longer valid. Sign in again to continue.",
      requestId,
      retryable: false,
    };
  }
  if (error.status === 403 || error.code === "FORBIDDEN") {
    return { kind: "forbidden", title: "Not permitted", message: error.message, requestId, retryable: false };
  }
  if (
    error.status === 503 ||
    error.code === "DEPENDENCY_UNAVAILABLE" ||
    error.code === "GATEWAY_UNAVAILABLE"
  ) {
    return {
      kind: "offline",
      title: "Control plane unavailable",
      message: error.message,
      requestId,
      retryable: true,
    };
  }
  if (error.status === 404 || error.code === "NOT_FOUND") {
    return {
      kind: "notFound",
      title: `${subject} not found`,
      message: error.message,
      requestId,
      retryable: false,
    };
  }
  if (error.status === 429 || error.code === "RATE_LIMITED") {
    return { kind: "rateLimited", title: "Too many requests", message: error.message, requestId, retryable: true };
  }
  return {
    kind: "error",
    title: `Could not load ${subject}`,
    message: error.message,
    requestId,
    retryable: error.retryable,
  };
}

/** Mutation failures keep the API sentence: it is already operator-safe. */
export function mutationMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The request failed.";
}
