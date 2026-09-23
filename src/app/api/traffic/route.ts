import "server-only";
import { jsonOk, toCsv, attachmentHeaders } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { queryTraffic } from "@/server/analytics/traffic";
import { parseTrafficFilters } from "@/server/analytics/filters";

/**
 * Traffic history (JSON).
 *
 * Every filter is validated as one object before the query runs, so a malformed range
 * surfaces as a single readable validation error rather than a half-applied filter -
 * which is how a chart ends up drawing a different period than its label claims.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const result = await queryTraffic(parseTrafficFilters(ctx.url));
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { rateLimit: { limit: 120, windowSeconds: 60 } },
);
