import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { deletePolicy, getPolicy, updatePolicy } from "@/server/policy/service";

type RouteParams = { params: Promise<{ id: string }> };

const targetKind = z.enum(["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"]);

const updateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).optional().nullable(),
  targetKind: targetKind.optional(),
  condition: z.record(z.string(), z.unknown()).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  dryRun: z.boolean().optional(),
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
});

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  return jsonOk(await getPolicy(id), { requestId: ctx.requestId });
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = updateSchema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await updatePolicy(id, {
        ...parsed.data,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
        requestId: ctx.requestId,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);

export const DELETE = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    await deletePolicy({
      id,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk({ deleted: true }, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
