import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { simulateStoredPolicy } from "@/server/policy/simulate";
import { assertPolicyExists } from "@/server/policy/engine";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z.object({ targetLimit: z.number().int().min(1).max(2000).optional() });

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse((await readJson(request).catch(() => ({}))) as unknown);
    const policy = await assertPolicyExists(id);
    return jsonOk(
      await simulateStoredPolicy(policy, {
        targetLimit: parsed.success ? parsed.data.targetLimit : undefined,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN", rateLimit: { limit: 30, windowSeconds: 60 } },
);
