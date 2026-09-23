import "server-only";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, withConsole } from "@/server/http/guard";
import { listPolicyExecutions } from "@/server/policy/service";

export const GET = withConsole(async (_request, ctx) => {
  const pagination = paginationFrom(ctx.url);
  const result = (ctx.url.searchParams.get("result") as never) ?? undefined;
  const { items, total } = await listPolicyExecutions({
    policyId: ctx.url.searchParams.get("policyId") ?? undefined,
    targetId: ctx.url.searchParams.get("targetId") ?? undefined,
    result,
    page: pagination.page,
    pageSize: pagination.pageSize,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total },
    requestId: ctx.requestId,
  });
});
