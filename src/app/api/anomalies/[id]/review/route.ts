import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { reviewAnomaly } from "@/server/security/anomaly";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z.object({
  status: z.enum(["REVIEWED", "DISMISSED"]),
  note: z.string().max(500).optional().nullable(),
});

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await reviewAnomaly({
        id,
        status: parsed.data.status,
        note: parsed.data.note ?? null,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
