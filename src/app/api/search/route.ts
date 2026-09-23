import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { searchEverything } from "@/server/search/service";

export const GET = withConsole(
  async (_request, ctx) => {
    const q = ctx.url.searchParams.get("q") ?? "";
    return jsonOk(await searchEverything(q), { requestId: ctx.requestId });
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
