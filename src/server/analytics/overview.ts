import "server-only";
import { prisma } from "@/server/db/client";
import { getSystemStatus } from "@/server/system/status";
import { aggregator } from "@/server/realtime/aggregator";
import { queryTraffic } from "@/server/analytics/traffic";
import { queryConsumers } from "@/server/analytics/consumers";
import { getBillingOverview } from "@/server/billing/service";
import { listQuotas } from "@/server/quota/engine";
import { getSetting } from "@/server/settings/service";

/**
 * Dashboard aggregation.
 *
 * `GET /api/overview` is the single request the landing page makes. It is assembled
 * here rather than in five endpoint calls so the sections on screen are guaranteed to
 * describe the SAME instant, and so the page can render one coherent story about
 * subsystem health instead of stitching together readings taken seconds apart.
 *
 * Every field is derived from a measurement: heartbeat freshness for node health,
 * stored aggregates for volume, the billing routine for cost, the device table for
 * counts. Nothing is synthesised to fill a cell, and `hasRealTraffic` / `mockDataPresent`
 * let the UI say plainly whether it is looking at production data, development mock
 * data, or nothing at all.
 */

export interface OverviewResult {
  system: Awaited<ReturnType<typeof getSystemStatus>>;
  network: {
    activeConnections: number;
    devicesTotal: number;
    devicesOnline: number;
    devicesPending: number;
    devicesBlocked: number;
    devicesQuotaExceeded: number;
    uploadBps: number;
    downloadBps: number;
    totalBps: number;
    realtimeStatus: "live" | "idle" | "stale" | "mock";
  };
  data: {
    usedTodayBytes: string;
    usedMonthBytes: string;
    remainingQuotaBytes: string | null;
    quotaLimitBytes: string | null;
    optimizedBytesMonth: string | null;
    savedBytesMonth: string | null;
    savingPct: number | null;
    savingsKind: "MEASURED" | "ESTIMATED" | "INSUFFICIENT_DATA";
    estimatedCostToday: number | null;
    estimatedCostMonth: number | null;
    currency: string;
  };
  quota: { exceededCount: number; warnedCount: number; thresholds: number[] };
  traffic: {
    granularity: "HOUR";
    series: Array<{ t: number; uploadBytes: string; downloadBytes: string; totalBytes: string }>;
  };
  consumers: Array<{ rank: number; dimension: string; label: string; bytes: string; sharePct: number | null }>;
  recentNodes: Array<{
    id: string;
    nodeId: string;
    name: string;
    health: "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN";
    activeSessions: number;
    cpuPercent: number | null;
    ramPercent: number | null;
    lastHeartbeatAt: number | null;
  }>;
  alerts: { openAnomalies: number; unreadNotifications: number };
  quotaEnforcementEnabled: boolean;
  hasRealTraffic: boolean;
  mockDataPresent: boolean;
  generatedAt: number;
}

/**
 * Builds the Overview payload.
 *
 * Subqueries are deliberately scoped to what the landing page draws: one day of
 * hourly series, one month of totals, five consumers, the most recent nodes. Sending
 * an unbounded history to populate a dashboard is how a console becomes unusable at
 * a few thousand devices.
 */
