import "server-only";
import QRCode from "qrcode";
import type { ReceiptView } from "@/server/receipts/service";

/**
 * Verification QR codes.
 *
 * The code encodes the SAME `verifyUrl` the receipt prints as text, so a reader and a
 * scanner always agree. It is generated per request rather than cached: the payload is
 * a URL, the cost is negligible, and a cached image would survive a regeneration and
 * point at a superseded document.
 *
 * Nothing else is ever encoded here - no token, no secret, no private key - because a
 * QR code ends up in screenshots and printouts where it cannot be revoked.
 */

export async function renderReceiptQr(receipt: ReceiptView): Promise<Buffer> {
  return QRCode.toBuffer(receipt.verifyUrl, {
    type: "png",
    errorCorrectionLevel: "M",
    width: 420,
    margin: 2,
    color: {
      dark: "#111113",
      light: "#FFFFFF",
    },
  });
}
