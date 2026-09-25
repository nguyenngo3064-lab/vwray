import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { readJson, sourceIpOf } from "@/server/http/guard";
import { getSession, loginWithAccessCode, logout } from "@/server/auth/service";
import { errors } from "@/server/lib/errors";

const loginSchema = z.object({
  accessCode: z.string().min(4).max(64),
});

/**
 * Returns whether this installation needs bootstrapping. The login page calls this
 * first, because a fresh install has no code to ask for yet.
 */
export const GET = withErrorHandling(async () => {
  const { prisma } = await import("@/server/db/client");
  const [users, session] = await Promise.all([prisma.adminUser.count(), getSession()]);
  return jsonOk({
    /** The login page shows the setup screen instead of a code prompt while true. */
    needsBootstrap: users === 0,
    authenticated: Boolean(session),
    user: session
      ? {
          username: session.user.username,
          displayName: session.user.displayName,
          role: session.user.role,
        }
      : null,
    expiresAt: session?.expiresAt.toISOString() ?? null,
  });
});

/** Access-code login. */
export const POST = withErrorHandling(async (request: Request) => {
  const parsed = loginSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    const { errors } = await import("@/server/lib/errors");
    throw errors.validation("An access code is required.");
  }

  const { prisma } = await import("@/server/db/client");
  if ((await prisma.adminUser.count()) === 0) {
    throw errors.conflict("This installation is not bootstrapped. Run the bootstrap command on the server first.");
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
