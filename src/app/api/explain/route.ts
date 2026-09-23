import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { explain } from "@/server/timeline/explain";

export const GET = withConsole(async (_request, ctx) => {
  const subject = ctx.url.searchParams.get("subject") ?? "";
  const id = ctx.url.searchParams.get("id") ?? "";
  if (!subject || !id) {
    const { errors } = await import("@/server/lib/errors");
    throw errors.validation("subject and id are required.");
  }
  return jsonOk(await explain({ subject, id }), { requestId: ctx.requestId });
});
