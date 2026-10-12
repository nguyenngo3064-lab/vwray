import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { readJson, sourceIpOf, withConsole } from "@/server/http/guard";
import { changeOwnPassword, getSession } from "@/server/auth/service";
import { errors } from "@/server/lib/errors";

/**
 * Password management for the signed-in operator.
 *
 * Requires a valid session AND the double-submit CSRF header (both enforced by
 * `withConsole`), plus proof of the current credential inside the body. The new
 * password never leaves the server: it is hashed with scrypt and every session of
 * the user — including this one — is revoked, so the operator signs in again.
 */
const changeSchema = z.object({
  currentPassword: z.string().min(1).max(200).optional(),
  currentAccessCode: z.string().min(4).max(64).optional(),
  newPassword: z.string().min(12).max(200),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = changeSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.validation("A new password of at least 12 characters is required.");
    }

    await changeOwnPassword({
      userId: ctx.session.user.id,
      currentPassword: parsed.data.currentPassword ?? null,
      currentAccessCode: parsed.data.currentAccessCode ?? null,
      newPassword: parsed.data.newPassword,
      ip: ctx.sourceIp,
    });

    return jsonOk({ changed: true, sessionsRevoked: true }, { requestId: ctx.requestId });
  },
  { role: "VIEWER", rateLimit: { limit: 10, windowSeconds: 300 } },
);

/** Who is signed in right now. Used by the console shell for the account menu. */
export const GET = withErrorHandling(async () => {
  const session = await getSession();
  if (!session) throw errors.unauthenticated();
  return jsonOk({
    user: session.user,
    expiresAt: session.expiresAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
  });
});