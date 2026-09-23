import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { prisma } from "@/server/db/client";
import { getSetting } from "@/server/settings/service";
import { deriveHealth, listNodes } from "@/server/nodes/service";
import { adapterKeyFor, getAdapter } from "@/server/vpn/registry";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  location: z.string().min(1).max(80).optional(),
  provider: z.string().max(80).nullable().optional(),
  publicEndpoint: z.string().min(1).max(120).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  maxSessions: z.coerce.number().int().min(1).max(1_000_000).nullable().optional(),
  weight: z.coerce.number().int().min(0).max(10_000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
  const nodes = await listNodes();
  const node = nodes.find((entry) => entry.id === id);
  if (!node) throw errors.notFound("VPN node");

  const adapterKey = adapterKeyFor({ protocol: node.protocol, adapterKey: node.adapterKey, isRealGateway: node.isRealGateway });
  const adapter = getAdapter(adapterKey);
  let adapterStatus: unknown = null;
  try {
    adapterStatus = await adapter.getStatus();
  } catch (caught) {
    adapterStatus = { online: false, error: caught instanceof Error ? caught.message : "Adapter unreachable." };
  }

  const [healthSamples, sessions, quotas, enforcement, pendingPolicies] = await Promise.all([
    prisma.nodeHealthSample.findMany({ where: { nodeId: node.id }, orderBy: { sampledAt: "asc" }, take: 300 }),
    prisma.vpnSession.findMany({
      where: { nodeId: node.id },
      orderBy: { startedAt: "desc" },
      take: 50,
      include: { device: { select: { displayName: true } } },
    }),
    prisma.quota.findMany({ where: { nodeId: node.id } }),
    prisma.gatewayPolicyState.findMany({
      where: { nodeId: node.id },
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: { device: { select: { displayName: true } } },
    }),
    prisma.gatewayPolicyState.count({ where: { nodeId: node.id, ackedAt: null } }),
  ]);

  return jsonOk(
    {
      node: {
        ...node,
        lastHeartbeatAt: node.lastHeartbeatAt ? node.lastHeartbeatAt.toISOString() : null,
        registeredAt: node.registeredAt.toISOString(),
        healthReason: node.lastHeartbeatAt
          ? "Derived from heartbeat freshness inside the staleness window."
          : "No heartbeat has ever been received; health cannot be confirmed.",
        derivedHealth: deriveHealth({
          lastHeartbeatAt: node.lastHeartbeatAt,
          staleSeconds,
          maintenance: node.maintenance,
          draining: node.draining,
        }),
      },
      adapter: { key: adapterKey, displayName: adapter.displayName, protocol: node.protocol },
      adapterStatus,
      healthSamples: healthSamples.map((sample) => ({ ...sample, sampledAt: sample.sampledAt.toISOString() })),
      sessions: sessions.map((session) => ({
        id: session.id,
        deviceLabel: session.device.displayName,
        startedAt: session.startedAt.toISOString(),
        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
        bytesUp: session.bytesUp.toString(),
        bytesDown: session.bytesDown.toString(),
        endReason: session.endReason,
        source: session.source,
      })),
      quotas: quotas.map((quota) => ({
        ...quota,
        limitBytes: quota.limitBytes.toString(),
        usedBytes: quota.usedBytes.toString(),
      })),
      enforcement: enforcement.map((policy) => ({
        id: policy.id,
        deviceLabel: policy.device?.displayName ?? null,
        state: policy.state,
        reason: policy.reason,
        revision: policy.revision,
        appliedAt: policy.appliedAt ? policy.appliedAt.toISOString() : null,
        ackedAt: policy.ackedAt ? policy.ackedAt.toISOString() : null,
        updatedAt: policy.updatedAt.toISOString(),
      })),
      staleSeconds,
      pendingPolicyCount: pendingPolicies,
    },
    { requestId: ctx.requestId },
  );
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = patchSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The node payload is invalid.");
    const { updateNode } = await import("@/server/nodes/service");
    const result = await updateNode({
      nodeId: id,
      ...parsed.data,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);

export async function POST(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const { id } = await routeContext.params;
  const url = new URL(request.url);
  const action = url.searchParams.get("action");
  const force = url.searchParams.get("force") === "true";

  if (action === "rotate-token") {
    return withConsole(async (_inner, ctx) => {
      const { rotateNodeToken } = await import("@/server/nodes/service");
      const rotated = await rotateNodeToken({
        nodeId: id,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(
        { id, agentToken: rotated.agentToken, note: "The previous token stopped working immediately. Store the new one now." },
        { requestId: ctx.requestId },
      );
    }, { role: "ADMIN" })(request);
  }

  if (action === "drain" || action === "undrain") {
    return withConsole(async (_inner, ctx) => {
      if (action === "drain" && !force) {
        const active = await prisma.vpnSession.count({ where: { nodeId: id, endedAt: null } });
        if (active > 0) {
          throw errors.conflict(`${active} session(s) are still active. Re-run with ?force=true to drain anyway.`);
        }
      }
      const { updateNode } = await import("@/server/nodes/service");
      const result = await updateNode({
        nodeId: id,
        draining: action === "drain",
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "maintenance-on" || action === "maintenance-off") {
    return withConsole(async (_inner, ctx) => {
      const { updateNode } = await import("@/server/nodes/service");
      const result = await updateNode({
        nodeId: id,
        maintenance: action === "maintenance-on",
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "healthcheck") {
    return withConsole(async (_inner, ctx) => {
      const { applyHeartbeat } = await import("@/server/nodes/service");
      const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
      await applyHeartbeat(id, {});
      const refreshed = await prisma.vpnNode.findUnique({ where: { id } });
      const health = deriveHealth({
        lastHeartbeatAt: refreshed?.lastHeartbeatAt ?? null,
        staleSeconds,
        maintenance: false,
        draining: false,
      });
      return jsonOk({ id, health }, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "remove") {
    return withConsole(async (_inner, ctx) => {
      const { removeNode } = await import("@/server/nodes/service");
      const removed = await removeNode({
        nodeId: id,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk({ id, ...removed }, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  const { withErrorHandling } = await import("@/server/http/respond");
  return withErrorHandling(async () => {
    throw errors.validation(`Unknown action "${action}".`);
  })(request);
}
