import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { heatmapCell } from "@/server/analytics/heatmap";

const schema = z.object({ row: z.string().max(64), col: z.string().max(64) });

export const GET = withConsole(async (_request, ctx) => {
  const params = ctx.url.searchParams;
  const parsed = schema.safeParse({ row: params.get("row"), col: params.get("col") });
  if (!parsed.success) throw parsed.error;
  return jsonOk(
    await heatmapCell({
      preset: params.get("preset"),
      from: params.get("from"),
      to: params.get("to"),
      dim: params.get("dim"),
      ...parsed.data,
    }),
    { requestId: ctx.requestId },
  );
});
