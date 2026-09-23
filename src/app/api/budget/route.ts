import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { createBudget, listBudgets } from "@/server/billing/budget";

export const GET = withConsole(async (_request, ctx) => {
  const items = await listBudgets();
  return jsonOk(items, { meta: { total: items.length }, requestId: ctx.requestId });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  amountLimit: z.union([z.string(), z.number()]),
  currency: z.string().min(1).max(8).optional(),
  scope: z.enum(["SYSTEM", "USER", "DEVICE", "NODE", "CATEGORY"]).optional(),
  scopeRefId: z.string().max(64).optional().nullable(),
  period: z.enum(["MONTHLY", "WEEKLY", "CUSTOM"]).optional(),
  periodStartDay: z.number().int().min(1).max(28).optional(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    const created = await createBudget({
      ...parsed.data,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(created, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
