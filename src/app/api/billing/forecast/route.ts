import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { costForecast } from "@/server/forecast/cost";

export const GET = withConsole(
  async (_request, ctx) => jsonOk(await costForecast(), { requestId: ctx.requestId }),
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
