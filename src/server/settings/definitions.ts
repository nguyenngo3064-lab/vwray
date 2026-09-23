import type { SettingCategory } from "@prisma/client";
import { z } from "zod";

/**
 * Settings registry.
 *
 * Every configurable value is declared here with a category, a human description and
 * a Zod schema. The database stores only key/value rows; this registry is what makes
 * them typed, validated and self-documenting, so the settings page renders the whole
 * surface without a hand-maintained list and an unvalidated value can never reach an
 * engine.
 *
 * Secrets are deliberately absent: they come from the environment only (see
 * `.env.example`), never from a database row that could be exported or dumped.
 */

const gigabyte = z.number().min(0).max(1_000_000);
const percentage = z.number().min(0).max(100);
const booleanish = z.boolean();

export interface SettingDefinition<T = unknown> {
  key: string;
  category: SettingCategory;
  description: string;
  schema: z.ZodType<T>;
  defaultValue: T;
  /** True when changing it requires elevated privileges. */
  sensitive?: boolean;
  /** Rendered as a hint in the UI when the value affects enforcement. */
  impact?: string;
}

function define<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  return definition;
}

export const SETTING_DEFINITIONS = [
  // ------------------------------------------------------------- general -----
  define({
    key: "general.installationName",
    category: "GENERAL",
    description: "Name shown in the console header and on generated documents.",
    schema: z.string().min(1).max(80),
    defaultValue: "VWRAY Control Plane",
  }),
  define({
    key: "general.operatorContact",
    category: "GENERAL",
    description: "Contact shown to operators on error pages.",
    schema: z.string().max(160),
    defaultValue: "",
  }),

  // --------------------------------------------------- authentication ---------
  define({
    key: "auth.allowPasswordLogin",
    category: "AUTH",
    description: "Allow operator accounts with a password in addition to access codes.",
    schema: booleanish,
    defaultValue: false,
    sensitive: true,
  }),
  define({
    key: "auth.privateMode",
    category: "AUTH",
    description:
      "PRIVATE MODE. New devices register as PENDING and cannot connect until an operator approves them.",
    schema: booleanish,
    defaultValue: true,
    sensitive: true,
    impact: "A pending device never receives an active configuration.",
  }),
  define({
    key: "auth.rejectMessage",
    category: "AUTH",
    description:
      "Generic, client-safe text returned to a pending or rejected device. Must not describe the reason.",
    schema: z.string().min(1).max(300),
    defaultValue: "This device is not authorised to connect.",
    impact: "Returned verbatim to untrusted clients, so it must leak nothing.",
  }),

  // ------------------------------------------------------------- security ----
  define({
    key: "security.maskSourceIps",
    category: "SECURITY",
    description: "Mask the last octet of client source IPs in the console.",
    schema: booleanish,
    defaultValue: true,
  }),
  define({
    key: "security.anomalyDetectionEnabled",
    category: "SECURITY",
    description: "Run anomaly detection over aggregated traffic and node telemetry.",
    schema: booleanish,
    defaultValue: true,
  }),
  define({
    key: "security.anomalyBandwidthSpikeFactor",
    category: "SECURITY",
    description:
      "Flag a bucket whose throughput exceeds this multiple of the same device's recent baseline.",
    schema: z.number().min(1.5).max(50),
    defaultValue: 4,
  }),
  define({
    key: "security.anomalyUploadRatio",
    category: "SECURITY",
    description:
      "Flag when upload share of a device's traffic exceeds this percentage and the volume is material.",
    schema: percentage,
    defaultValue: 85,
  }),
  define({
    key: "security.anomalyReconnectCount",
    category: "SECURITY",
    description: "Flag a device that reconnects more than this many times inside one hour.",
    schema: z.number().int().min(3).max(1000),
    defaultValue: 20,
  }),

  // ------------------------------------------------------------------ vpn ----
  define({
    key: "vpn.configExpiryDays",
    category: "VPN",
    description: "Default validity of a generated client configuration. 0 means no expiry.",
    schema: z.number().int().min(0).max(3650),
    defaultValue: 180,
  }),
  define({
    key: "vpn.requireApprovalForConfigGeneration",
    category: "VPN",
    description: "Refuse to generate a configuration for a device that is not APPROVED.",
    schema: booleanish,
    defaultValue: true,
  }),

  // ---------------------------------------------------------------- nodes ----
  define({
    key: "nodes.heartbeatStaleSeconds",
    category: "NODES",
    description:
      "A node with no heartbeat for this long is DEGRADED, and OFFLINE at twice this value.",
    schema: z.number().int().min(15).max(3600),
    defaultValue: 90,
    impact: "Node health is derived from this value, never assumed.",
  }),
  define({
    key: "nodes.autoSelectionEnabled",
    category: "NODES",
    description: "Allow the routing engine to choose a node automatically. Manual override stays available.",
    schema: booleanish,
    defaultValue: false,
  }),
  define({
    key: "nodes.autoSelectionWeights",
    category: "NODES",
    description: "Relative weights used by the routing score; the chosen weights are shown to the operator.",
    schema: z.object({
      health: z.number().min(0).max(10),
      latency: z.number().min(0).max(10),
      load: z.number().min(0).max(10),
      bandwidth: z.number().min(0).max(10),
      preference: z.number().min(0).max(10),
    }),
    defaultValue: { health: 4, latency: 3, load: 2, bandwidth: 1, preference: 1 },
  }),

  // -------------------------------------------------------------- traffic ----
  define({
    key: "traffic.assumedBlockedResponseBytes",
    category: "TRAFFIC",
    description:
      "Assumed average payload avoided when a DNS lookup is blocked. Used ONLY for the clearly labelled estimated figure; measured savings never use it.",
    schema: z.number().int().min(0).max(50_000_000),
    defaultValue: 1_500_000,
    impact: "Any number derived from this is labelled ESTIMATED in the UI.",
  }),

  // ---------------------------------------------------------------- quota ----
  define({
    key: "quota.enforcementEnabled",
    category: "QUOTA",
    description:
      "Master switch for hard-limit enforcement. When enabled, a breached quota revokes the session at the gateway, not just in the UI.",
    schema: booleanish,
    defaultValue: true,
    sensitive: true,
    impact: "Disabling this stops quota breaches from disconnecting anyone.",
  }),
  define({
    key: "quota.defaultDeviceQuotaGb",
    category: "QUOTA",
    description: "Quota applied to a newly approved device. 0 means no quota assigned.",
    schema: gigabyte,
    defaultValue: 0,
  }),
  define({
    key: "quota.warnThresholds",
    category: "QUOTA",
    description: "Usage percentages that raise a one-off warning per period.",
    schema: z.array(percentage).min(1).max(5),
    defaultValue: [80, 90],
  }),
  define({
    key: "quota.graceBytes",
    category: "QUOTA",
    description:
      "Bytes tolerated beyond the limit for packets already in flight when enforcement lands. Never a bypass budget.",
    schema: z.number().int().min(0).max(10_000_000_000),
    defaultValue: 2_000_000,
  }),
  define({
    key: "quota.autoReset",
    category: "QUOTA",
    description: "Reset periodic device quotas automatically at the start of each period.",
    schema: booleanish,
    defaultValue: true,
  }),

  // --------------------------------------------------------- optimization ----
  define({
    key: "optimization.defaultProfileKey",
    category: "OPTIMIZATION",
    description: "Profile assigned to newly approved devices.",
    schema: z.enum(["BALANCED", "DATA_SAVER", "GAMING", "VIDEO_SAVER", "MAXIMUM_SAVING"]),
    defaultValue: "BALANCED",
  }),
  define({
    key: "optimization.targetSavingMinPct",
    category: "OPTIMIZATION",
    description: "Lower bound of the documented saving TARGET range. A target, never a promise.",
    schema: percentage,
    defaultValue: 30,
  }),
  define({
    key: "optimization.targetSavingMaxPct",
    category: "OPTIMIZATION",
    description: "Upper bound of the documented saving TARGET range.",
    schema: percentage,
    defaultValue: 60,
  }),
  define({
    key: "optimization.minSampleBytesForActualSavings",
    category: "OPTIMIZATION",
    description:
      "Below this measured volume, savings are reported as insufficient data instead of a percentage.",
    schema: z.number().int().min(0).max(1_000_000_000_000),
    defaultValue: 50_000_000,
  }),

  // ------------------------------------------------------------------ dns ----
  define({
    key: "dns.filteringEnabled",
    category: "DNS",
    description:
      "Enable DNS-level blocking. Filtering only decides whether a name resolves; no TLS interception is performed.",
    schema: booleanish,
    defaultValue: false,
  }),
  define({
    key: "dns.defaultBlocklistCategories",
    category: "DNS",
    description: "Categories applied when a device has no explicit profile override.",
    schema: z.array(z.string().min(1).max(60)).max(40),
    defaultValue: [] as string[],
  }),

  // -------------------------------------------------------------- billing ----
  define({
    key: "billing.simulationEnabled",
    category: "BILLING",
    description: "Enable the SIMULATED cost display. No payment processor is involved.",
    schema: booleanish,
    defaultValue: true,
  }),
  define({
    key: "billing.projectionMinimumDays",
    category: "BILLING",
    description:
      "Minimum number of elapsed days with recorded traffic before a projection is shown. Below this, the console states that a projection is unavailable.",
    schema: z.number().int().min(1).max(60),
    defaultValue: 5,
  }),

  // ------------------------------------------------------------- receipts ----
  define({
    key: "receipts.defaultStampEnabled",
    category: "RECEIPTS",
    description:
      "Draw the SIMULATION stamp on new receipts by default. The stamp is never an official seal.",
    schema: booleanish,
    defaultValue: false,
  }),
  define({
    key: "receipts.providerLabel",
    category: "RECEIPTS",
    description:
      "Provider name printed on receipts. Using a third-party name never implies authorisation, integration or a real transaction.",
    schema: z.string().min(1).max(60),
    defaultValue: "VWRAY",
  }),
  define({
    key: "receipts.stampText",
    category: "RECEIPTS",
    description: "Text rendered inside the simulation stamp.",
    schema: z.string().min(1).max(200),
    defaultValue: "SIMULATION - NOT AN OFFICIAL PAYMENT DOCUMENT",
  }),

  // -------------------------------------------------------- notifications ----
  define({
    key: "notifications.webhookEnabled",
    category: "NOTIFICATIONS",
    description: "Deliver in-dashboard notifications to the configured webhook endpoints.",
    schema: booleanish,
    defaultValue: false,
  }),
  define({
    key: "notifications.events",
    category: "NOTIFICATIONS",
    description: "Event types that create a notification.",
    // Every key carries a default so an older stored object still parses: a key added
    // by a later version must never reset the operator's existing choices.
    schema: z.object({
      nodeOffline: booleanish.default(true),
      nodeDegraded: booleanish.default(true),
      nodeDrain: booleanish.default(true),
      quotaWarning: booleanish.default(true),
      quotaExceeded: booleanish.default(true),
      anomalyDetected: booleanish.default(true),
      authFailures: booleanish.default(true),
      deviceApproval: booleanish.default(true),
      configRevoked: booleanish.default(true),
      credentialRevoked: booleanish.default(true),
      optimizationChanged: booleanish.default(true),
      budgetThreshold: booleanish.default(true),
      policyTriggered: booleanish.default(true),
      maintenance: booleanish.default(true),
    }),
    defaultValue: {
      nodeOffline: true,
      nodeDegraded: true,
      nodeDrain: true,
      quotaWarning: true,
      quotaExceeded: true,
      anomalyDetected: true,
      authFailures: true,
      deviceApproval: true,
      configRevoked: true,
      credentialRevoked: true,
      optimizationChanged: true,
      budgetThreshold: true,
      policyTriggered: true,
      maintenance: true,
    },
  }),

  // -------------------------------------------------------------- routing ----
  define({
    key: "routing.weights",
    category: "NODES",
    description:
      "Weights used by the smart routing score. Each weight is applied only when that metric was actually measured; unavailable metrics are excluded, never treated as 0.",
    schema: z.object({
      latency: z.number().min(0).max(100).default(30),
      jitter: z.number().min(0).max(100).default(10),
      packetLoss: z.number().min(0).max(100).default(25),
      load: z.number().min(0).max(100).default(20),
      stability: z.number().min(0).max(100).default(10),
      capacity: z.number().min(0).max(100).default(5),
    }),
    defaultValue: { latency: 30, jitter: 10, packetLoss: 25, load: 20, stability: 10, capacity: 5 },
    impact: "Affects which node AUTO mode recommends for NEW sessions only.",
  }),
  define({
    key: "routing.moveActiveSessions",
    category: "NODES",
    description:
      "Allow an operator-initiated node move to disconnect active sessions. Off by default: active connections are never moved silently.",
    schema: booleanish,
    defaultValue: false,
    sensitive: true,
    impact: "When off, 'Move node' only affects the next connection.",
  }),
  // ----------------------------------------------------------- automation ----
  define({
    key: "automation.enabled",
    category: "SYSTEM",
    description: "Run scheduled maintenance jobs (quota reset, retention, health checks, policy evaluation).",
    schema: booleanish,
    defaultValue: true,
    impact: "Every run writes an audit event, whether it did work or not.",
  }),
  define({
    key: "automation.tickSeconds",
    category: "SYSTEM",
    description: "How often the scheduler looks for due jobs. Lower means fresher, at the cost of more wake-ups.",
    schema: z.number().int().min(15).max(3600),
    defaultValue: 60,
  }),
  define({
    key: "automation.policyEvaluationTargetLimit",
    category: "SYSTEM",
    description: "Maximum targets evaluated per policy per run, so a large fleet cannot stall the scheduler.",
    schema: z.number().int().min(10).max(5000),
    defaultValue: 500,
  }),

  // ------------------------------------------------------------- retention ----
  define({
    key: "retention.trafficRawDays",
    category: "RETENTION",
    description: "Days of raw traffic samples to keep. Raw samples are short-lived by design.",
    schema: z.number().int().min(1).max(3650),
    defaultValue: 2,
  }),
  define({
    key: "retention.trafficAggregateDays",
    category: "RETENTION",
    description:
      "Days of hourly and daily aggregates to keep. Long-lived, because billing and savings read them.",
    schema: z.number().int().min(7).max(3650),
    defaultValue: 400,
  }),
  define({
    key: "retention.auditLogDays",
    category: "RETENTION",
    description: "Days of audit trail to keep. Intentionally long.",
    schema: z.number().int().min(30).max(3650),
    defaultValue: 730,
  }),
  define({
    key: "retention.dnsStatDays",
    category: "RETENTION",
    description: "Days of DNS statistics to keep.",
    schema: z.number().int().min(7).max(3650),
    defaultValue: 90,
  }),
  define({
    key: "retention.nodeHealthDays",
    category: "RETENTION",
    description: "Days of node health samples to keep.",
    schema: z.number().int().min(1).max(365),
    defaultValue: 14,
  }),
  define({
    key: "retention.connectionEventDays",
    category: "RETENTION",
    description:
      "Days of connection timeline events to keep. Timeline rows are the 'why' record for device and node actions.",
    schema: z.number().int().min(7).max(3650),
    defaultValue: 180,
  }),
  define({
    key: "retention.policyExecutionDays",
    category: "RETENTION",
    description: "Days of policy execution history to keep. Short-lived because repeated cooldown rows dominate.",
    schema: z.number().int().min(7).max(3650),
    defaultValue: 90,
  }),
  define({
    key: "retention.automationRunDays",
    category: "RETENTION",
    description: "Days of automation run bookkeeping to keep. The audit trail is retained separately and much longer.",
    schema: z.number().int().min(7).max(3650),
    defaultValue: 90,
  }),

  // ---------------------------------------------------------------- system ----
  define({
    key: "system.maintenanceMode",
    category: "SYSTEM",
    description:
      "Put the console into maintenance mode. Gateway ingest keeps running so traffic data is not lost.",
    schema: booleanish,
    defaultValue: false,
    sensitive: true,
  }),
  define({
    key: "system.maintenanceMessage",
    category: "SYSTEM",
    description: "Message shown while maintenance mode is active.",
    schema: z.string().max(300),
    defaultValue: "Maintenance in progress.",
  }),
  define({
    key: "system.allowDevMockIngest",
    category: "SYSTEM",
    description:
      "Accept traffic from the development mock gateway. Refused automatically in production regardless of this value.",
    schema: booleanish,
    // Default true so a fresh local install works out of the box: the env flag and
    // the production refusal are the real gates. Set it to false the moment a real
    // gateway is attached, so MOCK rows can never appear alongside real traffic.
    defaultValue: true,
    sensitive: true,
    impact: "Mock traffic is always stored with source=MOCK and labelled DEV in the UI.",
  }),
] as const satisfies ReadonlyArray<SettingDefinition>;

export type SettingKey = (typeof SETTING_DEFINITIONS)[number]["key"];

export const SETTING_BY_KEY: Map<string, SettingDefinition> = new Map(
  SETTING_DEFINITIONS.map((definition) => [definition.key, definition as SettingDefinition]),
);

export const SETTINGS_BY_CATEGORY: Record<string, SettingDefinition[]> = SETTING_DEFINITIONS.reduce(
  (accumulator, definition) => {
    const bucket = accumulator[definition.category] ?? [];
    bucket.push(definition as SettingDefinition);
    accumulator[definition.category] = bucket;
    return accumulator;
  },
  {} as Record<string, SettingDefinition[]>,
);
