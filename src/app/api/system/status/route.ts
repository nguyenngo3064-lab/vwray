import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getSystemStatus } from "@/server/system/status";

/**
 * System status probe for the top bar and the Overview status strip.
 *
 * Pollable and cheap: every subsystem is already a bounded read, and the database
 * probe is a single `SELECT 1`. It never returns traffic volumes, so a frequent poll
 * cannot turn into a data-plane load.
 */
export const GET = withConsole(
  async (_request, ctx) => jsonOk(await getSystemStatus(), { requestId: ctx.requestId }),
  { rateLimit: { limit: 120, windowSeconds: 60 } },
);
