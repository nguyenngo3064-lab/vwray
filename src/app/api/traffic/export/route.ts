import "server-only";
import { toCsv, attachmentHeaders } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { queryTraffic } from "@/server/analytics/traffic";
import { parseTrafficFilters } from "@/server/analytics/filters";

/**
 * Traffic CSV export.
 *
 * Byte counts are exported raw (never pre-formatted) so a spreadsheet recalculates
 * honestly instead of re-interpreting a formatted string, and the same filter parser
 * as the JSON route is used so the file always matches the view it was exported from.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const result = await queryTraffic(parseTrafficFilters(ctx.url));

    const rows = result.series.map((point) => ({
      t: new Date(point.t).toISOString(),
      upload_bytes: point.uploadBytes,
      download_bytes: point.downloadBytes,
      total_bytes: point.totalBytes,
      optimized_bytes: point.optimizedBytes ?? "",
    }));

    const csv = toCsv(rows, [
      "t",
      "upload_bytes",
      "download_bytes",
      "total_bytes",
      "optimized_bytes",
    ]);

    return new Response(csv, { headers: attachmentHeaders("traffic-export.csv", "text/csv") });
  },
  { rateLimit: { limit: 30, windowSeconds: 60 } },
);
