import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { compareOptimizationProfiles } from "@/server/optimization/benchmark";

export const GET = withConsole(
  async (_request, ctx) => {
    const a = ctx.url.searchParams.get("a") ?? "DATA_SAVER";
    const b = ctx.url.searchParams.get("b") ?? "BALANCED";
    return jsonOk(await compareOptimizationProfiles({
      a,
      b,
      deviceId: ctx.url.searchParams.get("deviceId"),
      preset: ctx.url.searchParams.get("preset") ?? "7d",
    }), { requestId: ctx.requestId });
  },
  { rateLimit: { limit: 30, windowSeconds: 60 } },
);
