import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { deleteBudget, updateBudget } from "@/server/billing/budget";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  amountLimit: z.union([z.string(), z.number()]).optional(),
  enabled: z.boolean().optional(),
  periodStartDay: z.number().int().min(1).max(28).optional(),
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await updateBudget({
        id,
        ...parsed.data,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);

export const DELETE = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    await deleteBudget({
      id,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk({ deleted: true }, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
