import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { assignProfile, updateProfile } from "@/server/optimization/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const body = await readJson(request);
    if (typeof body !== "object" || body === null) throw errors.validation("A profile patch object is required.");
    const result = await updateProfile({
      id,
      patch: body as Record<string, unknown>,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);

const assignSchema = z.object({
  deviceIds: z.array(z.string().min(1).max(64)).min(1).max(200),
});

export async function POST(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const { id } = await routeContext.params;
  const action = new URL(request.url).searchParams.get("action");
  if (action !== "assign") {
    const { withErrorHandling } = await import("@/server/http/respond");
    return withErrorHandling(async () => {
      throw errors.validation(`Unknown action "${action}". Use assign.`);
    })(request);
  }
  return withConsole(async (inner, ctx) => {
    const parsed = assignSchema.safeParse(await readJson(inner));
    if (!parsed.success) throw errors.validation("deviceIds (1-200) is required.");
    const result = await assignProfile({
      profileId: id,
      deviceIds: parsed.data.deviceIds,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  }, { role: "ADMIN" })(request);
}
