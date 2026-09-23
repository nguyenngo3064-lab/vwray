import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { createReceipt, listReceipts } from "@/server/receipts/service";

/**
 * Receipts collection.
 *
 * Reads are VIEWER (the list is a record of simulated documents, not a credential);
 * creation is ADMIN because an issued receipt is a permanent, hashed row that an
 * auditor will compare against stored traffic.
 */

const listQuerySchema = z.object({
  customerRef: z.string().max(120).optional(),
  status: z.enum(["DRAFT", "ISSUED", "VOID"]).optional(),
  preset: z.string().max(20).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  search: z.string().max(120).optional(),
});

export const GET = withConsole(
  async (_request, ctx) => {
    const parsed = listQuerySchema.safeParse(Object.fromEntries(ctx.url.searchParams));
    if (!parsed.success) {
      throw errors.validation("One or more receipt filters are invalid.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { page, pageSize, skip } = paginationFrom(ctx.url);
    const { items, total } = await listReceipts({
      page,
      pageSize,
      customerRef: parsed.data.customerRef ?? null,
      status: parsed.data.status ?? null,
      preset: parsed.data.preset ?? null,
      from: parsed.data.from ?? null,
      to: parsed.data.to ?? null,
      search: parsed.data.search ?? null,
    });

    return jsonOk(items, {
      meta: { page, pageSize, total, hasMore: skip + items.length < total },
      requestId: ctx.requestId,
    });
  },
  { role: "VIEWER", rateLimit: { limit: 120, windowSeconds: 60 } },
);

const isoDate = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "Must be an ISO timestamp.",
});

const createSchema = z.object({
  customerName: z.string().min(1).max(160),
  customerRef: z.string().max(120).nullable().optional(),
  deviceId: z.string().max(64).nullable().optional(),
  nodeId: z.string().max(64).nullable().optional(),
  configLabel: z.string().max(120).nullable().optional(),
  periodStart: isoDate,
  periodEnd: isoDate,
  stampEnabled: z.boolean().optional(),
  providerLabel: z.string().max(60).nullable().optional(),
  pricePerGb: z.number().min(0).nullable().optional(),
  baseFee: z.number().min(0).nullable().optional(),
  freeQuotaGb: z.number().min(0).nullable().optional(),
  createCostRecord: z.boolean().optional(),
});

/**
 * Issues a receipt from STORED traffic and STORED pricing. The service validates the
 * period itself (inverted or future periods throw) and those errors are surfaced
 * verbatim: a receipt that quietly clamped its own period would be a forged document.
 */
export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw errors.validation("The receipt payload is invalid.", {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }

    const { receipt, costRecordId } = await createReceipt({
      customerName: parsed.data.customerName,
      customerRef: parsed.data.customerRef ?? null,
      deviceId: parsed.data.deviceId ?? null,
      nodeId: parsed.data.nodeId ?? null,
      configLabel: parsed.data.configLabel ?? null,
      periodStart: new Date(parsed.data.periodStart),
      periodEnd: new Date(parsed.data.periodEnd),
      stampEnabled: parsed.data.stampEnabled,
      providerLabel: parsed.data.providerLabel ?? null,
      pricePerGb: parsed.data.pricePerGb ?? null,
      baseFee: parsed.data.baseFee ?? null,
      freeQuotaGb: parsed.data.freeQuotaGb ?? null,
      createCostRecord: parsed.data.createCostRecord,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });

    return jsonOk(
      {
        receipt,
        verifyUrl: receipt.verifyUrl,
        calculation: receipt.calculation,
        disclaimer: receipt.disclaimer,
        costRecordId,
      },
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
