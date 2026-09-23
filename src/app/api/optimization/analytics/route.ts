import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { optimizationAnalytics, type GroupBy } from "@/server/optimization/analytics";

const GROUPS: GroupBy[] = ["device", "user", "node", "category", "profile"];

export const GET = withConsole(async (_request, ctx) => {
  const params = ctx.url.searchParams;
  const groupBy = (params.get("groupBy") ?? "device") as GroupBy;
  if (!GROUPS.includes(groupBy)) throw errors.validation("groupBy must be device, user, node, category or profile.");
  const sourceParam = params.get("source");
  const source = sourceParam === "MOCK" || sourceParam === "ALL" ? sourceParam : "REAL";
  const result = await optimizationAnalytics({
    preset: params.get("preset") ?? "30d",
    from: params.get("from"),
    to: params.get("to"),
    groupBy,
    source,
  });
  return jsonOk(result, { requestId: ctx.requestId });
});
