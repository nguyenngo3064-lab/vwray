import "server-only";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { ensureBootstrapOwner } from "@/server/auth/service";
import { ensureSettingsSeeded } from "@/server/settings/service";
import { errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * First-boot bootstrap.
 *
 * When an installation has no operator accounts, this route creates the owner and
 * returns the GENERATED ACCESS CODE exactly once when development retrieval is
 * explicitly enabled. The database holds only its hash.
 *
 * The route is gated three ways:
 *   1. It refuses to do anything once any user exists.
 *   2. It requires `ALLOW_BOOTSTRAP_CODE_RETRIEVAL=true` (development only). The
 *      production CLI bootstrap uses OWNER_PASSWORD and this route stays locked.
 */
export const POST = withErrorHandling(async () => {
  const { getEnv } = await import("@/server/config/env");
  const env = getEnv();
  const { prisma } = await import("@/server/db/client");

  const users = await prisma.adminUser.count();
  if (users > 0) {
    return jsonOk({ created: false }, { status: 409 });
  }

  if (!env.ALLOW_BOOTSTRAP_CODE_RETRIEVAL) {
    throw errors.forbidden(
      "Bootstrap code retrieval is disabled. Run the bootstrap command in a protected environment with OWNER_PASSWORD configured.",
    );
  }

  const result = await ensureBootstrapOwner();
  if (!result.created) {
    return jsonOk({ created: false }, { status: 409 });
  }

  await ensureSettingsSeeded();

  logger.warn("first-boot access code generated", {
    note: "Shown once. Store it now: it cannot be recovered, only rotated.",
  });

  return jsonOk({
    created: true,
    username: result.username,
    accessCode: result.accessCode,
    passwordSet: result.passwordSet,
  });
});
