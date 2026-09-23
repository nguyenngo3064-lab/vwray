import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { listTimeline } from "@/server/timeline/service";

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const params = ctx.url.searchParams;
  const type = params.get("type");
  const { items, total } = await listTimeline({
    deviceId: params.get("deviceId"),
    nodeId: params.get("nodeId"),
    userId: params.get("userId"),
    types: type ? ([type] as never) : null,
    actor: (params.get("actor") as never) ?? null,
    severity: (params.get("severity") as never) ?? null,
    from: params.get("from") ? new Date(params.get("from") as string) : null,
    to: params.get("to") ? new Date(params.get("to") as string) : null,
    search: params.get("q"),
    page: pagination.page,
    pageSize: pagination.pageSize,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total },
    requestId: ctx.requestId,
  });
});
