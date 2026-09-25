import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { sha256Hex, sealSecret, unsealSecret, fingerprintOf } from "@/server/lib/crypto";
import { generateNodeId, randomToken } from "@/server/lib/ids";
import { record, systemActor } from "@/server/audit";
import { getAdapter, adapterKeyFor } from "@/server/vpn/registry";
import { getSetting } from "@/server/settings/service";
import type { WireGuardAdapter } from "@/server/vpn/adapters/wireguard";
import type { XrayAdapter } from "@/server/vpn/adapters/xray";
import { publish } from "@/server/realtime/bus";
import { notify } from "@/server/notifications/service";

/**
 * VPN node service.
 *
 * Health is derived, never assumed. A node is ONLINE only inside the heartbeat
 * staleness window configured at `nodes.heartbeatStaleSeconds`; beyond it the node
 * is DEGRADED until twice the window, then OFFLINE. The single place that computes
 * this is `deriveHealth`, and every read path (list, dashboard, policy pull) uses it,
 * so the UI can never show a silently-stale node as healthy.
 */

/**
 * Health state a node can present to operators and to the route selector.
 *
 * `DRAINING` and `MAINTENANCE` are OPERATIONAL states an operator asked for; they are
 * deliberately not "healthy" claims and they are only ever reported while the node is
 * still reporting normally. An outage is never hidden behind them: if the heartbeat has
 * gone stale the state stays `OFFLINE`, because "we asked it to drain" is not evidence
 * that the box is still up.
 */
export type DisplayHealth =
  | "ONLINE"
  | "DEGRADED"
  | "OFFLINE"
  | "UNKNOWN"
  | "DRAINING"
  | "MAINTENANCE";

export function deriveHealth(input: {
  lastHeartbeatAt: Date | null;
  staleSeconds: number;
  maintenance: boolean;
  draining: boolean;
}): DisplayHealth {
  // Heartbeat first: liveness is the only thing that can prove a node is down, and no
  // operator intent may override a real "it stopped reporting".
  let heartbeatState: DisplayHealth;
  if (!input.lastHeartbeatAt) {
    heartbeatState = "UNKNOWN";
  } else {
    const ageMs = Date.now() - input.lastHeartbeatAt.getTime();
    if (ageMs > input.staleSeconds * 2 * 1000) heartbeatState = "OFFLINE";
    else if (ageMs > input.staleSeconds * 1000) heartbeatState = "DEGRADED";
    else heartbeatState = "ONLINE";
  }

  if (heartbeatState === "OFFLINE") return "OFFLINE";
  if (input.maintenance) return "MAINTENANCE";
  if (input.draining) return "DRAINING";
  return heartbeatState;
}

export async function listNodes(filters?: {
  search?: string;
  protocol?: string;
  health?: string;
}) {
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
  const nodes = await prisma.vpnNode.findMany({ orderBy: { name: "asc" } });

  const annotated = nodes.map((node) => ({
    id: node.id,
    nodeId: node.nodeId,
    name: node.name,
    location: node.location,
    provider: node.provider,
    publicEndpoint: node.publicEndpoint,
    port: node.port,
    protocol: node.protocol,
    adapterKey: node.adapterKey,
    isRealGateway: node.isRealGateway,
    health: deriveHealth({
      lastHeartbeatAt: node.lastHeartbeatAt,
      staleSeconds,
      maintenance: node.maintenance,
      draining: node.draining,
    }),
    storedHealth: node.health,
    version: node.version,
    agentVersion: node.agentVersion,
    cpuPercent: node.cpuPercent,
    ramPercent: node.ramPercent,
    bandwidthMbps: node.bandwidthMbps,
    activeSessions: node.activeSessions,
    maxSessions: node.maxSessions,
    weight: node.weight,
    draining: node.draining,
    maintenance: node.maintenance,
    lastHeartbeatAt: node.lastHeartbeatAt,
    registeredAt: node.registeredAt,
    tokenHint: node.agentTokenHint,
  }));

  const search = filters?.search?.trim().toLowerCase();
  return annotated.filter((node) => {
    if (filters?.protocol && node.protocol !== filters.protocol) return false;
    if (filters?.health && node.health !== filters.health) return false;
    if (search && ![node.name, node.nodeId, node.location, node.publicEndpoint]
      .some((value) => value.toLowerCase().includes(search))) return false;
    return true;
  });
}

async function assertNodeExists(nodeId: string) {
  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId } });
  if (!node) throw errors.notFound("VPN node");
  return node;
}

/**
 * Registers a node. Returns the agent token exactly once: the operator pastes it
 * into the gateway agent's environment (GATEWAY_AGENT_TOKEN is per-node, so the
 * value here is node-scoped). Only the hash is stored.
 */
