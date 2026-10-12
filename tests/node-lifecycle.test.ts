import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma } from "@/server/db/client";
import {
  applyHeartbeat,
  approveNode,
  createNode,
  deriveHealth,
  listNodes,
  registerNodeAgent,
  rejectNode,
  revokeNode,
  rotateNodeToken,
  sweepStaleNodes,
  updateNode,
} from "@/server/nodes/service";
import { authenticateAgent, generateNodeToken, hashNodeToken } from "@/server/gateway/auth";
import { sha256Hex } from "@/server/lib/crypto";
import { resetDatabase, seedFixture } from "./helpers/db";

/**
 * Node lifecycle: register -> approve -> heartbeat -> degrade -> sweep,
 * token rotation, rejection, revocation.
 */

function agentRequest(token: string): Request {
  return new Request("http://localhost/api/gateway/heartbeat", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "x-vwray-timestamp": String(Math.floor(Date.now() / 1000)),
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
}

async function enroll(nodeId = "node_lifecycle01") {
  return registerNodeAgent({
    nodeId,
    name: "Lifecycle node",
    location: "lab",
    publicEndpoint: "203.0.113.20",
    port: 51820,
    protocol: "WIREGUARD",
    isRealGateway: true,
  });
}

beforeEach(async () => {
  await resetDatabase();
});

describe("registration", () => {
  it("creates a node in REGISTERING + PENDING with a hashed token", async () => {
    const enrolled = await enroll();
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(row.status).toBe("REGISTERING");
    expect(row.approvalState).toBe("PENDING");
    expect(row.agentTokenHash).toBe(sha256Hex(enrolled.agentToken));
    expect(row.agentTokenHash).not.toContain(enrolled.agentToken);
  });

  it("is idempotent for the same nodeId", async () => {
    const first = await enroll();
    const second = await enroll();
    expect(second.id).toBe(first.id);
    expect(second.agentToken).not.toBe(first.agentToken);
    expect(await prisma.vpnNode.count({ where: { nodeId: first.nodeId } })).toBe(1);
  });

  it("refuses to re-register a revoked node", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    await revokeNode({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    await expect(enroll()).rejects.toMatchObject({ code: "NODE_REVOKED" });
  });
});

describe("approval", () => {
  it("approves a node and records the operator", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    const approved = await approveNode({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    expect(approved.approvalState).toBe("APPROVED");
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(row.approvedById).toBe(actor.userId);
    expect(row.approvedAt).not.toBeNull();
  });

  it("rejects with a reason and blocks agent authentication", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    await rejectNode({ nodeId: enrolled.id, reason: "untrusted network", actorId: actor.userId, actorLabel: "owner" });
    await expect(authenticateAgent(agentRequest(enrolled.agentToken))).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("agent authentication", () => {
  it("authenticates a valid per-node token", async () => {
    const enrolled = await enroll();
    const { node } = await authenticateAgent(agentRequest(enrolled.agentToken));
    expect(node.nodeId).toBe(enrolled.nodeId);
  });

  it("rejects unknown, malformed and cross-node tokens", async () => {
    await enroll();
    await expect(
      authenticateAgent(agentRequest("vwrt.node_lifecycle01.wrong-secret-material")),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(authenticateAgent(agentRequest("not-a-token"))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const other = generateNodeToken("node_other99");
    await expect(authenticateAgent(agentRequest(other.token))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("rejects replayed timestamps outside the skew window", async () => {
    const enrolled = await enroll();
    const stale = new Request("http://localhost/api/gateway/heartbeat", {
      method: "POST",
      headers: {
        authorization: `Bearer ${enrolled.agentToken}`,
        "x-vwray-timestamp": String(Math.floor(Date.now() / 1000) - 3600),
      },
    });
    await expect(authenticateAgent(stale)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("rejects a revoked node token immediately", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    await revokeNode({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    await expect(authenticateAgent(agentRequest(enrolled.agentToken))).rejects.toMatchObject({
      code: "NODE_REVOKED",
    });
  });

  it("stores only the token hash (a dump cannot be replayed)", async () => {
    const token = generateNodeToken("node_hashcheck");
    expect(hashNodeToken(token.token)).not.toContain(token.token.split(".")[2] ?? "impossible-marker");
  });
});

describe("heartbeat and derived health", () => {
  it("keeps a PENDING node in REGISTERING and an approved node becomes ONLINE", async () => {
    const enrolled = await enroll();
    await applyHeartbeat(enrolled.id, {});
    const pending = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(pending.status).toBe("REGISTERING");
    expect(pending.lastHeartbeatAt).not.toBeNull();

    const actor = await seedFixture();
    await approveNode({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    await applyHeartbeat(enrolled.id, {});
    const approved = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(approved.status).toBe("ONLINE");
  });

  it("stores the agent-reported WireGuard state with its timestamp", async () => {
    const enrolled = await enroll();
    await applyHeartbeat(enrolled.id, { wireguard: { state: "READY", reason: "carrier detected" } });
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(row.wireguardState).toBe("READY");
    expect(row.wireguardStateAt).not.toBeNull();
  });

  it("derives ONLINE / DEGRADED / OFFLINE / UNKNOWN from heartbeat age", () => {
    const now = Date.now();
    const fresh = { lastHeartbeatAt: new Date(now), staleSeconds: 90, maintenance: false, draining: false };
    const late = { lastHeartbeatAt: new Date(now - 120_000), staleSeconds: 90, maintenance: false, draining: false };
    const gone = { lastHeartbeatAt: new Date(now - 400_000), staleSeconds: 90, maintenance: false, draining: false };
    expect(deriveHealth(fresh)).toBe("ONLINE");
    expect(deriveHealth(late)).toBe("DEGRADED");
    expect(deriveHealth(gone)).toBe("OFFLINE");
    expect(deriveHealth({ ...fresh, lastHeartbeatAt: null })).toBe("UNKNOWN");
    // Maintenance never hides an outage.
    expect(deriveHealth({ ...gone, maintenance: true })).toBe("OFFLINE");
  });

  it("sweepStaleNodes marks silent nodes OFFLINE", async () => {
    await seedFixture();
    const node = await prisma.vpnNode.create({
      data: {
        nodeId: "node_silent01",
        name: "Silent",
        location: "lab",
        publicEndpoint: "203.0.113.21",
        port: 51820,
        protocol: "WIREGUARD",
        status: "ONLINE",
        health: "ONLINE",
        approvalState: "APPROVED",
        agentTokenHash: "x",
        agentTokenHint: "x",
        adapterKey: "wireguard",
        isRealGateway: true,
        lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000),
        tags: [],
      },
    });
    const marked = await sweepStaleNodes();
    expect(marked).toBeGreaterThanOrEqual(1);
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: node.id } });
    expect(row.health).toBe("OFFLINE");
    expect(row.status).toBe("OFFLINE");
  });
});

describe("token rotation and update", () => {
  it("rotates the token and invalidates the old one", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    const rotated = await rotateNodeToken({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    expect(rotated.agentToken).not.toBe(enrolled.agentToken);
    await expect(authenticateAgent(agentRequest(enrolled.agentToken))).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const { node } = await authenticateAgent(agentRequest(rotated.agentToken));
    expect(node.id).toBe(enrolled.id);
  });

  it("rejects rotation for revoked nodes", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    await revokeNode({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" });
    await expect(
      rotateNodeToken({ nodeId: enrolled.id, actorId: actor.userId, actorLabel: "owner" }),
    ).rejects.toMatchObject({ code: "NODE_REVOKED" });
  });

  it("updateNode stores maintenance intent", async () => {
    const enrolled = await enroll();
    const actor = await seedFixture();
    await updateNode({ nodeId: enrolled.id, maintenance: true, actorId: actor.userId, actorLabel: "owner" });
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: enrolled.id } });
    expect(row.maintenance).toBe(true);
  });

  it("createNode issues a one-time token and starts PENDING", async () => {
    const actor = await seedFixture();
    const created = await createNode({
      name: "Ops node",
      location: "lab",
      publicEndpoint: "203.0.113.22",
      port: 51820,
      protocol: "WIREGUARD",
      adapterKey: "wireguard",
      isRealGateway: true,
      actorId: actor.userId,
      actorLabel: "owner",
    });
    expect(created.agentToken.startsWith("vwrt.")).toBe(true);
    const row = await prisma.vpnNode.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.approvalState).toBe("PENDING");
  });

  it("listNodes exposes approval and capability fields, filterable", async () => {
    await enroll("node_filter_a");
    const pending = await listNodes({ approval: "PENDING" });
    expect(pending.length).toBeGreaterThanOrEqual(1);
    expect(pending[0]?.capabilities.vpnReachable).toBe("UNVERIFIED");
    expect(await listNodes({ approval: "APPROVED" })).toHaveLength(0);
  });
});

