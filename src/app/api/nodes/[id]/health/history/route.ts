import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getNodeHealthHistory } from "@/server/nodes/health";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const preset = ctx.url.searchParams.get("preset") ?? "1d";
  return jsonOk(await getNodeHealthHistory(id, preset), { requestId: ctx.requestId });
});
