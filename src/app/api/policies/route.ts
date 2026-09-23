import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, readJson, withConsole } from "@/server/http/guard";
import { createPolicy, listPolicies } from "@/server/policy/service";

const targetKind = z.enum(["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"]);

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const { items, total } = await listPolicies({
    status: (ctx.url.searchParams.get("status") as never) ?? undefined,
    targetKind: ctx.url.searchParams.get("targetKind") ?? undefined,
    search: ctx.url.searchParams.get("search") ?? undefined,
    page: pagination.page,
    pageSize: pagination.pageSize,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total },
    requestId: ctx.requestId,
  });
});

/** TEST-then-ACTIVATE is enforced by shape: a draft is created with status DISABLED or dryRun until simulated. */
const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  targetKind: targetKind.optional(),
  condition: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
  priority: z.number().int().min(0).max(10_000).optional(),
  cooldownSeconds: z.number().int().min(0).max(86_400).optional(),
  dryRun: z.boolean().optional(),
  status: z.enum(["ENABLED", "DISABLED"]).optional(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    const created = await createPolicy({
      ...parsed.data,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    });
    return jsonOk(created, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
