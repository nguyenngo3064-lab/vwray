import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { dnsOverview } from "@/server/dns/service";

export const GET = withConsole(async (_request, ctx) => {
  const result = await dnsOverview();
  return jsonOk([result], { meta: { total: 1 }, requestId: ctx.requestId });
});
