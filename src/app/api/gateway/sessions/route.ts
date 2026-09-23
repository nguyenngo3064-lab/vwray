import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { authenticateAgent } from "@/server/gateway/auth";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";

/**
 * Session telemetry from the gateway agent (DATA PLANE -> CONTROL PLANE).
 *
 * This is where connection-quality numbers come from, and the reason `latencyMs`,
 * `jitterMs` and `packetLossPct` are nullable everywhere in the schema: a gateway that
 * cannot measure them omits the field, the column stays NULL, and the console renders
 * "Unavailable". Defaulting a missing measurement to 0 would turn "we do not know" into
 * "the best possible result" - a lie that improves a dashboard.
 *
 * Closing a session sets `endedAt` with an explicit `endReason`, so session history
 * explains why a tunnel stopped instead of just stopping.
 */

const endReasonEnum = z.enum([
  "NORMAL",
  "REVOKED",
  "QUOTA_EXCEEDED",
  "GATEWAY_DISCONNECT",
  "STALE",
  "NODE_DRAINED",
  "UNKNOWN",
]);

const sessionSchema = z.object({
  deviceId: z.string().min(1).max(64).optional(),
  credentialPublicKey: z.string().min(1).max(200).optional(),
  gatewaySessionId: z.string().min(1).max(120),
  action: z.enum(["open", "update", "close"]),
  sourceIp: z.string().max(45).optional(),
  bytesUp: z.number().int().min(0).optional(),
  bytesDown: z.number().int().min(0).optional(),
  latencyMs: z.number().min(0).max(600_000).optional(),
  jitterMs: z.number().min(0).max(600_000).optional(),
  packetLossPct: z.number().min(0).max(100).optional(),
  reconnectCount: z.number().int().min(0).max(1_000_000).optional(),
  endReason: endReasonEnum.optional(),
});

const bodySchema = z.object({
  sessions: z.array(sessionSchema).min(1).max(1_000),
  timestamp: z.number().int().optional(),
});

/** Identity by credential or explicit device id - never by source address. */
async function resolveDevice(
  deviceId?: string,
  credentialPublicKey?: string,
): Promise<{ id: string; assignedConfigId: string | null } | null> {
  if (deviceId) {
    const byId = await prisma.device.findUnique({
      where: { deviceId },
      select: { id: true, assignedConfigId: true },
    });
    if (byId) return byId;
  }
  if (credentialPublicKey) {
    const credential = await prisma.deviceCredential.findFirst({
      where: { publicKey: credentialPublicKey, revokedAt: null },
      select: { device: { select: { id: true, assignedConfigId: true } } },
    });
    if (credential) return credential.device;
  }
  return null;
}

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) throw errors.validation("A JSON request body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}

export const POST = withErrorHandling(async (request: Request) => {
  const { node } = await authenticateAgent(request);

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    throw errors.validation("The session payload is invalid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const now = new Date();
  let opened = 0;
  let updated = 0;
  let closed = 0;
  let unresolved = 0;

  for (const entry of parsed.data.sessions) {
    const device = await resolveDevice(entry.deviceId, entry.credentialPublicKey);
    if (!device) {
      // An unknown peer means the credential was revoked or never existed. Counting it
      // keeps that visible instead of silently dropping the event.
      unresolved += 1;
      continue;
    }

    const open = await prisma.vpnSession.findFirst({
      where: { nodeId: node.id, gatewaySessionId: entry.gatewaySessionId, endedAt: null },
      select: { id: true },
    });

    if (entry.action === "close") {
      await prisma.vpnSession.updateMany({
        where: { nodeId: node.id, gatewaySessionId: entry.gatewaySessionId, endedAt: null },
        data: {
          endedAt: now,
          endReason: entry.endReason ?? "GATEWAY_DISCONNECT",
          ...(entry.bytesUp !== undefined ? { bytesUp: BigInt(entry.bytesUp) } : {}),
          ...(entry.bytesDown !== undefined ? { bytesDown: BigInt(entry.bytesDown) } : {}),
        },
      });
      if (open) closed += 1;
      continue;
    }

    if (open) {
      await prisma.vpnSession.update({
        where: { id: open.id },
        data: {
          lastSeenAt: now,
          ...(entry.bytesUp !== undefined ? { bytesUp: BigInt(entry.bytesUp) } : {}),
          ...(entry.bytesDown !== undefined ? { bytesDown: BigInt(entry.bytesDown) } : {}),
          latencyMs: entry.latencyMs ?? undefined,
          jitterMs: entry.jitterMs ?? undefined,
          packetLossPct: entry.packetLossPct ?? undefined,
          reconnectCount: entry.reconnectCount ?? undefined,
        },
      });
      updated += 1;
      continue;
    }

    await prisma.vpnSession.create({
      data: {
        deviceId: device.id,
        nodeId: node.id,
        configId: device.assignedConfigId,
        gatewaySessionId: entry.gatewaySessionId,
        sourceIp: entry.sourceIp ?? null,
        startedAt: now,
        lastSeenAt: now,
        latencyMs: entry.latencyMs ?? null,
        jitterMs: entry.jitterMs ?? null,
        packetLossPct: entry.packetLossPct ?? null,
        reconnectCount: entry.reconnectCount ?? 0,
        source: node.isRealGateway ? "REAL" : "MOCK",
      },
    });
    opened += 1;
  }

  if (unresolved > 0) {
    logger.debug("session events for unknown peers ignored", { nodeId: node.nodeId, unresolved });
  }

  return jsonOk({ nodeId: node.nodeId, opened, updated, closed, unresolved, at: now.toISOString() });
});
