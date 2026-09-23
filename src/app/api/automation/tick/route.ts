import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { schedulerTick } from "@/server/automation/service";

/**
 * Runs one scheduler tick. The production scheduler is driven by the runtime loop
 * (see src/server/automation/scheduler.ts); this route exists so an operator can see
 * exactly what a tick would do, on demand.
 */
export const POST = withConsole(
  async (request, ctx) => {
    await readJson(request).catch(() => ({}));
    return jsonOk(await schedulerTick(), { requestId: ctx.requestId });
  },
  { role: "ADMIN", rateLimit: { limit: 10, windowSeconds: 60 } },
);
