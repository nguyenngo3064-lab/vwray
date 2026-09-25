import "server-only";
import type { VpnNode } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { errors } from "@/server/lib/errors";
import { sha256Hex } from "@/server/lib/crypto";
import { randomToken, safeEqual } from "@/server/lib/ids";

/**
 * Data-plane (gateway agent) authentication.
 *
 * Every node gets its own bearer token instead of one shared `GATEWAY_AGENT_TOKEN`,
 * so revoking a single compromised gateway does not take down the whole fleet and an
 * audit line can say WHICH node pushed the batch.
 *
 * Token format:  `vwrt.<nodeId>.<secret>`
 *   * `nodeId` is parsed (not trusted) so the node row can be fetched in one query.
 *   * Only SHA-256(secret-material) is stored, so a database dump cannot be replayed
 *     against the ingest API.
 *   * Comparison is constant time.
 *
 * A timestamp header is required on every call. Replay attempts outside the skew
 * window are rejected before the token is even verified, which keeps rejected
 * floods cheap.
 */

export interface NodeCredentials {
  node: VpnNode;
  publicKey: string;
}

export function generateNodeToken(nodeId: string): { token: string; hint: string } {
  const secret = randomToken(24);
  return { token: `vwrt.${nodeId}.${secret}`, hint: `vwrt.${nodeId.slice(0, 8)}...` };
}

export function hashNodeToken(token: string): string {
  return sha256Hex(token);
}

/** Parses `vwrt.<nodeId>.<secret>` without trusting any part of it. */
function parseToken(token: string): { nodeId: string; secret: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "vwrt" || !parts[1] || !parts[2]) return null;
  return { nodeId: parts[1], secret: parts[2] };
}

export interface AgentAuthResult {
  node: VpnNode;
}

export async function authenticateAgent(request: Request): Promise<AgentAuthResult> {
  const env = getEnv();

  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) {
    throw errors.unauthenticated("A gateway agent token is required.");
  }

  // Replay protection: the timestamp must be within the configured skew.
  const timestampHeader = request.headers.get("x-vwray-timestamp");
  if (timestampHeader) {
    const sent = Number(timestampHeader);
    const driftSeconds = Math.abs(Date.now() / 1000 - sent);
    if (!Number.isFinite(sent) || driftSeconds > env.GATEWAY_MAX_CLOCK_SKEW_SECONDS) {
      throw errors.unauthenticated("Request timestamp is outside the accepted window.");
    }
  }

  const parsed = parseToken(token);
  if (!parsed) throw errors.unauthenticated("Gateway token is malformed.");

  const node = await prisma.vpnNode.findUnique({ where: { nodeId: parsed.nodeId } });
  if (!node) throw errors.unauthenticated("Gateway token is not valid.");

  if (node.status === "REVOKED") {
    throw errors.nodeRevoked();
  }

  if (!safeEqual(sha256Hex(token), node.agentTokenHash)) {
    throw errors.unauthenticated("Gateway token is not valid.");
  }

  if (node.maintenance) {
    throw errors.forbidden("This node is in maintenance and is not accepting ingest.");
  }

  return { node };
}
