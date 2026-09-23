import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { evaluateBudgets, listBudgetEvents } from "@/server/billing/budget";

export const GET = withConsole(async (_request, ctx) => {
  const budgetId = ctx.url.searchParams.get("budgetId") ?? undefined;
  const evaluation = ctx.url.searchParams.get("evaluate") === "true" ? await evaluateBudgets() : null;
  const events = await listBudgetEvents(budgetId);
  return jsonOk({ events, evaluation }, { requestId: ctx.requestId });
});
