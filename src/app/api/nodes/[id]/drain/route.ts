import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { abortNodeDrain, pollNodeDrain, startNodeDrain } from "@/server/nodes/health";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z.object({
  reason: z.string().min(1).max(200),
  previous: z.number().int().min(0).optional(),
});

/** GET: poll the drain (remaining sessions, safe-to-restart verdict). */
export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const previousRaw = ctx.url.searchParams.get("previous");
  return jsonOk(await pollNodeDrain(id, previousRaw === null ? undefined : Number(previousRaw)), {
    requestId: ctx.requestId,
  });
});

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await startNodeDrain({
        nodeId: id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { status: 202, requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);

export const DELETE = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await abortNodeDrain({
        nodeId: id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
