import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { evaluatePolicies } from "@/server/policy/engine";

export const POST = withConsole(
  async (request, ctx) => {
    await readJson(request).catch(() => ({}));
    return jsonOk(await evaluatePolicies(), { requestId: ctx.requestId });
  },
  { role: "ADMIN", rateLimit: { limit: 5, windowSeconds: 60 } },
);
