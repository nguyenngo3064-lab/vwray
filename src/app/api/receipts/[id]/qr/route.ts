import "server-only";
import { withConsole } from "@/server/http/guard";
import { getReceipt } from "@/server/receipts/service";
import { renderReceiptQr } from "@/server/receipts/qr";

/**
 * Receipt verification QR (PNG).
 *
 * Encodes the same `verifyUrl` the PDF prints, generated per request and served
 * `no-store` so a cached code can never outlive a regeneration.
 */

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const receipt = await getReceipt(id);
    const png = await renderReceiptQr(receipt);

    return new Response(new Uint8Array(png), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
        "x-request-id": ctx.requestId,
      },
    });
  },
  { role: "VIEWER" },
);
