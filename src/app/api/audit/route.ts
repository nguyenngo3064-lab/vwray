import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { queryAuditLogs } from "@/server/audit/query";

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const params = ctx.url.searchParams;
  const { items, total, facets } = await queryAuditLogs({
    page: pagination.page,
    pageSize: pagination.pageSize,
    action: params.get("action"),
    resource: params.get("resource"),
    actorType: params.get("actorType"),
    result: params.get("result"),
    search: params.get("q"),
    from: params.get("from"),
    to: params.get("to"),
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total, facets },
    requestId: ctx.requestId,
  });
});
