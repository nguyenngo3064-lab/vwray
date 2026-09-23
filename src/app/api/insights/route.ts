import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { trafficInsights } from "@/server/analytics/insights";

export const GET = withConsole(
  async (_request, ctx) => {
    const params = ctx.url.searchParams;
    return jsonOk(
      await trafficInsights(params.get("preset") ?? "today", {
        deviceId: params.get("deviceId"),
        nodeId: params.get("nodeId"),
        userId: params.get("userId"),
        configId: params.get("configId"),
        category: params.get("category"),
        source: (params.get("source") as never) ?? undefined,
      }),
      { requestId: ctx.requestId },
    );
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
