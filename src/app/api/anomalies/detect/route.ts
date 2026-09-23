import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { runAnomalyDetection } from "@/server/security/detector";

export const POST = withConsole(
  async (request, ctx) => {
    await readJson(request).catch(() => ({}));
    return jsonOk(await runAnomalyDetection(), { requestId: ctx.requestId });
  },
  { role: "ADMIN", rateLimit: { limit: 5, windowSeconds: 60 } },
);
