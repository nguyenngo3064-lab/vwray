import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { policyRegistry } from "@/server/policy/service";

export const GET = withConsole(async (_request, ctx) => {
  return jsonOk(policyRegistry(), { requestId: ctx.requestId });
});
