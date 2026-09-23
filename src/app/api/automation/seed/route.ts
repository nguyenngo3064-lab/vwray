import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { ensureDefaultAutomationJobs } from "@/server/automation/service";

export const POST = withConsole(
  async (request, ctx) => {
    await readJson(request).catch(() => ({}));
    const created = await ensureDefaultAutomationJobs(ctx.session.user.id, ctx.session.user.username);
    return jsonOk({ created }, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
