import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { queryConsumers } from "@/server/analytics/consumers";
import { parseConsumerFilters } from "@/server/analytics/filters";

/**
 * Top data consumers.
 *
 * The response always carries `appAttributionAvailable: false` and a `note` explaining
 * why application names are absent; the console renders both verbatim so nobody reads
 * an empty Application column as a gap to be filled in with guesses.
 */
export const GET = withConsole(
  async (_request, ctx) =>
    jsonOk(await queryConsumers(parseConsumerFilters(ctx.url)), { requestId: ctx.requestId }),
  { rateLimit: { limit: 120, windowSeconds: 60 } },
);
