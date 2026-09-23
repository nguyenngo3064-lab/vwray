import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { publishDomain } from "@/server/events/dispatch";
import { listTimeline } from "@/server/timeline/service";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";
import { resolveRange } from "@/server/lib/time";

/**
 * Node health centre read model + drain workflow.
 *
 * Timeline: every heartbeat already writes a NodeHealthSample; state transitions are
 * timeline entries, so the history view joins samples (the measurement) with timeline
 * rows (the meaning). Nothing here guesses: a node with no samples reads "no samples",
 * and health never renders ONLINE without a heartbeat.
 *
 * Draining (the "Drain node" action):
 *   1. `draining` is set and the pool policy stops new assignments;
 *   2. existing sessions keep running - this code never closes one;
 *   3. each poll reports the remaining count until it reaches zero;
 *   4. at zero the node reports `safeToRestart`, keeps DRAINING (so nothing new lands on
 *      it) and may move to MAINTENANCE on operator request.
 */

export interface HealthSampleView {
  ts: string;
  cpuPercent: number | null;
  ramPercent: number | null;
  bandwidthMbps: number | null;
  latencyMs: number | null;
  packetLossPct: number | null;
  activeSessions: number | null;
  source: string;
}

export interface HealthHistory {
  node: { id: string; name: string; nodeId: string; health: ReturnType<typeof deriveHealth> };
  range: { start: string; end: string; preset: string };
  samples: HealthSampleView[];
  sampleCount: number;
  stateTransitions: Array<{ ts: string; type: string; label: string; reason: string | null }>;
  timeline: Array<{ ts: string; type: string; label: string; reason: string | null; actor: string }>;
  current: {
    health: ReturnType<typeof deriveHealth>;
    lastHeartbeatAt: string | null;
    staleSeconds: number;
    draining: boolean;
    maintenance: boolean;
  };
  available: boolean;
  reason: string | null;
}

export async function getNodeHealthHistory(nodeId: string, preset = "1d"): Promise<HealthHistory> {
  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId } });
  if (!node) throw errors.notFound("VPN node");

  const range = resolveRange({ preset }) ?? resolveRange({ preset: "7d" });
  if (!range) throw errors.validation("Invalid range.");
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
  const health = deriveHealth({
    lastHeartbeatAt: node.lastHeartbeatAt,
    staleSeconds,
    maintenance: node.maintenance,
    draining: node.draining,
  });

  const samples = await prisma.nodeHealthSample.findMany({
    where: { nodeId, sampledAt: { gte: range.start, lt: range.end } },
    orderBy: { sampledAt: "asc" },
    take: 5000,
  });

  const timeline = await listTimeline({ nodeId, page: 1, pageSize: 100, order: "asc" });
  const transitions = timeline.items.filter((entry) => entry.type === "NODE_HEALTH_CHANGED");

  return {
    node: { id: node.id, name: node.name, nodeId: node.nodeId, health },
    range: { start: range.start.toISOString(), end: range.end.toISOString(), preset },
    samples: samples.map((row) => ({
      ts: row.sampledAt.toISOString(),
      cpuPercent: row.cpuPercent,
      ramPercent: row.ramPercent,
      bandwidthMbps: row.bandwidthMbps,
      latencyMs: row.latencyMs,
      packetLossPct: row.packetLossPct,
      activeSessions: row.activeSessions,
      source: row.source,
    })),
    sampleCount: samples.length,
    stateTransitions: transitions.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      label: entry.typeLabel,
      reason: entry.reason,
    })),
    timeline: timeline.items.map((entry) => ({
      ts: entry.ts,
      type: entry.type,
      label: entry.typeLabel,
      reason: entry.reason,
      actor: entry.actorLabel ?? entry.actor,
    })),
    current: {
      health,
      lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
      staleSeconds,
      draining: node.draining,
      maintenance: node.maintenance,
    },
    available: true,
    reason: null,
  };
}

export interface DrainStatus {
  draining: boolean;
  remainingSessions: number;
  safeToRestart: boolean;
  sessionsChangedSince: number | null;
  sessions: Array<{ id: string; deviceLabel: string | null; startedAt: string; lastSeenAt: string; bytesUp: string; bytesDown: string }>;
}

async function drainStatus(nodeId: string): Promise<DrainStatus> {
  const node = await prisma.vpnNode.findUnique({ where: { id: nodeId }, select: { draining: true } });
  if (!node) throw errors.notFound("VPN node");
  const sessions = await prisma.vpnSession.findMany({
    where: { nodeId, endedAt: null },
    orderBy: { lastSeenAt: "desc" },
    take: 200,
    include: { device: { select: { displayName: true } } },
  });
  return {
    draining: node.draining,
    remainingSessions: sessions.length,
    safeToRestart: node.draining && sessions.length === 0,
    sessionsChangedSince: null,
    sessions: sessions.map((session) => ({
      id: session.id,
      deviceLabel: session.device?.displayName ?? null,
      startedAt: session.startedAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      bytesUp: session.bytesUp.toString(),
      bytesDown: session.bytesDown.toString(),
    })),
  };
}

/** Operator action: mark a node draining (stop new sessions, keep existing ones). */
export async function startNodeDrain(input: {
  nodeId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<DrainStatus> {
  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("VPN node");
  if (node.draining) return drainStatus(node.id);
  if (node.maintenance) throw errors.validation("The node is in MAINTENANCE; draining does not apply while it is out of service.");

  await prisma.$transaction([
    prisma.vpnNode.update({ where: { id: node.id }, data: { draining: true } }),
    prisma.nodePoolPolicy.upsert({
      where: { nodeId: node.id },
      create: { nodeId: node.id, enabled: false },
      update: { enabled: false },
    }),
  ]);

  const status = await drainStatus(node.id);

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "node.drain_started",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { remainingSessions: status.remainingSessions, reason: input.reason },
  });

  await publishDomain("node.draining", {
    ts: Date.now(),
    nodeId: node.id,
    nodeLabel: node.name,
    remainingSessions: status.remainingSessions,
    safeToRestart: status.safeToRestart,
    reason: input.reason,
  });

  return status;
}

/** Poll for the drain page: remaining count, safe-to-restart verdict. */
export async function pollNodeDrain(nodeId: string, previous?: number): Promise<DrainStatus> {
  const status = await drainStatus(nodeId);
  return { ...status, sessionsChangedSince: previous === undefined ? null : previous - status.remainingSessions };
}

/** Abort a drain: let new sessions land here again. */
export async function abortNodeDrain(input: {
  nodeId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<DrainStatus> {
  const node = await prisma.vpnNode.findUnique({ where: { id: input.nodeId } });
  if (!node) throw errors.notFound("VPN node");

  await prisma.$transaction([
    prisma.vpnNode.update({ where: { id: node.id }, data: { draining: false } }),
    prisma.nodePoolPolicy.upsert({
      where: { nodeId: node.id },
      create: { nodeId: node.id, enabled: true },
      update: { enabled: true },
    }),
  ]);

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "node.drain_aborted",
    resource: "vpn_node",
    resourceId: node.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: { reason: input.reason },
  });

  return drainStatus(node.id);
}
