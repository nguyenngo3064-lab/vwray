import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { authenticateAgent } from "@/server/gateway/auth";
import { applyHeartbeat } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";

/**
 * Node heartbeat (DATA PLANE -> CONTROL PLANE).
 *
 * A node is only ever ONLINE because a heartbeat arrived inside the staleness window -
 * health is derived from this timestamp and never asserted. The response echoes the
 * current derived health, the staleness window and the policy revision the agent last
 * acknowledged, so an agent can decide it needs to re-pull policy without an extra
 * round trip.
 */

const bodySchema = z.object({
  cpuPercent: z.number().min(0).max(100).optional(),
  ramPercent: z.number().min(0).max(100).optional(),
  bandwidthMbps: z.number().min(0).max(1_000_000).optional(),
  activeSessions: z.number().int().min(0).max(1_000_000).optional(),
  latencyMs: z.number().min(0).max(600_000).optional(),
  jitterMs: z.number().min(0).max(600_000).optional(),
  packetLossPct: z.number().min(0).max(100).optional(),
  version: z.string().max(40).optional(),
  agentVersion: z.string().max(40).optional(),
  /** Highest policy revision the agent has applied; lets the control plane detect drift. */
  appliedRevision: z.number().int().min(0).optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const { node } = await authenticateAgent(request);

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    throw errors.validation("The heartbeat payload is invalid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const [staleSeconds, heartbeat] = await Promise.all([
    getSetting<number>("nodes.heartbeatStaleSeconds"),
    applyHeartbeat(node.id, parsed.data),
  ]);

  const pendingRevision = await latestPolicyRevision(node.id);

  return jsonOk({
    nodeId: node.nodeId,
    receivedAt: new Date().toISOString(),
    health: heartbeat?.health ?? "UNKNOWN",
    staleSeconds,
    /** Agent must re-pull when this is greater than its appliedRevision. */
    policyRevision: pendingRevision,
    ...(typeof parsed.data.appliedRevision === "number"
      ? { drift: pendingRevision > parsed.data.appliedRevision }
      : {}),
  });
});

/** Highest revision across this node's pending policy rows (0 when nothing changed). */
async function latestPolicyRevision(nodeId: string): Promise<number> {
  const { prisma } = await import("@/server/db/client");
  const latest = await prisma.gatewayPolicyState.findFirst({
    where: { OR: [{ nodeId }, { nodeId: null, device: { assignedNodeId: nodeId } }] },
    orderBy: { revision: "desc" },
    select: { revision: true },
  });
  return latest?.revision ?? 0;
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}
