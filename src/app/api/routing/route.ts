import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { getRoutingState, requireRoutingAdmin, setRoutingWeights } from "@/server/routing/score";

export const GET = withConsole(
  async (_request, ctx) => jsonOk(await getRoutingState(), { requestId: ctx.requestId }),
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);

const schema = z.object({
  weights: z.object({
    latency: z.number().min(0).max(100).optional(),
    jitter: z.number().min(0).max(100).optional(),
    packetLoss: z.number().min(0).max(100).optional(),
    load: z.number().min(0).max(100).optional(),
    stability: z.number().min(0).max(100).optional(),
    capacity: z.number().min(0).max(100).optional(),
  }),
});

export const PATCH = withConsole(
  async (request, ctx) => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    await requireRoutingAdmin({ role: ctx.session.user.role });
    const weights = await setRoutingWeights({
      weights: parsed.data.weights,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk({ weights }, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
