import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { dnsStats } from "@/server/dns/service";

export const GET = withConsole(async (_request, ctx) => {
  const params = ctx.url.searchParams;
  const result = await dnsStats({
    preset: params.get("preset") ?? "30d",
    from: params.get("from"),
    to: params.get("to"),
    deviceId: params.get("deviceId"),
  });
  return jsonOk(result, { requestId: ctx.requestId });
});