export async function createNode(input: {
  nodeId?: string;
  name: string;
  location: string;
  provider?: string | null;
  publicEndpoint: string;
  port: number;
  protocol: "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
  adapterKey: string;
  isRealGateway: boolean;
  maxSessions?: number | null;
  weight?: number;
  tags?: string[];
  actorId?: string;
  actorLabel?: string;
  sourceIp?: string | null;
}) {
  const secret = randomToken(24);
  const nodeId = input.nodeId ?? generateNodeId("node");
  const token = `vwrt.${nodeId}.${secret}`;

  const node = await prisma.vpnNode.create({
    data: {
      nodeId,
      name: input.name.slice(0, 80),
      location: input.location.slice(0, 80),
      provider: input.provider?.slice(0, 80) ?? null,
      publicEndpoint: input.publicEndpoint.slice(0, 120),
      port: input.port,
      protocol: input.protocol,
      adapterKey: input.adapterKey.slice(0, 40),
      isRealGateway: input.isRealGateway,
      maxSessions: input.maxSessions ?? null,
      weight: input.weight ?? 100,
      tags: input.tags ?? [],
      agentTokenHash: sha256Hex(token),
      agentTokenHint: `${token.slice(0, 9)}...${token.slice(-4)}`,
    },
  });

  await record({
    actor: input.actorId
      ? { type: "USER", id: input.actorId, label: input.actorLabel ?? "operator" }
      : systemActor,
    action: "node.created",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { nodeId: node.nodeId, name: node.name, protocol: node.protocol },
  });

  return {
    id: node.id,
    nodeId: node.nodeId,
    /** Shown once. Store it in the gateway agent, then lose it on purpose. */
    agentToken: token,
  };
}

/** Registers an agent using a stable installation identity, without a console session. */
export async function registerNodeAgent(input: {
  nodeId: string;
  name: string;
  location: string;
  publicEndpoint: string;
  port: number;
  protocol: "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
  isRealGateway: boolean;
  sourceIp?: string | null;
}) {
  const existing = await prisma.vpnNode.findUnique({ where: { nodeId: input.nodeId } });
  if (existing) {
    const created = await createNodeTokenFor(existing.id, existing.nodeId);
    await prisma.vpnNode.update({
      where: { id: existing.id },
      data: {
        name: input.name.slice(0, 80),
        location: input.location.slice(0, 80),
        publicEndpoint: input.publicEndpoint.slice(0, 120),
        port: input.port,
        protocol: input.protocol,
        adapterKey: input.protocol === "WIREGUARD" ? "wireguard" : input.protocol === "MOCK" ? "mock" : "xray",
        isRealGateway: input.isRealGateway,
      },
    });
    return { id: existing.id, nodeId: existing.nodeId, agentToken: created.token };
  }

  return createNode({
    nodeId: input.nodeId,
    name: input.name,
    location: input.location,
    publicEndpoint: input.publicEndpoint,
    port: input.port,
    protocol: input.protocol,
    adapterKey: input.protocol === "WIREGUARD" ? "wireguard" : input.protocol === "MOCK" ? "mock" : "xray",
    isRealGateway: input.isRealGateway,
    actorLabel: "node-enrollment",
    sourceIp: input.sourceIp,
  });
}

async function createNodeTokenFor(id: string, nodeId: string) {
  const secret = randomToken(24);
  const token = `vwrt.${nodeId}.${secret}`;
  await prisma.vpnNode.update({
    where: { id },
    data: { agentTokenHash: sha256Hex(token), agentTokenHint: `${token.slice(0, 9)}...${token.slice(-4)}` },
  });
  return { token };
}

