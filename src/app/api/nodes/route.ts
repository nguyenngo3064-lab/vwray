import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { createNode, listNodes } from "@/server/nodes/service";

export const GET = withConsole(async (_request, ctx) => {
  const nodes = await listNodes({
    search: ctx.url.searchParams.get("search") ?? undefined,
    protocol: ctx.url.searchParams.get("protocol") ?? undefined,
    health: ctx.url.searchParams.get("health") ?? undefined,
  });
  const annotated = nodes.map((node) => ({ ...node, healthReason: healthReasonOf(node) }));
  return jsonOk(annotated, {
    meta: { total: annotated.length },
    requestId: ctx.requestId,
  });
});

const createSchema = z.object({
  name: z.string().min(1).max(80),
  location: z.string().min(1).max(80),
  provider: z.string().max(80).optional().nullable(),
  publicEndpoint: z.string().min(1).max(120),
  port: z.coerce.number().int().min(1).max(65535),
  protocol: z.enum(["WIREGUARD", "XRAY_VLESS", "XRAY_VMESS", "XRAY_TROJAN", "MOCK"]),
  isRealGateway: z.boolean().optional(),
  maxSessions: z.coerce.number().int().min(1).max(1_000_000).optional().nullable(),
  weight: z.coerce.number().int().min(0).max(10_000).optional(),
  tags: z.array(z.string().max(40)).max(20).optional(),
});

function healthReasonOf(node: {
  health: string;
  lastHeartbeatAt: Date | null;
  draining: boolean;
  maintenance: boolean;
}): string {
  if (node.maintenance) return "Node is in maintenance mode.";
  if (node.draining) return "Node is draining: no new sessions are accepted.";
  if (!node.lastHeartbeatAt) return "No heartbeat has ever been received from this node.";
  if (node.health === "ONLINE") return "Heartbeat is fresh inside the staleness window.";
  if (node.health === "DEGRADED") return "Heartbeat is older than the staleness window.";
  if (node.health === "OFFLINE") return "Heartbeat is older than twice the staleness window.";
  return "Health cannot be determined without heartbeat data.";
}

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The node payload is invalid.");

    const protocol = parsed.data.protocol;
    const adapterKey = protocol === "WIREGUARD" ? "wireguard" : protocol === "MOCK" ? "mock" : "xray";
    const created = await createNode({
      name: parsed.data.name,
      location: parsed.data.location,
      provider: parsed.data.provider ?? null,
      publicEndpoint: parsed.data.publicEndpoint,
      port: parsed.data.port,
      protocol,
      adapterKey,
      isRealGateway: parsed.data.isRealGateway ?? protocol !== "MOCK",
      maxSessions: parsed.data.maxSessions ?? null,
      weight: parsed.data.weight ?? 100,
      tags: parsed.data.tags ?? [],
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });

    return jsonOk(
      {
        node: created,
        agentToken: created.agentToken,
        note: "Store this agent token in the gateway agent now. Only its hash is kept; it cannot be retrieved again.",
      },
      { status: 201, requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
