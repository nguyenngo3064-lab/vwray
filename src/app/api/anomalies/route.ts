import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { listAnomalies } from "@/server/security/anomaly";

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const type = ctx.url.searchParams.get("type") ?? undefined;
  const status = (ctx.url.searchParams.get("status") as never) ?? undefined;
  const { items, total, open } = await listAnomalies({
    type,
    status,
    limit: pagination.pageSize,
    offset: pagination.skip,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total, open },
    requestId: ctx.requestId,
  });
});
