import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { readJson, sourceIpOf } from "@/server/http/guard";
import { getSession, loginWithAccessCode, loginWithPassword, logout } from "@/server/auth/service";
import { errors } from "@/server/lib/errors";

const loginSchema = z.object({
  accessCode: z.string().min(4).max(64).optional(),
  username: z.string().min(1).max(80).optional(),
  password: z.string().min(1).max(200).optional(),
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

/**
 * Login. Accepts either credential:
 *   * `{ username, password }`  — the primary way into the dashboard, or
 *   * `{ accessCode }`          — the installation access code issued at bootstrap.
 * Both paths run through the same rate-limit ledger, generic failure message and
 * audit trail; the response never says which half of a credential was wrong.
 */
export const POST = withErrorHandling(async (request: Request) => {
  const parsed = loginSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    throw errors.validation("A username with password, or an access code, is required.");
  }

  const { username, password, accessCode } = parsed.data;
  if (!password && !accessCode) {
    throw errors.validation("A username with password, or an access code, is required.");
  }

  const { prisma } = await import("@/server/db/client");
  if ((await prisma.adminUser.count()) === 0) {
    throw errors.conflict("This installation is not bootstrapped. Run the bootstrap command on the server first.");
  }

  const ip = sourceIpOf(request);
  const userAgent = request.headers.get("user-agent");

  const session = password
    ? await loginWithPassword({ username: username ?? "", password, ip, userAgent })
    : await loginWithAccessCode({ accessCode: accessCode as string, ip, userAgent });

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
