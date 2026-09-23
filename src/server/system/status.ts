import "server-only";
import { prisma } from "@/server/db/client";
import { checkDatabase } from "@/server/db/client";
import { getEnv, publicEnv } from "@/server/config/env";
import { aggregator } from "@/server/realtime/aggregator";
import { subscriberCount } from "@/server/realtime/bus";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";
import { logger } from "@/server/lib/logger";

/**
 * System status: the single source for every "is it up?" answer in the console.
 *
 * Rules that keep this honest:
 *   * A subsystem is only reported `up` when something was actually observed. A node
 *     whose heartbeat is stale yields `unavailable`, not `up` with 0 bps.
 *   * A database failure is reported as data, not thrown as a 500, so the dashboard
 *     can render "Database unavailable" instead of a blank screen.
 *   * Nothing here is invented to fill a field: unknown stays `unknown`.
 */

export interface SystemStatus {
  ts: number;
  controlPlane: "up" | "degraded" | "down";
  database: { state: "up" | "down"; latencyMs: number | null };
  realtime: {
    clients: number;
    lastTickAt: number | null;
    status: "live" | "idle" | "stale" | "mock";
  };
  gateway: {
    state: "connected" | "degraded" | "unavailable" | "unknown";
    nodesOnline: number;
    nodesTotal: number;
    lastHeartbeatAt: number | null;
    mockOnly: boolean;
  };
  dns: { state: "up" | "disabled" | "unknown"; provider: string };
  optimization: { state: "up" | "unknown"; profilesEnabled: number };
  mode: "development" | "production" | "test";
  devMockEnabled: boolean;
}

/** Gathers every subsystem state in parallel; each probe is individually guarded. */
export async function getSystemStatus(): Promise<SystemStatus> {
  const env = getEnv();

  const [database, gateway, dns, optimization] = await Promise.all([
    checkDatabase(),
    gatewayStatus(),
    dnsStatus(env.DNS_PROVIDER),
    optimizationStatus(),
  ]);

  const realtimeStatus = aggregator.cachedStatus();
  const lastTickAt = aggregator.lastTick();

  // The control plane counts as degraded when a dependency it needs to be useful is
  // down. It is only "down" when the database is unreachable, because that is the
  // one failure that makes every page meaningless.
  const controlPlane: SystemStatus["controlPlane"] = !database.ok
    ? "down"
    : gateway.state === "unavailable" || realtimeStatus === "stale"
      ? "degraded"
      : "up";

  return {
    ts: Date.now(),
    controlPlane,
    database: { state: database.ok ? "up" : "down", latencyMs: database.latencyMs },
    realtime: { clients: subscriberCount(), lastTickAt, status: realtimeStatus },
    gateway,
    dns,
    optimization,
    mode: env.NODE_ENV,
    devMockEnabled: env.isDevelopment && env.DEV_MOCK_GATEWAY_ENABLED,
  };
}

/**
 * Gateway visibility, derived from heartbeat freshness.
 *
 * `nodesTotal === 0` means no gateway has ever registered. That is `unknown`, not
 * `unavailable`: reporting a gateway as broken when none was configured would be as
 * misleading as reporting zero traffic.
 */
async function gatewayStatus(): Promise<SystemStatus["gateway"]> {
  try {
    const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
    const nodes = await prisma.vpnNode.findMany({
      select: {
        isRealGateway: true,
        lastHeartbeatAt: true,
        maintenance: true,
        draining: true,
        health: true,
      },
    });

    if (nodes.length === 0) {
      return {
        state: "unknown",
        nodesOnline: 0,
        nodesTotal: 0,
        lastHeartbeatAt: null,
        mockOnly: false,
      };
    }

    let online = 0;
    let degraded = 0;
    let lastHeartbeatAt: number | null = null;

    for (const node of nodes) {
      const health = deriveHealth({
        lastHeartbeatAt: node.lastHeartbeatAt,
        staleSeconds,
        maintenance: node.maintenance,
        draining: node.draining,
      });
      if (health === "ONLINE") online += 1;
      if (health === "DEGRADED") degraded += 1;
      if (node.lastHeartbeatAt) {
        lastHeartbeatAt = Math.max(lastHeartbeatAt ?? 0, node.lastHeartbeatAt.getTime());
      }
    }

    const mockOnly = nodes.every((node) => !node.isRealGateway);

    return {
      state:
        online === 0
          ? "unavailable"
          : online < nodes.length || degraded > 0
            ? "degraded"
            : "connected",
      nodesOnline: online,
      nodesTotal: nodes.length,
      lastHeartbeatAt,
      mockOnly,
    };
  } catch (error) {
    logger.warn("gateway status probe failed", { error });
    return {
      state: "unknown",
      nodesOnline: 0,
      nodesTotal: 0,
      lastHeartbeatAt: null,
      mockOnly: false,
    };
  }
}

/**
 * DNS service state.
 *
 * `disabled` is the honest answer when the provider is `none`, and it is distinct
 * from `unknown`, which means a provider is configured but its health is not
 * observable from the control plane.
 */
async function dnsStatus(provider: string): Promise<SystemStatus["dns"]> {
  try {
    const enabled = await getSetting<boolean>("dns.filteringEnabled");
    if (!enabled || provider === "none") return { state: "disabled", provider };
    return { state: enabled ? "unknown" : "disabled", provider };
  } catch {
    return { state: "unknown", provider };
  }
}

/** The optimization engine is in-process, so `up` only requires reachable profiles. */
async function optimizationStatus(): Promise<SystemStatus["optimization"]> {
  try {
    const profilesEnabled = await prisma.optimizationProfile.count({ where: { enabled: true } });
    return { state: profilesEnabled > 0 ? "up" : "unknown", profilesEnabled };
  } catch {
    return { state: "unknown", profilesEnabled: 0 };
  }
}

/** Public, secret-free configuration shown in the console footer and setup page. */
export function describePublicEnv() {
  return publicEnv();
}
