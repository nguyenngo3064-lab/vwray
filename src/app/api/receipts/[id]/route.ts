import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { getReceipt, verifyReceipt, voidReceipt } from "@/server/receipts/service";

/** Single receipt: read, void, or regenerate (re-issue links for the SAME row). */

interface RouteParams {
  params: Promise<{ id: string }>;
}

const voidSchema = z.object({
  reason: z.string().min(1).max(300),
});

export const GET = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const receipt = await getReceipt(id);
    // The canonical payload deliberately stays server-side; the list/detail responses
    // carry only the hash an operator can compare against the public verifier.
    return jsonOk(
      {
        receipt,
        calculation: receipt.calculation,
        integrity: { algorithm: "SHA-256" as const, hash: receipt.verificationHash },
      },
      { requestId: ctx.requestId },
    );
  },
  { role: "VIEWER" },
);

export const POST = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const action = ctx.url.searchParams.get("action");

    if (action === "void") {
      const parsed = voidSchema.safeParse(await readJson(request));
      if (!parsed.success) {
        throw errors.validation("A reason for voiding the receipt is required.");
      }
      const receipt = await voidReceipt({
        id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk({ receipt }, { requestId: ctx.requestId });
    }

    if (action === "regenerate") {
      const receipt = await getReceipt(id);
      if (receipt.status === "VOID") {
        throw errors.conflict("A void receipt cannot be regenerated. Issue a new one instead.");
      }

      // Regeneration must re-serve the document that was ALREADY shown: same stored
      // row values, verified against the stored hash - never recomputed from traffic,
      // which would silently change a document an auditor may already hold.
      const verification = await verifyReceipt(receipt.receiptNumber);
      if (!verification.valid) {
        throw errors.conflict(
          "This receipt failed its integrity check, so its documents will not be re-issued.",
        );
      }

      await record({
        actor: { type: "USER", id: ctx.session.user.id, label: ctx.session.user.username },
        action: "receipt.regenerated",
        resource: "receipt",
        resourceId: receipt.id,
        result: "SUCCESS",
        sourceIp: ctx.sourceIp,
        requestId: ctx.requestId,
        metadata: { receiptNumber: receipt.receiptNumber, verificationHash: receipt.verificationHash },
      });

      return jsonOk(
        {
          receipt,
          pdfUrl: `/api/receipts/${receipt.id}/pdf`,
          qrUrl: `/api/receipts/${receipt.id}/qr`,
          integrity: { algorithm: "SHA-256" as const, hash: receipt.verificationHash },
        },
        { requestId: ctx.requestId },
      );
    }

    throw errors.validation(`Unknown action "${action}". Use "void" or "regenerate".`);
  },
  { role: "ADMIN" },
);
