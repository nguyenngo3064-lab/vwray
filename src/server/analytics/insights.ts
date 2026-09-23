import "server-only";
import { prisma } from "@/server/db/client";
import { resolveRange } from "@/server/lib/time";

/**
 * Traffic insights.
 *
 * Every sentence is generated from an aggregate that exists right now, and each one
 * carries the evidence that produced it (which row ids, which window, which bytes). If
 * there is no data, there are no insights - the endpoint returns an empty list with a
 * stated reason rather than filler copy.
 *
 * Attribution vocabulary is deliberate: a VPN gateway cannot see application identity,
 * so insights speak about devices, nodes, destinations, domains, protocols and
 * categories - never about "apps".
 */

export interface Insight {
  id: string;
  text: string;
  source: string;
  evidence: Record<string, unknown>;
  severity: "INFO" | "LOW" | "MEDIUM";
}

export interface InsightsResult {
  range: { start: string; end: string; preset: string };
  statements: Insight[];
  available: boolean;
  reason: string | null;
  generatedAt: number;
}

const GB = 1024 ** 3;

function gb(bytes: bigint | number): string {
  return (Number(bytes) / GB).toFixed(2);
}

export async function trafficInsights(preset?: string | null, filters?: {
  deviceId?: string | null;
  nodeId?: string | null;
  userId?: string | null;
  configId?: string | null;
  category?: string | null;
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Promise<InsightsResult> {
  const literal: string = preset ?? "today";
  const resolved = resolveRange({ preset: literal }) ?? resolveRange({ preset: "today" });
  if (resolved === null) {
    return {
      range: { start: "", end: "", preset: "today" },
      statements: [],
      available: false,
      reason: "The requested time range is invalid.",
      generatedAt: Date.now(),
    };
  }
  const range = { start: resolved.start, end: resolved.end, preset: literal };
  const source = filters?.source && filters.source !== "ALL" ? filters.source : null;
  const mockOnly = filters?.source === "MOCK";
  const where = {
    bucketStart: { gte: range.start, lt: range.end },
    ...(source ? { source } : {}),
  };
  const deviceDim = filters?.deviceId ? `device:${filters.deviceId}`
    : filters?.nodeId ? `node:${filters.nodeId}`
    : filters?.userId ? `user:${filters.userId}`
    : filters?.configId ? `config:${filters.configId}`
    : null;

  const [byDevice, byNode, byCategory, byDirection, buckets, realOnly] = await Promise.all([
    deviceDim
      ? prisma.trafficAggregate.groupBy({
          by: ["dimKey"],
          where: { ...where, dimKey: deviceDim },
          _sum: { bytes: true },
          _count: { _all: true },
        })
      : prisma.trafficAggregate.groupBy({
          by: ["dimKey"],
          where: { ...where, dimKey: { startsWith: "device:" } },
          _sum: { bytes: true },
          _count: { _all: true },
        }),
    prisma.trafficAggregate.groupBy({
      by: ["dimKey"],
      where: { ...where, dimKey: { startsWith: "node:" } },
      _sum: { bytes: true },
      _count: { _all: true },
    }),
    prisma.trafficAggregate.groupBy({
      by: ["category"],
      where: {
        ...where,
        ...(filters?.category ? { category: filters.category } : { category: { not: null } }),
      },
      _sum: { bytes: true },
    }),
    prisma.trafficAggregate.groupBy({
      by: ["direction"],
      where: deviceDim ? { bucketStart: where.bucketStart, dimKey: deviceDim } : where,
      _sum: { bytes: true },
    }),
    prisma.trafficAggregate.groupBy({
      by: ["bucketStart"],
      where: deviceDim ? { bucketStart: where.bucketStart, dimKey: deviceDim, granularity: "HOUR" } : { ...where, dimKey: "system", granularity: "HOUR" },
      _sum: { bytes: true },
      _count: { _all: true },
    }),
    prisma.trafficAggregate.count({ where: { bucketStart: where.bucketStart, source: "REAL" } }),
  ]);

  const statements: Insight[] = [];
  const totalBytes = byDirection.reduce((sum, row) => sum + (row._sum.bytes ?? 0n), 0n);

  if (totalBytes === 0n) {
    return {
      range: { start: range.start.toISOString(), end: range.end.toISOString(), preset: range.preset },
      statements: [],
      available: false,
      reason: "No traffic recorded in this period.",
      generatedAt: Date.now(),
    };
  }

  const labelFor = async (dimKey: string): Promise<string> => {
    const [kind, id] = dimKey.split(":");
    if (kind === "device" && id) {
      const device = await prisma.device.findUnique({ where: { id }, select: { displayName: true } });
      return device?.displayName ?? `device ${id.slice(0, 8)}`;
    }
    if (kind === "node" && id) {
      const node = await prisma.vpnNode.findUnique({ where: { id }, select: { name: true } });
      return node?.name ?? `node ${id.slice(0, 8)}`;
    }
    if (kind === "user" && id) {
      const user = await prisma.adminUser.findUnique({ where: { id }, select: { username: true } });
      return user?.username ?? `user ${id.slice(0, 8)}`;
    }
    return dimKey;
  };

  // Top device.
  const topDevice = [...byDevice].sort((a, b) => (b._sum.bytes ?? 0n) > (a._sum.bytes ?? 0n) ? 1 : -1)[0];
  if (topDevice) {
    const label = await labelFor(topDevice.dimKey);
    const bytes = topDevice._sum.bytes ?? 0n;
    statements.push({
      id: "top-device",
      text: `${label} consumed the most data ${preset === "today" ? "today" : "in this period"}: ${gb(bytes)} GB of ${gb(totalBytes)} GB total.`,
      source: `TrafficAggregate dimKey=${topDevice.dimKey}, ${range.start.toISOString()} → ${range.end.toISOString()}`,
      evidence: { dimKey: topDevice.dimKey, bytes: bytes.toString(), totalBytes: totalBytes.toString(), buckets: topDevice._count._all },
      severity: "INFO",
    });
  }

  // Peak hour window.
  const hourRows = [...buckets].filter((row) => (row._sum.bytes ?? 0n) > 0n).sort((a, b) => (b._sum.bytes ?? 0n) > (a._sum.bytes ?? 0n) ? 1 : -1);
  if (hourRows.length > 0) {
    const peak = hourRows[0];
    const peakStart = new Date(peak.bucketStart);
    const peakEnd = new Date(peakStart.getTime() + 3_600_000);
    const fmt = (date: Date) => `${String(date.getUTCHours()).padStart(2, "0")}:00`;
    statements.push({
      id: "peak-hour",
      text: `Traffic peaked between ${fmt(peakStart)}–${fmt(peakEnd)} (UTC): ${gb(peak._sum.bytes ?? 0n)} GB in that hour.`,
      source: `TrafficAggregate granularity=HOUR bucket ${peak.bucketStart.toISOString()}`,
      evidence: { bucketStart: peak.bucketStart.toISOString(), bytes: (peak._sum.bytes ?? 0n).toString() },
      severity: "INFO",
    });
  }

  // Top node.
  const topNode = [...byNode].sort((a, b) => (b._sum.bytes ?? 0n) > (a._sum.bytes ?? 0n) ? 1 : -1)[0];
  if (topNode) {
    const label = await labelFor(topNode.dimKey);
    const bytes = topNode._sum.bytes ?? 0n;
    statements.push({
      id: "top-node",
      text: `${label} currently handles the highest traffic volume: ${gb(bytes)} GB (${((Number(bytes) / Number(totalBytes)) * 100).toFixed(1)}% of the period).`,
      source: `TrafficAggregate dimKey=${topNode.dimKey}`,
      evidence: { dimKey: topNode.dimKey, bytes: bytes.toString(), totalBytes: totalBytes.toString() },
      severity: "INFO",
    });
  }

  // Upload/download split (also the input to the upload-anomaly sense check).
  const upload = byDirection.find((row) => row.direction === "UPLOAD")?._sum.bytes ?? 0n;
  const download = byDirection.find((row) => row.direction === "DOWNLOAD")?._sum.bytes ?? 0n;
  const uploadShare = totalBytes > 0n ? (Number(upload) / Number(totalBytes)) * 100 : 0;
  if (uploadShare >= 60) {
    statements.push({
      id: "upload-heavy",
      text: `Upload accounted for ${uploadShare.toFixed(1)}% of traffic in this period (${gb(upload)} GB up vs ${gb(download)} GB down).`,
      source: "TrafficAggregate grouped by direction",
      evidence: { uploadBytes: upload.toString(), downloadBytes: download.toString(), uploadSharePct: uploadShare },
      severity: "MEDIUM",
    });
  } else {
    statements.push({
      id: "direction-split",
      text: `Traffic split: ${gb(download)} GB download vs ${gb(upload)} GB upload.`,
      source: "TrafficAggregate grouped by direction",
      evidence: { uploadBytes: upload.toString(), downloadBytes: download.toString() },
      severity: "INFO",
    });
  }

  // Top category (destination category, not an application name).
  const topCategory = [...byCategory].sort((a, b) => (b._sum.bytes ?? 0n) > (a._sum.bytes ?? 0n) ? 1 : -1)[0];
  if (topCategory && topCategory.category) {
    statements.push({
      id: "top-category",
      text: `Destination category "${topCategory.category}" carried the most data: ${gb(topCategory._sum.bytes ?? 0n)} GB.`,
      source: "TrafficAggregate grouped by category",
      evidence: { category: topCategory.category, bytes: (topCategory._sum.bytes ?? 0n).toString() },
      severity: "INFO",
    });
  }

  if (!mockOnly && realOnly > 0) {
    statements.push({
      id: "real-only",
      text: "All figures above come from REAL gateway data.",
      source: "TrafficAggregate source=REAL",
      evidence: { realBuckets: realOnly },
      severity: "INFO",
    });
  }

  return {
    range: { start: range.start.toISOString(), end: range.end.toISOString(), preset: range.preset },
    statements,
    available: true,
    reason: null,
    generatedAt: Date.now(),
  };
}
