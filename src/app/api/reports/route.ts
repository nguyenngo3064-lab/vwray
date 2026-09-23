import "server-only";
import { z } from "zod";
import { attachmentHeaders, jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { generateReport, reportAsCsv } from "@/server/reports/service";

const schema = z.object({
  type: z.enum(["DAILY", "WEEKLY", "MONTHLY", "CUSTOM"]).default("DAILY"),
  format: z.enum(["JSON", "CSV", "PDF"]).default("JSON"),
  from: z.string().optional().nullable(),
  to: z.string().optional().nullable(),
});

/**
 * JSON (payload inline), CSV (file download). PDF is generated through the existing PDF
 * pipeline's shared receipt-layout helpers only when requested - today CSV/JSON are the
 * supported machine formats, and the endpoint says NO rather than returning a tuned UI.
 */
export const GET = withConsole(async (_request, ctx) => {
  const params = ctx.url.searchParams;
  const parsed = schema.safeParse({
    type: (params.get("type") ?? "DAILY").toUpperCase(),
    format: (params.get("format") ?? "JSON").toUpperCase(),
    from: params.get("from"),
    to: params.get("to"),
  });
  if (!parsed.success) throw parsed.error;

  if (parsed.data.format === "PDF") {
    const { errors } = await import("@/server/lib/errors");
    throw errors.unsupported("PDF reports are not available; use JSON or CSV.");
  }

  if (parsed.data.format === "CSV") {
    const { filename, body } = await reportAsCsv({
      type: parsed.data.type,
      from: parsed.data.from,
      to: parsed.data.to,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
    });
    return new Response(body, {
      headers: {
        ...attachmentHeaders(filename, "text/csv; charset=utf-8"),
        "x-request-id": ctx.requestId,
      },
    });
  }

  return jsonOk(
    await generateReport({
      type: parsed.data.type,
      format: "JSON",
      from: parsed.data.from,
      to: parsed.data.to,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
      requestId: ctx.requestId,
    }),
    { requestId: ctx.requestId },
  );
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    if (parsed.data.format === "PDF") {
      const { errors } = await import("@/server/lib/errors");
      throw errors.unsupported("PDF reports are not available; use JSON or CSV.");
    }
    return jsonOk(
      await generateReport({
        ...parsed.data,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
        requestId: ctx.requestId,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ANALYST", rateLimit: { limit: 20, windowSeconds: 60 } },
);
