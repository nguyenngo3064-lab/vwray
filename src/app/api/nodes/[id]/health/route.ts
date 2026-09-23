import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { prisma } from "@/server/db/client";
import { getSetting } from "@/server/settings/service";
import { deriveHealth } from "@/server/nodes/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(async (request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const hours = Math.max(1, Math.min(Number(ctx.url.searchParams.get("hours") ?? "24") || 24, 168));
  const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");

  const node = await prisma.vpnNode.findUnique({ where: { id } });
  if (!node) throw errors.notFound("VPN node");

  const since = new Date(Date.now() - hours * 3_600_000);
  const samples = await prisma.nodeHealthSample.findMany({
    where: { nodeId: node.id, sampledAt: { gte: since } },
    orderBy: { sampledAt: "asc" },
    take: 300,
  });

  void request;

  return jsonOk(
    {
      derived: deriveHealth({
        lastHeartbeatAt: node.lastHeartbeatAt,
        staleSeconds,
        maintenance: node.maintenance,
        draining: node.draining,
      }),
      staleSeconds,
      samples: samples.map((sample) => ({ ...sample, sampledAt: sample.sampledAt.toISOString() })),
    },
    { requestId: ctx.requestId },
  );
});
