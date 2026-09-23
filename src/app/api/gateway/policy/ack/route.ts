import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { authenticateAgent } from "@/server/gateway/auth";
import { logger } from "@/server/lib/logger";

/**
 * Policy acknowledgement (DATA PLANE -> CONTROL PLANE).
 *
 * Distinguishing "decided" from "applied" is what makes enforcement observable: a row
 * with `state: QUOTA_EXCEEDED` and no `ackedAt` means the control plane has ruled but
 * the gateway has not yet enforced, and the console shows exactly that instead of
 * claiming the device is blocked when it might not be.
 */

const bodySchema = z.object({
  /** Entries the agent has actually programmed into its gateway. */
  applied: z
    .array(
      z.object({
        deviceId: z.string().min(1).max(64),
        revision: z.number().int().min(0),
        ok: z.boolean(),
        error: z.string().max(300).optional(),
      }),
    )
    .min(1)
    .max(1_000),
  agentVersion: z.string().max(40).optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const { node } = await authenticateAgent(request);

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    throw errors.validation("The policy acknowledgement is invalid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const { prisma } = await import("@/server/db/client");
  const now = new Date();
  let acked = 0;
  const failures: Array<{ deviceId: string; error: string }> = [];

  for (const entry of parsed.data.applied) {
    const policy = await prisma.gatewayPolicyState.findFirst({
      where: { deviceId: entry.deviceId, OR: [{ nodeId: node.id }, { nodeId: null }] },
      orderBy: { revision: "desc" },
    });
    if (!policy) continue;

    if (entry.ok) {
      await prisma.gatewayPolicyState.update({
        where: { id: policy.id },
        data: { appliedAt: now, ackedAt: now },
      });
      acked += 1;
    } else {
      failures.push({
        deviceId: entry.deviceId,
        error: entry.error ?? "gateway rejected the policy",
      });
    }
  }

  if (failures.length > 0) {
    // Loud but non-fatal: the acknowledgement tells us enforcement is incomplete, which
    // an operator must see, but it must not abort the batch that did succeed.
    logger.error("gateway could not apply policy", {
      nodeId: node.nodeId,
      failures,
    });
  }

  return jsonOk({
    nodeId: node.nodeId,
    receivedAt: now.toISOString(),
    acked,
    failed: failures.length,
    failures,
  });
});

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) throw errors.validation("A JSON request body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}
