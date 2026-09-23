import "server-only";
import type { AdminRole } from "@prisma/client";
import { assertCsrf, requireSession, roleAtLeast, type SessionContext } from "@/server/auth/service";
import { recordDenied, userActor, type AuditActor } from "@/server/audit";
import { AppError, errors } from "@/server/lib/errors";
import { checkHotBucket } from "@/server/auth/rate-limit";
import { generateRequestId } from "@/server/lib/ids";
import { withErrorHandling } from "@/server/http/respond";

/**
 * Route guard.
 *
 * Every console API route is wrapped exactly once, and the wrapper is the only place
 * that answers the four questions each request must answer:
 *   1. Is there a valid session?            (authentication)
 *   2. Did the request come from our UI?    (CSRF, for mutating methods)
 *   3. Is the role allowed to do this?      (authorisation)
 *   4. Is this caller within their budget?  (rate limiting)
 *
 * Putting them in one place means a new route cannot accidentally ship without one of
 * them, and a denial is always audited with the same shape.
 */

export interface ConsoleContext {
  session: SessionContext;
  actor: AuditActor;
  sourceIp: string | null;
  requestId: string;
  url: URL;
}

export interface ConsoleOptions {
  /** Minimum role. Defaults to VIEWER (any signed-in operator). */
  role?: AdminRole;
  /**
   * Requests per window for this route, per session. Defaults are permissive because
   * the console legitimately polls; the value exists to bound abuse, not to be a
   * quota. Auth routes use the database-backed limiter instead (see rate-limit.ts).
   */
  rateLimit?: { limit: number; windowSeconds: number };
}

/**
 * Resolves the caller IP.
 *
 * `x-forwarded-for` is only trusted for its first entry and only for display and
 * rate-limiting, never for authentication or authorisation. A deployment behind a
 * proxy must terminate TLS there; a spoofed header can therefore at worst influence
 * an audit record, never access.
 */
export function sourceIpOf(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return request.headers.get("x-real-ip")?.slice(0, 64) ?? null;
}

/** Masks the host part of an IP for display, honouring the privacy setting. */
export function maskIp(ip: string | null | undefined, mask: boolean): string {
  if (!ip) return "unknown";
  if (!mask) return ip;
  if (ip.includes(":")) {
    const parts = ip.split(":");
    return `${parts.slice(0, 3).join(":")}:xxxx`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4) return ip;
  return `${octets[0]}.${octets[1]}.${octets[2]}.xxx`;
}

export function withConsole<Args extends unknown[]>(
  handler: (request: Request, ctx: ConsoleContext, ...args: Args) => Promise<Response>,
  options: ConsoleOptions = {},
) {
  const guarded = withErrorHandling(async (request: Request, ...args: Args): Promise<Response> => {
    const session = await requireSession();
    const requestId = request.headers.get("x-request-id") ?? generateRequestId();
    const sourceIp = sourceIpOf(request);

    if (options.rateLimit) {
      const bucket = checkHotBucket(
        `route:${new URL(request.url).pathname}:${session.sessionId}`,
        options.rateLimit.limit,
        options.rateLimit.windowSeconds,
      );
      if (!bucket.allowed) {
        throw errors.rateLimited("Too many requests. Try again shortly.", bucket.retryAfterSeconds);
      }
    }

    if (options.role && !roleAtLeast(session.user.role, options.role)) {
      await recordDenied(userActor(session.user.id, session.user.username), "auth.login_failed", "route", {
        sourceIp,
        requestId,
        metadata: {
          reason: "insufficient_role",
          required: options.role,
          actual: session.user.role,
          path: new URL(request.url).pathname,
        },
      });
      throw errors.forbidden(`This action requires the ${options.role} role or higher.`);
    }

    await assertCsrf(request, session);

    return handler(
      request,
      {
        session,
        actor: userActor(session.user.id, session.user.username),
        sourceIp,
        requestId,
        url: new URL(request.url),
      },
      ...args,
    );
  });

  return guarded;
}

/** Parses and validates a JSON body. Empty bodies are rejected, not treated as `{}`. */
export async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) {
    throw errors.validation("A JSON request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

/** Normalises pagination so a client cannot request an unbounded result set. */
export function paginationFrom(url: URL, defaults?: { pageSize?: number; maxPageSize?: number }): Pagination {
  const maxPageSize = defaults?.maxPageSize ?? 100;
  const defaultPageSize = defaults?.pageSize ?? 25;

  const rawPage = Number(url.searchParams.get("page") ?? "1");
  const rawSize = Number(url.searchParams.get("pageSize") ?? String(defaultPageSize));

  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0 ? Math.min(Math.floor(rawSize), maxPageSize) : defaultPageSize;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** Turns an AppError into an HTTP response through the shared envelope. */
export { AppError };
