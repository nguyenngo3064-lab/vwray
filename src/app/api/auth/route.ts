import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { withConsole, withErrorHandling, readJson, sourceIpOf } from "@/server/http/guard";
import {
  ensureBootstrapOwner,
  getSession,
  loginWithAccessCode,
  logout,
  rotateSession,
} from "@/server/auth/service";
import { revokeSessionById } from "@/server/auth/sessions";
import { logger } from "@/server/lib/logger";

const loginSchema = z.object({
  accessCode: z.string().min(4).max(64),
});

const sessionIdSchema = z.object({
  sessionId: z.string().min(1).max(64),
});

/**
 * Returns whether this installation needs bootstrapping. The login page calls this
 * first, because a fresh install has no code to ask for yet.
 */
export const GET = withErrorHandling(async () => {
  const { prisma } = await import("@/server/db/client");
  const users = await prisma.adminUser.count();
  const session = await getSession();
  return jsonOk({ needsBootstrap: users === 0, authenticated: Boolean(session) });
});

/** Access-code login. */
export const POST = withErrorHandling(async (request: Request) => {
  const parsed = loginSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return jsonOk({ ok: false }, { status: 422 });
  }

  const session = await loginWithAccessCode({
    accessCode: parsed.data.accessCode,
    ip: sourceIpOf(request),
    userAgent: request.headers.get("user-agent"),
  });

  return jsonOk({
    user: session.user,
    expiresAt: session.expiresAt.toISOString(),
    csrfToken: session.csrfToken,
  });
});

/** Logout: revokes the session server-side and clears the cookies. */
export const DELETE = withErrorHandling(async () => {
  await logout();
  return jsonOk({ ok: true });
});

export { rotateSession, revokeSessionById };
