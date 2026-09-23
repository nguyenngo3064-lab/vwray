import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { upsertDnsRule } from "@/server/dns/service";

const ruleSchema = z.object({
  action: z.enum(["ALLOW", "BLOCK"]),
  domain: z.string().min(1).max(253),
  scope: z.string().max(80).optional().nullable(),
  note: z.string().max(300).optional().nullable(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = ruleSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The DNS rule payload is invalid.");
    const result = await upsertDnsRule({
      ...parsed.data,
      scope: parsed.data.scope ?? null,
      note: parsed.data.note ?? null,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
