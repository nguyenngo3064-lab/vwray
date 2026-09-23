import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { listProfiles } from "@/server/optimization/service";

export const GET = withConsole(async (_request, ctx) => {
  const result = await listProfiles();
  return jsonOk([result], { meta: { total: 1 }, requestId: ctx.requestId });
});