export async function getOverview(): Promise<OverviewResult> {
  const [system, counts, tick, today, monthTraffic, billing, quotas, nodes, alerts] =
    await Promise.all([
      getSystemStatus(),
      prisma.device.groupBy({ by: ["connectionStatus"], _count: { _all: true } }),
      Promise.resolve(aggregator.hello()),
      queryTraffic({
        preset: "today",
        source: "REAL",
        direction: null,
        deviceId: null,
        nodeId: null,
        userId: null,
        configId: null,
        category: null,
      }),
      queryTraffic({
        preset: "month",
        source: "REAL",
        direction: null,
        deviceId: null,
        nodeId: null,
        userId: null,
        configId: null,
        category: null,
      }),
      getBillingOverview({ source: "REAL" }),
      listQuotas(),
      prisma.vpnNode.findMany({
        orderBy: [{ health: "asc" }, { name: "asc" }],
        take: 8,
        select: {
          id: true,
          nodeId: true,
          name: true,
          health: true,
          activeSessions: true,
          cpuPercent: true,
          ramPercent: true,
          lastHeartbeatAt: true,
        },
      }),
      Promise.all([
        prisma.anomalyEvent.count({ where: { status: "OPEN" } }),
        prisma.notification.count({ where: { readAt: null } }),
      ]),
    ]);

  const byStatus = new Map(counts.map((row) => [row.connectionStatus, row._count._all]));
  const totalDevices = counts.reduce((sum, row) => sum + row._count._all, 0);
  const blockedDevices =
    (byStatus.get("REVOKED") ?? 0) +
    (await prisma.device.count({
      where: { OR: [{ approvalState: "BLOCKED" }, { approvalState: "REJECTED" }] },
    }));

  const [pendingCount] = await Promise.all([
    prisma.device.count({ where: { approvalState: "PENDING" } }),
  ]);

  const enforcement = await getSetting<boolean>("quota.enforcementEnabled");
  const thresholds = await getSetting<number[]>("quota.warnThresholds");

  const monthMeasure = monthTraffic.summary;
  const savingsKind = monthMeasure.savingsKind;
  const optimizedBytesMonth = monthMeasure.optimizedBytes;
  const savedBytesMonth = monthMeasure.savedBytes;
  const savingPct = monthMeasure.savingPct;

  const consumers = await queryConsumers({
    preset: "month",
    dimension: "device",
    limit: 5,
    source: "REAL",
  });

  // Whether ANY row at all has ever been recorded with the REAL flag. The UI needs
  // this to choose between "no data available" and a real (possibly zero) figure.
  const [realSamples, mockSamples] = await Promise.all([
    prisma.trafficAggregate.count({ where: { source: "REAL", bytes: { gt: 0 } } }),
    prisma.trafficAggregate.count({ where: { source: "MOCK", bytes: { gt: 0 } } }),
  ]);

  return {
    system,
    network: {
      activeConnections: tick.activeConnections,
      devicesTotal: totalDevices,
      devicesOnline: byStatus.get("ONLINE") ?? 0,
      devicesPending: pendingCount,
      devicesBlocked: blockedDevices,
      devicesQuotaExceeded: byStatus.get("QUOTA_EXCEEDED") ?? 0,
      uploadBps: tick.uploadBps,
      downloadBps: tick.downloadBps,
      totalBps: tick.totalBps,
      realtimeStatus: tick.status,
    },
    data: {
      usedTodayBytes: today.summary.totalBytes,
      usedMonthBytes: monthTraffic.summary.totalBytes,
      remainingQuotaBytes: systemQuotaRemaining(quotas),
      quotaLimitBytes: systemQuotaLimit(quotas),
      optimizedBytesMonth,
      savedBytesMonth,
      savingPct,
      savingsKind,
      estimatedCostToday: null,
      estimatedCostMonth: billing.totals.computedCost,
      currency: billing.pricing.currency,
    },
    quota: {
      exceededCount: quotas.filter((entry) => entry.state === "QUOTA_EXCEEDED").length,
      warnedCount: quotas.filter(
        (entry) => entry.state === "WARNED_80" || entry.state === "WARNED_90",
      ).length,
      thresholds,
    },
    traffic: {
      granularity: "HOUR",
      series: today.series.map((point) => ({
        t: point.t,
        uploadBytes: point.uploadBytes,
        downloadBytes: point.downloadBytes,
        totalBytes: point.totalBytes,
      })),
    },
    consumers: consumers.items.slice(0, 5).map((item, index) => ({
      rank: index + 1,
      dimension: item.dimension,
      label: item.label,
      bytes: item.bytes,
      sharePct: item.sharePct,
    })),
    recentNodes: nodes.map((node) => ({
      id: node.id,
      nodeId: node.nodeId,
      name: node.name,
      health: node.health,
      activeSessions: node.activeSessions,
      cpuPercent: node.cpuPercent,
      ramPercent: node.ramPercent,
      lastHeartbeatAt: node.lastHeartbeatAt?.getTime() ?? null,
    })),
    alerts: { openAnomalies: alerts[0], unreadNotifications: alerts[1] },
    quotaEnforcementEnabled: enforcement,
    hasRealTraffic: realSamples > 0,
    mockDataPresent: mockSamples > 0,
    generatedAt: Date.now(),
  };
}

function systemQuotaLimit(quotas: Awaited<ReturnType<typeof listQuotas>>): string | null {
  const system = quotas.find((quota) => quota.scope === "SYSTEM");
  return system && system.limitBytes > 0n ? system.limitBytes.toString() : null;
}

function systemQuotaRemaining(quotas: Awaited<ReturnType<typeof listQuotas>>): string | null {
  const system = quotas.find((quota) => quota.scope === "SYSTEM");
  if (!system || system.limitBytes <= 0n) return null;
  return (system.limitBytes - system.usedBytes).toString();
}
