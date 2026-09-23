import "server-only";
import { attachmentHeaders } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getReceipt } from "@/server/receipts/service";
import { renderReceiptPdf } from "@/server/receipts/pdf";

/**
 * Receipt PDF.
 *
 * Read-only: no audit row is written on GET (the create/void/regenerate actions are
 * what the trail cares about), and the response is `no-store` because a regenerated
 * document must never be served from an intermediary cache.
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const receipt = await getReceipt(id);
    const bytes = await renderReceiptPdf(receipt);

    return new Response(bytes.buffer as ArrayBuffer, {
      headers: {
        ...attachmentHeaders(`receipt-${receipt.receiptNumber}.pdf`, "application/pdf"),
        "x-request-id": ctx.requestId,
      },
    });
  },
  { role: "VIEWER" },
);
