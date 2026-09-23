import "server-only";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { errors } from "@/server/lib/errors";

/**
 * Rate limiting and brute-force protection.
 *
 * The ledger of attempts is kept in the database (`AuthAttempt`) rather than in
 * memory, because the protection has to survive a restart: an attacker who can
 * trigger a crash otherwise gets a free retry budget. A small in-process cache is
 * kept on top purely to avoid a database round trip for obviously-blocked traffic.
 */

interface BucketRecord {
  count: number;
  expiresAt: number;
}

const hotCache = new Map<string, BucketRecord>();

/** Removes expired entries so the cache cannot grow without bound. */
function sweep(now: number): void {
  for (const [key, bucket] of hotCache) {
    if (bucket.expiresAt <= now) hotCache.delete(key);
  }
}

export interface RateLimitOptions {
  /** Logical bucket, e.g. `auth.login`. */
  scope: string;
  /** Attempt budget inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Identity being protected, e.g. the username or request fingerprint. */
  identifier: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/** In-memory check used for high-frequency endpoints (gateway ingest, SSE). */
export function checkHotBucket(key: string, limit: number, windowSeconds: number): RateLimitResult {
  const now = Date.now();
  sweep(now);
  const bucket = hotCache.get(key);
  if (!bucket) {
    hotCache.set(key, { count: 1, expiresAt: now + windowSeconds * 1000 });
    return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  if (bucket.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
    };
  }
  bucket.count += 1;
  return { allowed: true, remaining: Math.max(0, limit - bucket.count), retryAfterSeconds: 0 };
}

/**
 * Durable check backed by the attempt ledger. Counts FAILED attempts only, so a
 * legitimate operator is never locked out by their own successful logins.
 */
export async function checkAuthRateLimit(scope: string, identifier: string): Promise<RateLimitResult> {
  const env = getEnv();
  const windowMs = env.AUTH_ATTEMPT_WINDOW_MINUTES * 60 * 1000;
  const since = new Date(Date.now() - windowMs);

  const failures = await prisma.authAttempt.count({
    where: { kind: scope, identifier, success: false, createdAt: { gte: since } },
  });

  const limit = env.AUTH_MAX_ATTEMPTS_PER_WINDOW;
  if (failures >= limit) {
    const oldest = await prisma.authAttempt.findFirst({
      where: { kind: scope, identifier, success: false, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const retryAfterSeconds = oldest
      ? Math.max(
          1,
          Math.ceil((oldest.createdAt.getTime() + windowMs - Date.now()) / 1000),
        )
      : env.AUTH_LOCKOUT_MINUTES * 60;
    return { allowed: false, remaining: 0, retryAfterSeconds };
  }

  return { allowed: true, remaining: Math.max(0, limit - failures), retryAfterSeconds: 0 };
}

export async function recordAuthAttempt(input: {
  kind: string;
  identifier: string;
  ip?: string | null;
  success: boolean;
  reason?: string | null;
}): Promise<void> {
  await prisma.authAttempt.create({
    data: {
      kind: input.kind,
      identifier: input.identifier,
      ip: input.ip ?? null,
      success: input.success,
      reason: input.reason ?? null,
    },
  });
}

/** Sliding-window limiter for non-auth endpoints, backed by the same ledger. */
export async function enforceRateLimit(
  scope: string,
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const hot = checkHotBucket(`${scope}:${identifier}`, limit, windowSeconds);
  if (!hot.allowed) {
    throw errors.rateLimited("Too many requests. Try again later.", hot.retryAfterSeconds);
  }
}
