import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { trafficHeatmap } from "@/server/analytics/heatmap";

export const GET = withConsole(
  async (_request, ctx) => {
    const params = ctx.url.searchParams;
    return jsonOk(
      await trafficHeatmap({
        preset: params.get("preset"),
        from: params.get("from"),
        to: params.get("to"),
        dim: params.get("dim"),
        deviceId: params.get("deviceId"),
        nodeId: params.get("nodeId"),
        userId: params.get("userId"),
        source: (params.get("source") as never) ?? undefined,
      }),
      { requestId: ctx.requestId },
    );
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
