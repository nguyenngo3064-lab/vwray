import "server-only";
import { z } from "zod";
import { errors } from "@/server/lib/errors";

/**
 * Policy validation.
 *
 * A stored policy is untrusted input: the database stores JSON, so every read path
 * re-validates before the engine will act on it. Two closed vocabularies make the system
 * safe by construction:
 *
 *   * a condition may only reference a NAMED METRIC that the engine knows how to
 *     measure (no expressions, no field paths, no code);
 *   * an action may only be a KEY from the registry with a typed parameter object
 *     (no code, no shell, no SQL, no arbitrary URL).
 *
 * That is what stops this from becoming an arbitrary-code-execution surface while still
 * being generic enough to express IF quota >= 90 THEN warn, IF packet loss > x THEN
 * lower routing priority, and so on.
 */

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

export const conditionSchema = z
  .object({
    metric: z.enum(POLICY_METRICS),
    operator: z.enum(["GTE", "GT", "LTE", "LT", "EQ", "NEQ"]),
    value: z.number().finite(),
    /** Lookback window for rate/counter metrics, in seconds. */
    windowSeconds: z.number().int().min(60).max(30 * 24 * 3600).default(3600),
    /** Baseline window for TRAFFIC_SPIKE_FACTOR. Defaults to 24x the main window. */
    baselineWindowSeconds: z.number().int().min(60).max(30 * 24 * 3600).optional(),
    /** Devices must have this much data in the window before a rate metric counts. */
    minSamples: z.number().int().min(1).max(10_000).default(1),
  })
  .strict();

export type PolicyCondition = z.infer<typeof conditionSchema>;

const actionParamsByAction = {
  NOTIFY: z.object({
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "WARNING", "CRITICAL"]).default("MEDIUM"),
    message: z.string().min(1).max(400).optional(),
  }).strict(),
  QUOTA_WARNING: z.object({
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "WARNING", "CRITICAL"]).default("WARNING"),
    message: z.string().min(1).max(400).optional(),
  }).strict(),
  DISCONNECT_SESSION: z.object({
    reason: z.string().min(1).max(200).default("Disconnected by policy"),
    allowReconnect: z.boolean().default(true),
  }).strict(),
  BLOCK_DEVICE_RECONNECT: z.object({
    reason: z.string().min(1).max(200).default("Blocked by policy"),
  }).strict(),
  MARK_NODE_DEGRADED: z.object({
    reason: z.string().min(1).max(200).default("Policy threshold exceeded"),
  }).strict(),
  LOWER_NODE_ROUTING_PRIORITY: z.object({
    /** Amount subtracted from the node's routing weight, floor 0. */
    weightDelta: z.number().int().min(1).max(100).default(20),
    reason: z.string().min(1).max(200).default("Routing priority lowered by policy"),
  }).strict(),
  STOP_NEW_ASSIGNMENTS: z.object({
    reason: z.string().min(1).max(200).default("New session assignments stopped"),
  }).strict(),
  CREATE_ANOMALY_EVENT: z.object({
    anomalyType: z.enum([
      "BANDWIDTH_SPIKE",
      "BANDWIDTH_DROP",
      "UPLOAD_ANOMALY",
      "EXCESSIVE_CONNECTIONS",
      "AUTH_FAILURES",
      "RAPID_QUOTA_CONSUMPTION",
      "NODE_BEHAVIOUR",
      "RECONNECT_LOOP",
    ]),
    severity: z.enum(["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    label: z.string().min(1).max(160).default("Policy threshold exceeded"),
  }).strict(),
  APPLY_OPTIMIZATION_PROFILE: z.object({
    profileKey: z.enum(["BALANCED", "DATA_SAVER", "GAMING", "VIDEO_SAVER", "MAXIMUM_SAVING"]),
  }).strict(),
  DRAIN_NODE: z.object({
    reason: z.string().min(1).max(200).default("Drained by policy"),
    /** Must be stated explicitly: draining waits for sessions, it never kicks them. */
    disconnectExisting: z.boolean().default(false),
  }).strict(),
  SET_DEVICE_SECURITY_REVIEW: z.object({
    reason: z.string().min(1).max(200).default("Flagged for operator review"),
  }).strict(),
  REQUEST_REPORT: z.object({
    reportType: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]).default("DAILY"),
  }).strict(),
} as const;

