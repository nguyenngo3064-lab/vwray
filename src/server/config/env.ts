import "server-only";
import { z } from "zod";

/**
 * Runtime environment contract.
 *
 * Validation is deliberately LAZY (`getEnv()`), not module-scope, because Next.js
 * evaluates route modules during the build. A missing variable must fail loudly at
 * request time in the operator's logs, not silently render an empty dashboard and
 * certainly not break a production build with a stack trace from deep inside a
 * static analysis pass.
 *
 * Secrets are read here and nowhere else. Nothing in this module is ever serialised
 * to the client: `publicEnv()` exposes only values that are safe to ship.
 */

const boolString = z
  .string()
  .optional()
  .transform((value) => value === "true" || value === "1");

const intString = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? fallback : Number(value)))
    .pipe(z.number().int().min(min).max(max));

const numberString = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === "" ? fallback : Number(value)))
    .pipe(z.number().finite());

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value && value.length > 0 ? value : undefined));

const secret = (name: string, minLength: number) =>
  z
    .string({ error: `${name} is required. See .env.example.` })
    .min(minLength, `${name} must be at least ${minLength} characters.`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.string().default("http://localhost:3000"),
  WEBSOCKET_URL: optionalString,

  DATABASE_URL: secret("DATABASE_URL", 12),
  TEST_DATABASE_URL: optionalString,
  DATABASE_POOL_MAX: intString(10, 1, 200),

  AUTH_SECRET: secret("AUTH_SECRET", 32),
  ENCRYPTION_KEY: secret("ENCRYPTION_KEY", 24),
  SESSION_ABSOLUTE_TTL_MINUTES: intString(720, 5, 60 * 24 * 90),
  SESSION_IDLE_TTL_MINUTES: intString(120, 1, 60 * 24 * 30),
  AUTH_MAX_ATTEMPTS_PER_WINDOW: intString(8, 1, 1000),
  AUTH_ATTEMPT_WINDOW_MINUTES: intString(15, 1, 24 * 60),
  AUTH_LOCKOUT_MINUTES: intString(15, 1, 24 * 60),
  ALLOW_BOOTSTRAP_CODE_RETRIEVAL: boolString,

  VPN_API_URL: optionalString,
  VPN_API_KEY: optionalString,
  GATEWAY_AGENT_TOKEN: optionalString,
  GATEWAY_MAX_CLOCK_SKEW_SECONDS: intString(300, 5, 86_400),
  DEV_MOCK_GATEWAY_ENABLED: boolString,
  DEV_MOCK_GATEWAY_BPS: numberString(0),

  DNS_PROVIDER: z.string().default("none"),
  DNS_PROVIDER_URL: optionalString,
  DNS_PROVIDER_API_KEY: optionalString,

  BILLING_CURRENCY: z.string().default("VND"),
  PRICE_PER_GB: numberString(0),
  BASE_FEE: numberString(0),
  FREE_QUOTA_GB: numberString(0),
  BILLING_PERIOD: z.enum(["MONTHLY", "WEEKLY", "CUSTOM"]).default("MONTHLY"),
  BILLING_PERIOD_START_DAY: intString(1, 1, 28),

  REALTIME_WINDOWS: z.string().default("30,60,300,900"),
  REALTIME_BUFFER_SECONDS: intString(1800, 60, 86_400),
  TRAFFIC_FLUSH_INTERVAL_SECONDS: intString(10, 2, 600),

  TRAFFIC_RAW_RETENTION_DAYS: intString(2, 1, 3650),
  TRAFFIC_AGGREGATE_RETENTION_DAYS: intString(400, 7, 3650),
  AUDIT_LOG_RETENTION_DAYS: intString(730, 30, 3650),
  DNS_STAT_RETENTION_DAYS: intString(90, 7, 3650),

  REDIS_URL: optionalString,

  WG_INTERFACE: z.string().default("wg0"),
  WG_CONFIG_PATH: optionalString,
  XRAY_API_URL: optionalString,
  XRAY_CONFIG_PATH: optionalString,

  ALERT_WEBHOOK_URL: optionalString,
  ALERT_WEBHOOK_SECRET: optionalString,
});

export type AppEnv = z.infer<typeof envSchema> & {
  isProduction: boolean;
  isDevelopment: boolean;
  isTest: boolean;
  /** Sliding windows for the realtime chart, ascending, seconds. */
  realtimeWindows: number[];
};

let cached: AppEnv | null = null;
let cachedError: Error | null = null;

function build(): AppEnv {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;
  const windows = value.REALTIME_WINDOWS.split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part) && part > 0)
    .sort((a, b) => a - b);

  return {
    ...value,
    isProduction: value.NODE_ENV === "production",
    isDevelopment: value.NODE_ENV === "development",
    isTest: value.NODE_ENV === "test",
    realtimeWindows: windows.length > 0 ? windows : [30, 60, 300, 900],
  };
}

/**
 * Reads and caches the validated environment. Throws a readable, secret-free error
 * listing exactly which variables are missing.
 */
export function getEnv(): AppEnv {
  if (cached) return cached;
  try {
    cached = build();
    cachedError = null;
    return cached;
  } catch (error) {
    cachedError = error instanceof Error ? error : new Error(String(error));
    throw cachedError;
  }
}

export function getEnvError(): Error | null {
  if (!cached && !cachedError) {
    try {
      getEnv();
    } catch {
      // cachedError is set by getEnv.
    }
  }
  return cachedError;
}

/** Test helper: clears the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
  cachedError = null;
}

/**
 * Values that are safe to expose to the browser. Contains no secrets, no keys and
 * no connection strings.
 */
export function publicEnv() {
  const env = getEnv();
  return {
    appUrl: env.APP_URL,
    realtimeUrl: env.WEBSOCKET_URL ?? null,
    realtimeWindows: env.realtimeWindows,
    currency: env.BILLING_CURRENCY,
    devMockGatewayEnabled: env.isDevelopment && env.DEV_MOCK_GATEWAY_ENABLED,
    mode: env.NODE_ENV,
    /** True when this deployment can honestly claim a real gateway is configured. */
    hasConfiguredGateway: Boolean(env.VPN_API_URL),
  };
}
