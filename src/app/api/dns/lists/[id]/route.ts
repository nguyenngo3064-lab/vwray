import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { deleteDnsList, updateDnsList } from "@/server/dns/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  enabled: z.boolean().optional(),
  entries: z
    .object({
      add: z.array(z.string().max(253)).max(5_000).optional(),
      remove: z.array(z.string().max(253)).max(5_000).optional(),
    })
    .optional(),
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The DNS list patch is invalid.");
    const result = await updateDnsList({
      id,
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      add: parsed.data.entries?.add,
      remove: parsed.data.entries?.remove,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);

export const DELETE = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const result = await deleteDnsList({
      id,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
