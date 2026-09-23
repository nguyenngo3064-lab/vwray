import "server-only";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { checkHotBucket } from "@/server/auth/rate-limit";
import { verifyReceipt } from "@/server/receipts/service";

/**
 * PUBLIC receipt verification.
 *
 * The one console-adjacent route with no session requirement: a reader who received a
 * receipt (or scanned its QR) must be able to check the hash without an account. It
 * therefore never goes through `withConsole`/`requireSession` - doing so would make
 * every answer a 401. The honesty guarantees still hold:
 *   * an unknown number answers 404 through the same envelope, so the page can render
 *     a real "not found" instead of implying the document exists,
 *   * a fixed hot bucket (60/min) bounds enumeration of receipt numbers.
 */
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ receiptNumber: string }>;
}

export const GET = withErrorHandling(async (_request: Request, extra: RouteParams) => {
  const { receiptNumber } = await extra.params;

  const bucket = checkHotBucket("receipt:verify", 60, 60);
  if (!bucket.allowed) {
    throw errors.rateLimited(
      "Too many verification attempts. Try again in a moment.",
      bucket.retryAfterSeconds,
    );
  }

  // verifyReceipt throws errors.notFound for an unknown number; withErrorHandling
  // turns that into the standard 404 envelope below.
  const result = await verifyReceipt(receiptNumber);
  return jsonOk(result);
});