export type PolicyActionKeyLiteral = (typeof POLICY_ACTIONS)[number];

export const actionSchema = z
  .object({
    key: z.enum(POLICY_ACTIONS),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const spec = actionParamsByAction[value.key as PolicyActionKeyLiteral];
    if (!spec) {
      ctx.addIssue({ code: "custom", message: `Unknown action "${value.key}".` });
      return;
    }
    const parsed = spec.safeParse(value.params ?? {});
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", path: ["params", ...issue.path], message: issue.message });
      }
    }
  });

export type PolicyAction = z.infer<typeof actionSchema>;
export type PolicyActionParams<K extends PolicyActionKeyLiteral> = z.infer<
  (typeof actionParamsByAction)[K]
>;

/** Parses and validates, turning a Zod failure into the API's standard 422 envelope. */
export function parseCondition(input: unknown): PolicyCondition {
  const parsed = conditionSchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation("The policy condition is invalid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

export function parseAction(input: unknown): PolicyAction & { params: Record<string, unknown> } {
  const parsed = actionSchema.safeParse(input);
  if (!parsed.success) {
    throw errors.validation("The policy action is invalid.", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      allowedActions: POLICY_ACTIONS,
    });
  }
  const params = parsed.data as PolicyAction & { params?: Record<string, unknown> };
  return { key: params.key, params: (params.params ?? {}) as Record<string, unknown> };
}

export function parseActionParams<K extends PolicyActionKeyLiteral>(
  key: K,
  input: unknown,
): PolicyActionParams<K> {
  const spec = actionParamsByAction[key] as unknown as z.ZodType<PolicyActionParams<K>>;
  const parsed = spec.safeParse(input ?? {});
  if (!parsed.success) {
    throw errors.validation(`Invalid parameters for action ${key}.`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return parsed.data;
}

/** Which targets a given metric can actually be measured against. */
export const METRIC_TARGETS: Record<(typeof POLICY_METRICS)[number], ReadonlyArray<(typeof POLICY_TARGET_KINDS)[number]>> = {
  QUOTA_PERCENT: ["DEVICE", "USER", "CONFIG", "NODE", "SYSTEM"],
  QUOTA_USED_BYTES: ["DEVICE", "USER", "CONFIG", "NODE", "SYSTEM"],
  DEVICE_UPLOAD_BYTES_PER_HOUR: ["DEVICE"],
  DEVICE_DOWNLOAD_BYTES_PER_HOUR: ["DEVICE"],
  TRAFFIC_SPIKE_FACTOR: ["DEVICE", "NODE"],
  DEVICE_CONNECTIONS: ["DEVICE"],
  DEVICE_RECONNECTS: ["DEVICE"],
  AUTH_FAILURES: ["SYSTEM"],
  NODE_CPU_PERCENT: ["NODE"],
  NODE_RAM_PERCENT: ["NODE"],
  NODE_PACKET_LOSS_PCT: ["NODE"],
  NODE_LATENCY_MS: ["NODE"],
  NODE_ACTIVE_SESSIONS: ["NODE"],
  NODE_SESSION_HEADROOM_PERCENT: ["NODE"],
  NODE_ONLINE: ["NODE"],
  BUDGET_PERCENT: ["SYSTEM", "USER", "DEVICE", "NODE"],
  DEVICE_QUOTA_EXCEEDED: ["DEVICE"],
  DEVICE_BLOCKED: ["DEVICE"],
};
