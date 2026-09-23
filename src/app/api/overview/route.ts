import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getOverview } from "@/server/analytics/overview";

/**
 * Overview payload: the one request the landing page makes.
 *
 * Built server-side so every section on screen describes the same instant (see
 * src/server/analytics/overview.ts). Read-only, rate-limited loosely enough for a
 * console that refreshes on a timer.
 */
export const GET = withConsole(
  async (_request, ctx) => jsonOk(await getOverview(), { requestId: ctx.requestId }),
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
