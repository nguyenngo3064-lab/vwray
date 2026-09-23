import "server-only";
import { z } from "zod";
import { jsonError, jsonOk, withErrorHandling } from "@/server/http/respond";
import { withConsole, readJson, paginationFrom, sourceIpOf } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";

/**
 * Health and observability.
 *
 * This route is intentionally UNAUTHENTICATED and minimal: load balancers, Docker
 * healthchecks and uptime monitors need to reach it without a session. It reports
 * only subsystem states (up/down plus latency and a last-seen clock), never data,
 * so exposing it publicly leaks nothing an attacker can use.
 *
 * Each check is individually guarded: a database outage must still return a 200 with
 * `database: down`, not a 500 with a stack trace, because the whole point of this
 * endpoint is to say what is broken.
 */

export const GET = withErrorHandling(async (request: Request) => {
  const startedAt = Date.now();
  const { checkDatabase } = await import("@/server/db/client");
  const { subscriberCount } = await import("@/server/realtime/bus");
  const { aggregator } = await import("@/server/realtime/aggregator");
  const { getEnvError } = await import("@/server/config/env");

  const database = await checkDatabase();
  const envError = getEnvError();

  // Gateway visibility is computed from heartbeat freshness, exactly the way the
  // dashboard's status strip computes it. A missing node row or an old heartbeat is
  // a fact, not an exception.
  let gateway: {
    state: "connected" | "degraded" | "unavailable" | "unknown";
    nodesOnline: number;
    nodesTotal: number;
    lastHeartbeatAt: number | null;
    mockOnly: boolean;
  };

  try {
    const { prisma } = await import("@/server/db/client");
    const { deriveHealth } = await import("@/server/nodes/service");
    const { getSetting } = await import("@/server/settings/service");

    const [nodes, staleSeconds] = await Promise.all([
      prisma.vpnNode.findMany({ select: { isRealGateway: true, lastHeartbeatAt: true } }),
      getSetting<number>("nodes.heartbeatStaleSeconds").catch(() => 90),
    ]);

    const online = nodes.filter(
      (node) =>
        deriveHealth({ lastHeartbeatAt: node.lastHeartbeatAt, staleSeconds, maintenance: false, draining: false }) ===
        "ONLINE",
    ).length;

    const lastHeartbeatAt = nodes.reduce<number | null>(
      (latest, node) =>
        node.lastHeartbeatAt ? Math.max(latest ?? 0, node.lastHeartbeatAt.getTime()) : latest,
      null,
    );

    gateway = {
      state: nodes.length === 0 ? "unknown" : online === 0 ? "unavailable" : online < nodes.length ? "degraded" : "connected",
      nodesOnline: online,
      nodesTotal: nodes.length,
      lastHeartbeatAt,
      mockOnly: nodes.length > 0 && nodes.every((node) => !node.isRealGateway),
    };
  } catch {
    gateway = { state: "unknown", nodesOnline: 0, nodesTotal: 0, lastHeartbeatAt: null, mockOnly: false };
  }

  const body = {
    status: database.ok && !envError ? "ok" : "degraded",
    service: "vwray-control-plane",
    uptimeMs: Date.now() - startedAt,
    database,
    configuration: envError ? { valid: false, error: envError.message } : { valid: true },
    realtime: { clients: subscriberCount(), lastTickAt: aggregator.lastTick() },
    gateway,
  };

  return jsonOk(body, { status: database.ok ? 200 : 503 });
});
