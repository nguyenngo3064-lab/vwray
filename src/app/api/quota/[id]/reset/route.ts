import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { resetQuota } from "@/server/quota/engine";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const POST = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    await resetQuota({
      quotaId: id,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(
      { id, state: "ACTIVE", note: "Usage cleared and gateway quota policies cleared in the same transaction." },
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
