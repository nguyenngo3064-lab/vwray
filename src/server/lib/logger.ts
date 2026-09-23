import "server-only";

/**
 * Structured logging.
 *
 * One JSON object per line so a log shipper can index it. Two hard rules:
 *   1. Secrets never reach a log line. Values under keys that look sensitive are
 *      replaced before serialisation, and this is enforced centrally rather than
 *      trusted to callers.
 *   2. Every request-scoped line carries the same `requestId`, which is also written
 *      to the audit trail so an operator can correlate the two.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACTED = "[redacted]";

/**
 * Key fragments that trigger redaction. Matched case-insensitively as substrings, so
 * `privateKey`, `wgPrivateKey` and `passwordHash` are all covered.
 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "privatekey",
  "private_key",
  "privkey",
  "psk",
  "credential",
  "sessionhash",
  "codehash",
  "sealed",
];

/** Value shapes that look like secrets even when the key does not. */
const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^v1:[A-Za-z0-9_-]+:/, // sealed payload
  /^scrypt\$/, // password/access-code hash
  /^Bearer\s+/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value))) return REDACTED;
    return value.length > 2000 ? `${value.slice(0, 2000)}[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return typeof value === "bigint" ? value.toString() : value;
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => redactValue(entry, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = isSensitiveKey(key) ? REDACTED : redactValue(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

function levelThreshold(): LogLevel {
  const configured = (process.env.LOG_LEVEL ?? "").toLowerCase();
  if (configured === "debug" || configured === "info" || configured === "warn" || configured === "error") {
    return configured;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[levelThreshold()]) return;

  const record: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? (redactValue(context) as Record<string, unknown>) : {}),
  };

  const line = JSON.stringify(record);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
  /** Returns a logger that stamps every line with the same fields. */
  with(bindings: Record<string, unknown>): Logger;
}

function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const merge = (context?: Record<string, unknown>) => ({ ...bindings, ...(context ?? {}) });
  return {
    debug: (message, context) => emit("debug", message, merge(context)),
    info: (message, context) => emit("info", message, merge(context)),
    warn: (message, context) => emit("warn", message, merge(context)),
    error: (message, context) => emit("error", message, merge(context)),
    with: (extra) => createLogger(merge(extra)),
  };
}

export const logger = createLogger();

/** Exposed for tests: proves redaction happens before serialisation. */
export const __testing = { redactValue, isSensitiveKey };