/** Rotates a node token: the old one stops working immediately. */
export async function rotateNodeToken(input: {
  nodeId: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("Node");

  const secret = randomToken(24);
  const token = `vwrt.${node.nodeId}.${secret}`;

  await prisma.vpnNode.update({
    where: { id: node.id },
    data: {
      agentTokenHash: sha256Hex(token),
      agentTokenHint: `${token.slice(0, 9)}...${token.slice(-4)}`,
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "node.token_rotated",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { nodeId: node.nodeId },
  });

  return { agentToken: token };
}

export async function updateNode(input: {
  nodeId: string;
  name?: string;
  location?: string;
  provider?: string | null;
  publicEndpoint?: string;
  port?: number;
  maxSessions?: number | null;
  weight?: number;
  tags?: string[];
  draining?: boolean;
  maintenance?: boolean;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("Node");

  const updated = await prisma.vpnNode.update({
    where: { id: node.id },
    data: {
      ...(input.name !== undefined ? { name: input.name.slice(0, 80) } : {}),
      ...(input.location !== undefined ? { location: input.location.slice(0, 80) } : {}),
      ...(input.provider !== undefined ? { provider: input.provider?.slice(0, 80) ?? null } : {}),
      ...(input.publicEndpoint !== undefined ? { publicEndpoint: input.publicEndpoint.slice(0, 120) } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.maxSessions !== undefined ? { maxSessions: input.maxSessions } : {}),
      ...(input.weight !== undefined ? { weight: input.weight } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
      ...(input.draining !== undefined ? { draining: input.draining } : {}),
      ...(input.maintenance !== undefined ? { maintenance: input.maintenance } : {}),
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: input.draining !== undefined ? "node.draining" : "node.updated",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { draining: updated.draining, maintenance: updated.maintenance },
  });

  return { id: updated.id };
}

export async function removeNode(input: {
  nodeId: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("Node");

  const attachedDevices = await prisma.device.count({ where: { assignedNodeId: node.id } });
  if (attachedDevices > 0) {
    throw errors.conflict(
      `This node still serves ${attachedDevices} device${attachedDevices === 1 ? "" : "s"}. Reassign them first.`,
    );
  }

  await prisma.vpnNode.delete({ where: { id: node.id } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "node.removed",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { nodeId: node.nodeId, name: node.name },
  });

  return { removed: true };
}

/**
 * Applies an agent heartbeat: metrics, health sample and last-heartbeat clock.
 *
 * Transition bookkeeping: when a node goes from anything-but-OFFLINE to OFFLINE a
 * CRITICAL notification goes out (the operator needs to know); when it comes back,
 * `node.recovered` closes the loop.
 */
export async function applyHeartbeat(
  nodeId: string,
  input: {
    cpuPercent?: number | null;
    ramPercent?: number | null;
    bandwidthMbps?: number | null;
    activeSessions?: number | null;
    latencyMs?: number | null;
    jitterMs?: number | null;
    packetLossPct?: number | null;
    version?: string | null;
    agentVersion?: string | null;
  },
  options?: { source?: "REAL" | "MOCK"; at?: Date },
) {
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
  const previous = await prisma.vpnNode.findUnique({ where: { id: nodeId } });
  if (!previous) return;

  const at = options?.at ?? new Date();

  const updated = await prisma.vpnNode.update({
    where: { id: nodeId },
    data: {
      cpuPercent: input.cpuPercent ?? undefined,
      ramPercent: input.ramPercent ?? undefined,
      bandwidthMbps: input.bandwidthMbps ?? undefined,
      activeSessions: input.activeSessions ?? previous.activeSessions,
      version: input.version ?? undefined,
      agentVersion: input.agentVersion ?? undefined,
      lastHeartbeatAt: at,
    },
  });

  await prisma.nodeHealthSample.create({
    data: {
      nodeId,
      sampledAt: at,
      cpuPercent: input.cpuPercent ?? null,
      ramPercent: input.ramPercent ?? null,
      bandwidthMbps: input.bandwidthMbps ?? null,
      activeSessions: input.activeSessions ?? null,
      latencyMs: input.latencyMs ?? null,
      jitterMs: input.jitterMs ?? null,
      packetLossPct: input.packetLossPct ?? null,
      source: options?.source ?? "REAL",
    },
  });

  const before = deriveHealth({
    lastHeartbeatAt: previous.lastHeartbeatAt,
    staleSeconds,
    maintenance: previous.maintenance,
    draining: previous.draining,
  });
  const after = deriveHealth({
    lastHeartbeatAt: updated.lastHeartbeatAt,
    staleSeconds,
    maintenance: updated.maintenance,
    draining: updated.draining,
  });

  publish("node.update", {
    ts: at.getTime(),
    nodeId: updated.nodeId,
    health: after,
    lastHeartbeatAt: updated.lastHeartbeatAt?.getTime() ?? null,
  });

  if (before !== "OFFLINE" && after === "OFFLINE") {
    await notify({
      type: "node.offline",
      severity: "CRITICAL",
      title: "Node offline",
      body: `${updated.name} stopped reporting. Last heartbeat ${previous.lastHeartbeatAt?.toISOString() ?? "unknown"}.`,
      resource: "vpn_node",
      resourceId: updated.id,
    });
  }

  if (before === "OFFLINE" && after === "ONLINE") {
    await notify({
      type: "node.recovered",
      severity: "INFO",
      title: "Node recovered",
      body: `${updated.name} is reporting again.`,
      resource: "vpn_node",
      resourceId: updated.id,
    });
  }

  return { health: after };
}

/** Sweeps stale nodes that missed their window while no request touched them. */
export async function sweepStaleNodes(): Promise<number> {
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
  const nodes = await prisma.vpnNode.findMany();
  let marked = 0;

  for (const node of nodes) {
    const derived = deriveHealth({
      lastHeartbeatAt: node.lastHeartbeatAt,
      staleSeconds,
      maintenance: node.maintenance,
      draining: node.draining,
    });
    if (derived === "OFFLINE" && node.health !== "OFFLINE") {
      await prisma.vpnNode.update({ where: { id: node.id }, data: { health: "OFFLINE" } });
      await notify({
        type: "node.offline",
        severity: "CRITICAL",
        title: "Node offline",
        body: `${node.name} missed ${staleSeconds * 2} seconds of heartbeats and is marked OFFLINE.`,
        resource: "vpn_node",
        resourceId: node.id,
      });
      marked += 1;
    } else if (derived !== "OFFLINE" && node.health === "OFFLINE") {
      await prisma.vpnNode.update({ where: { id: node.id }, data: { health: derived } });
    }
  }

  return marked;
}
