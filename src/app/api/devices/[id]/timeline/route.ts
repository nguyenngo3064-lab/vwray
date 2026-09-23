import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { listTimeline, timelineTypeFacets } from "@/server/timeline/service";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const pagination = paginationFrom(ctx.url);
  const types = ctx.url.searchParams.get("type");
  const { items, total } = await listTimeline({
    deviceId: id,
    types: types ? ([types] as never) : null,
    search: ctx.url.searchParams.get("q"),
    page: pagination.page,
    pageSize: pagination.pageSize,
  });
  const facets = await timelineTypeFacets();
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total, facets },
    requestId: ctx.requestId,
  });
});
