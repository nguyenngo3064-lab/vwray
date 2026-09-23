import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { simulatePolicy, targetCounts } from "@/server/policy/simulate";

const schema = z.object({
  targetKind: z.enum(["DEVICE", "USER", "NODE", "CONFIG", "SYSTEM"]),
  condition: z.record(z.string(), z.unknown()),
  action: z.record(z.string(), z.unknown()),
  targetLimit: z.number().int().min(1).max(2000).optional(),
});

export const GET = withConsole(async (_request, ctx) => {
  return jsonOk({ targetCounts: await targetCounts() }, { requestId: ctx.requestId });
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await simulatePolicy({
        ...parsed.data,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN", rateLimit: { limit: 30, windowSeconds: 60 } },
);
