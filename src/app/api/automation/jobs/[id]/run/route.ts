import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { runAutomationJob } from "@/server/automation/service";

type RouteParams = { params: Promise<{ id: string }> };

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    await readJson(request).catch(() => ({}));
    return jsonOk(
      await runAutomationJob({
        jobId: id,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        source: "console",
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN", rateLimit: { limit: 10, windowSeconds: 60 } },
);
