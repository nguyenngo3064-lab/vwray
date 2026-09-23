import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { getAutomationJob, updateAutomationJob } from "@/server/automation/service";

type RouteParams = { params: Promise<{ id: string }> };

const schema = z.object({
  name: z.string().min(1).max(120).optional(),
  intervalSeconds: z.number().int().min(15).max(31 * 86_400).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  return jsonOk(await getAutomationJob(id), { requestId: ctx.requestId });
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await updateAutomationJob({
        id,
        ...parsed.data,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
