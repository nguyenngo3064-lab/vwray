import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getBillingOverview, updateBillingConfig } from "@/server/billing/service";
import { readJson } from "@/server/http/guard";

export const GET = withConsole(
  async (_request, ctx) => jsonOk(await getBillingOverview(), { requestId: ctx.requestId }),
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);

/** Simulation pricing is operator-editable. No payment processor is attached anywhere. */
export const PATCH = withConsole(
  async (request, ctx) => {
    const body = (await readJson(request)) as Record<string, unknown>;
    const updated = await updateBillingConfig({
      ...(body as Parameters<typeof updateBillingConfig>[0]),
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(updated, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
