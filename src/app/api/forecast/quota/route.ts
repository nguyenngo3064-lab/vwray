import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { forecastQuota } from "@/server/forecast/quota";

export const GET = withConsole(async (_request, ctx) => {
  const params = ctx.url.searchParams;
  return jsonOk(
    await forecastQuota({
      quotaId: params.get("quotaId"),
      deviceId: params.get("deviceId"),
      scope: params.get("scope"),
      scopeRefId: params.get("scopeRefId"),
    }),
    { requestId: ctx.requestId },
  );
});
