import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { readJson, sourceIpOf } from "@/server/http/guard";
import { ensureBootstrapOwner } from "@/server/auth/service";
import { ensureSettingsSeeded } from "@/server/settings/service";
import { errors } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";

/**
 * First-boot bootstrap.
 *
 * When an installation has no operator accounts, this route creates the owner and
 * returns the GENERATED ACCESS CODE exactly once. The code is printable material:
 * log it at the operator's terminal and then lose it on purpose, because the
 * database holds only the hash.
 *
 * The route is gated three ways:
 *   1. It refuses to do anything once any user exists.
 *   2. It requires `ALLOW_BOOTSTRAP_CODE_RETRIEVAL=true` (development only). In
 *      production the code is printed by the server at boot (`scripts/bootstrap.ts`)
 *      and this route stays locked.
 */
export const POST = withErrorHandling(async (request: Request) => {
  const { getEnv } = await import("@/server/config/env");
  const env = getEnv();
  const { prisma } = await import("@/server/db/client");

  const users = await prisma.adminUser.count();
  if (users > 0) {
    return jsonOk({ created: false }, { status: 409 });
  }

  if (!env.ALLOW_BOOTSTRAP_CODE_RETRIEVAL) {
    throw errors.forbidden(
      "Bootstrap code retrieval is disabled. Run the bootstrap script on the server to print the first access code.",
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
  });
});
