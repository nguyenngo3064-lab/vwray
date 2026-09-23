import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { setPolicyOverride } from "@/server/policy/engine";
import { getPolicy } from "@/server/policy/service";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z
  .object({
    clear: z.boolean().optional(),
    until: z.string().datetime().optional().nullable(),
    reason: z.string().min(1).max(400).optional().nullable(),
  })
  .strict();

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    const until = parsed.data.clear ? null : parsed.data.until ? new Date(parsed.data.until) : null;
    await setPolicyOverride({
      policyId: id,
      until,
      reason: parsed.data.reason ?? null,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(await getPolicy(id), { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
