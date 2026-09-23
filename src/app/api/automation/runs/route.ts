import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { listAutomationRuns } from "@/server/automation/service";

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const status = ctx.url.searchParams.get("status") as never;
  const { items, total } = await listAutomationRuns({
    jobId: ctx.url.searchParams.get("jobId") ?? undefined,
    status: status ?? undefined,
    page: pagination.page,
    pageSize: pagination.pageSize,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total },
    requestId: ctx.requestId,
  });
});
