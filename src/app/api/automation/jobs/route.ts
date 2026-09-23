import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { createAutomationJob, listAutomationJobs } from "@/server/automation/service";
import { JOB_KINDS } from "@/server/automation/jobs";

export const GET = withConsole(async (_request, ctx) => {
  const { items, total } = await listAutomationJobs();
  return jsonOk(items, { meta: { total }, requestId: ctx.requestId });
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(JOB_KINDS as [string, ...string[]]),
  intervalSeconds: z.number().int().min(15).max(31 * 86_400).optional(),
  enabled: z.boolean().optional(),
  config: z.record(z.string(), z.unknown()).optional().nullable(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    const created = await createAutomationJob({
      name: parsed.data.name,
      kind: parsed.data.kind as never,
      intervalSeconds: parsed.data.intervalSeconds,
      enabled: parsed.data.enabled,
      config: parsed.data.config ?? null,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(created, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
