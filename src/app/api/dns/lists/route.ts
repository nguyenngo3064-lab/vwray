import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { createDnsList, listDnsLists } from "@/server/dns/service";

export const GET = withConsole(async (_request, ctx) => {
  const lists = await listDnsLists();
  return jsonOk({ items: lists }, { requestId: ctx.requestId });
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["BLOCKLIST", "ALLOWLIST"]),
  category: z.string().max(60).optional().nullable(),
  source: z.string().max(120).optional().nullable(),
  entries: z.array(z.string().max(253)).max(5_000).optional(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The DNS list payload is invalid.");
    const result = await createDnsList({
      ...parsed.data,
      category: parsed.data.category ?? null,
      source: parsed.data.source ?? null,
      entries: parsed.data.entries ?? [],
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
