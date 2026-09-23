import "server-only";
import { attachmentHeaders } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { exportDataset } from "@/server/export/service";

/**
 * Export centre download. The body is the file itself, served as an attachment with a
 * sanitised filename (`attachmentHeaders` in respond.ts), and the export is audited.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const params = ctx.url.searchParams;
    const result = await exportDataset({
      dataset: params.get("dataset") ?? "",
      format: params.get("format") ?? "csv",
      preset: params.get("preset"),
      from: params.get("from"),
      to: params.get("to"),
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    });
    return new Response(result.body, { headers: attachmentHeaders(result.filename, result.contentType) });
  },
  { rateLimit: { limit: 20, windowSeconds: 60 } },
);
