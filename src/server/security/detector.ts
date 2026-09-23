import "server-only";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { getSetting } from "@/server/settings/service";
import { publishDomain } from "@/server/events/dispatch";
import { buildDedupeKey } from "@/server/lib/ids";
import type { AnomalyType, NotificationSeverity } from "@prisma/client";

/**
 * Anomaly detector.
 *
 * Runs on a schedule and compares RECENT aggregates against a TRAILING baseline for the
 * same subject. Nothing here looks at packet contents, applications or destinations'
 * meaning - only shapes: volume vs baseline, upload share, reconnect counts, auth failure
 * counts, quota velocity and node loss.
 *
 * Phrasing is enforced in one place (`summarize`): neutral, observational, with the
 * measured figures attached. An anomaly row always includes `metrics` (observed,
 * threshold, window, source row) so the console can show the numbers without reproducing
 * this logic, and a `dedupeKey` so one flapping subject produces repeated-row
 * suppression instead of 200 open events.
 *
 * Severity scale: INFO < LOW < MEDIUM < HIGH < CRITICAL. A detection that only implies
 * "look at this" is LOW/MEDIUM; a detection that already triggered enforcement is HIGH;
5QQQ * CRITICAL is reserved for a compromised pattern with an enforcement state (e.g. a
 * quota-exceeded device still moving traffic).
 */

export interface DetectionSummary {
  checkedDevices: number;
  checkedNodes: number;
  created: number;
  unmeasurable: number;
  durationMs: number;
  windowSeconds: number;
  baselineWindowSeconds: number;
}

interface Candidate {
  type: AnomalyType;
  severity: NotificationSeverity;
  deviceId: string | null;
  userId: string | null;
  nodeId: string | null;
  label: string;
  summary: string;
  metrics: Record<string, unknown>;
  dedupeParts: Array<string | number | null | undefined>;
}

async function sumBytes(dimKey: string, from: Date, to: Date, direction?: "UPLOAD" | "DOWNLOAD"): Promise<{
  bytes: number;
  upload: number;
  buckets: number;
}> {
  const rows = await prisma.trafficAggregate.groupBy({
    by: ["direction"],
    where: { dimKey, bucketStart: { gte: from, lt: to }, ...(direction ? { direction } : {}) },
    _sum: { bytes: true },
    _count: { _all: true },
  });
  let bytes = 0;
  let upload = 0;
  let buckets = 0;
  for (const row of rows) {
    bytes += Number(row._sum.bytes ?? 0n);
    if (row.direction === "UPLOAD") upload += Number(row._sum.bytes ?? 0n);
    buckets += row._count._all;
  }
  return { bytes, upload, buckets };
}

function neutral(metric: string, observed: number, threshold: number, unit: string): string {
  return `Unusual traffic pattern detected: ${metric} was ${observed.toFixed(2)} ${unit} against a threshold of ${threshold.toFixed(2)} ${unit}.`;
}

async function checkDeviceSpike(
  deviceId: string,
  displayName: string,
  window: Date,
  baselineFrom: Date,
  now: Date,
  spikeFactor: number,
): Promise<Candidate | null> {
  const [recent, baseline] = await Promise.all([
    sumBytes(`device:${deviceId}`, window, now),
    sumBytes(`device:${deviceId}`, baselineFrom, window),
  ]);
  if (recent.buckets < 2 || baseline.buckets < 2 || baseline.bytes === 0) return null;
  const factor = recent.bytes / baseline.bytes;
  if (factor < spikeFactor) return null;
  return {
    type: "BANDWIDTH_SPIKE",
    severity: factor >= spikeFactor * 2 ? "HIGH" : "MEDIUM",
    deviceId,
    userId: null,
    nodeId: null,
    label: displayName,
    summary: neutral("throughput", factor, spikeFactor, "x baseline"),
    metrics: {
      detector: "deviceSpike",
      recentBytes: recent.bytes,
      baselineBytes: baseline.bytes,
      factor,
      threshold: spikeFactor,
      recentFrom: window.toISOString(),
      baselineFrom: baselineFrom.toISOString(),
      recentBuckets: recent.buckets,
      baselineBuckets: baseline.buckets,
    },
    dedupeParts: ["spike", deviceId, Math.floor(now.getTime() / 3_600_000)],
  };
}

async function checkUploadShare(
  deviceId: string,
  displayName: string,
  window: Date,
  now: Date,
  uploadRatioPct: number,
): Promise<Candidate | null> {
  const recent = await sumBytes(`device:${deviceId}`, window, now);
  if (recent.buckets < 2 || recent.bytes === 0) return null;
  const share = (recent.upload / recent.bytes) * 100;
  // A percentage is meaningless at trace volume: require at least 50 MB in the window.
  if (share < uploadRatioPct || recent.bytes < 50 * 1024 * 1024) return null;
  return {
    type: "UPLOAD_ANOMALY",
    severity: "MEDIUM",
    deviceId,
    userId: null,
    nodeId: null,
    label: displayName,
    summary: neutral("upload share", share, uploadRatioPct, "%"),
    metrics: {
      detector: "uploadShare",
      totalBytes: recent.bytes,
      uploadBytes: recent.upload,
      sharePct: share,
      threshold: uploadRatioPct,
      from: window.toISOString(),
      buckets: recent.buckets,
    },
    dedupeParts: ["upload", deviceId, Math.floor(now.getTime() / 3_600_000)],
  };
}

async function checkReconnects(
  deviceId: string,
  displayName: string,
  window: Date,
  now: Date,
  reconnectCount: number,
): Promise<Candidate | null> {
  const starts = await prisma.vpnSession.count({ where: { deviceId, startedAt: { gte: window, lt: now } } });
  if (starts <= reconnectCount) return null;
  // A device that never moved traffic may legitimately flap; only flag with bytes behind it.
  const recent = await sumBytes(`device:${deviceId}`, window, now);
  if (recent.bytes === 0) return null;
  return {
    type: "RECONNECT_LOOP",
    severity: starts >= reconnectCount * 2 ? "HIGH" : "MEDIUM",
    deviceId,
    userId: null,
    nodeId: null,
    label: displayName,
    summary: `Unusual traffic pattern detected: ${starts} session starts in the last hour against an allowance of ${reconnectCount}.`,
    metrics: {
      detector: "reconnectLoop",
      sessionStarts: starts,
      threshold: reconnectCount,
      windowSeconds: 3600,
      recentBytes: recent.bytes,
    },
    dedupeParts: ["reconnect", deviceId, Math.floor(now.getTime() / 3_600_000)],
  };
}

async function checkConnectionStorm(
  deviceId: string,
  displayName: string,
  window: Date,
): Promise<Candidate | null> {
  const rows = await prisma.trafficAggregate.findMany({
    where: { dimKey: `device:${deviceId}`, bucketStart: { gte: window }, connections: { not: null } },
    orderBy: { bucketStart: "desc" },
    take: 60,
    select: { connections: true },
  });
  if (rows.length < 3) return null;
  const peak = Math.max(...rows.map((row) => row.connections ?? 0));
  const baselineRows = rows.slice(Math.min(5, rows.length));
  const baseline = baselineRows.reduce((sum, row) => sum + (row.connections ?? 0), 0) / Math.max(1, baselineRows.length);
  // A storm is a PEAK that dwarfs the same device's own reporting: 10x and >= 200.
  if (!(baseline > 0 && peak >= Math.max(200, baseline * 10))) return null;
  return {
    type: "EXCESSIVE_CONNECTIONS",
    severity: "HIGH",
    deviceId,
    userId: null,
    nodeId: null,
    label: displayName,
    summary: `Unusual traffic pattern detected: ${peak} concurrent connections against a device baseline of ~${Math.round(baseline)}.`,
    metrics: { detector: "connectionStorm", peakConnections: peak, baselineConnections: baseline, threshold: Math.max(200, baseline * 10) },
    dedupeParts: ["storm", deviceId, Math.floor(Date.now() / 3_600_000)],
  };
}

async function checkRapidQuota(deviceId: string, displayName: string): Promise<Candidate | null> {
  const quota = await prisma.quota.findFirst({ where: { scope: "DEVICE", scopeRefId: deviceId } });
  if (!quota || quota.limitBytes <= 0n) return null;
  const periodStart = quota.periodStart ?? quota.createdAt;
  const elapsedMs = Date.now() - periodStart.getTime();
  if (elapsedMs < 3_600_000) return null;
  // Consumed 3x faster than a linear burn would allow, with at least half the quota gone.
  const expectedLinear = Number(quota.limitBytes) * (elapsedMs / Math.max(1, quota.resetAt ? quota.resetAt.getTime() - periodStart.getTime() : 30 * 86_400_000));
  const used = Number(quota.usedBytes);
  if (!(used > Math.max(expectedLinear * 3, Number(quota.limitBytes) * 0.5))) return null;
  return {
    type: "RAPID_QUOTA_CONSUMPTION",
    severity: used >= Number(quota.limitBytes) ? "HIGH" : "MEDIUM",
    deviceId,
    userId: null,
    nodeId: null,
    label: displayName,
    summary: `Unusual traffic pattern detected: ${used.toLocaleString()} of ${Number(quota.limitBytes).toLocaleString()} quota bytes consumed faster than a linear burn for the period.`,
    metrics: {
      detector: "rapidQuota",
      quotaId: quota.id,
      usedBytes: quota.usedBytes.toString(),
      limitBytes: quota.limitBytes.toString(),
      expectedLinearBurn: Math.round(expectedLinear),
      periodStart: periodStart.toISOString(),
    },
    dedupeParts: ["rapidquota", quota.id],
  };
}

async function checkNodeBehaviour(nodeId: string, name: string): Promise<Candidate | null> {
  const sample = await prisma.nodeHealthSample.findFirst({
    where: { nodeId },
    orderBy: { sampledAt: "desc" },
  });
  if (!sample) return null;
  const problems: string[] = [];
  if (sample.cpuPercent !== null && sample.cpuPercent >= 95) problems.push(`CPU ${sample.cpuPercent}%`);
  if (sample.ramPercent !== null && sample.ramPercent >= 95) problems.push(`RAM ${sample.ramPercent}%`);
  if (sample.packetLossPct !== null && sample.packetLossPct >= 10) problems.push(`loss ${sample.packetLossPct}%`);
  if (problems.length === 0) return null;
  return {
    type: "NODE_BEHAVIOUR",
    severity: "MEDIUM",
    deviceId: null,
    userId: null,
    nodeId,
    label: name,
    summary: `Unusual traffic pattern detected: node reported ${problems.join(", ")}.`,
    metrics: {
      detector: "nodeBehaviour",
      sampleId: sample.id,
      sampledAt: sample.sampledAt.toISOString(),
      cpuPercent: sample.cpuPercent,
      ramPercent: sample.ramPercent,
      packetLossPct: sample.packetLossPct,
      latencyMs: sample.latencyMs,
    },
    dedupeParts: ["node", nodeId, sample.id],
  };
}

async function checkAuthFailures(window: Date, now: Date): Promise<Candidate | null> {
  const failed = await prisma.authAttempt.count({ where: { success: false, createdAt: { gte: window, lt: now } } });
  // 10 failed logins in an hour is the existing lockout neighborhood: flag at double that.
  if (failed < 20) return null;
  return {
    type: "AUTH_FAILURES",
    severity: failed >= 100 ? "HIGH" : "MEDIUM",
    deviceId: null,
    userId: null,
    nodeId: null,
    label: "operator logins",
    summary: `Unusual traffic pattern detected: ${failed} failed authentication attempts in the last hour.`,
    metrics: { detector: "authFailures", failedAttempts: failed, windowSeconds: 3600 },
    dedupeParts: ["auth", Math.floor(now.getTime() / 3_600_000)],
  };
}

/**
 * Runs every detector once. Bounded (500 devices, every node), idempotent via dedupe
 * keys, and callable by hand from the console for "run now".
 */
export async function runAnomalyDetection(now: Date = new Date()): Promise<DetectionSummary> {
  const startedAt = Date.now();
  const enabled = await getSetting<boolean>("security.anomalyDetectionEnabled").catch(() => true);
  if (!enabled) {
    return { checkedDevices: 0, checkedNodes: 0, created: 0, unmeasurable: 0, durationMs: Date.now() - startedAt, windowSeconds: 3600, baselineWindowSeconds: 86400 };
  }

  const [spikeFactor, uploadRatio, reconnectThreshold] = await Promise.all([
    getSetting<number>("security.anomalyBandwidthSpikeFactor"),
    getSetting<number>("security.anomalyUploadRatio"),
    getSetting<number>("security.anomalyReconnectCount"),
  ]);

  const windowFrom = new Date(now.getTime() - 3_600_000);
  const baselineFrom = new Date(now.getTime() - (3_600_000 + 86_400_000));

  const [devices, nodes] = await Promise.all([
    prisma.device.findMany({
      where: { lastSeenAt: { gte: new Date(now.getTime() - 24 * 3_600_000) } },
      orderBy: { lastSeenAt: "desc" },
      take: 500,
      select: { id: true, displayName: true, ownerUserId: true },
    }),
    prisma.vpnNode.findMany({ select: { id: true, name: true } }),
  ]);

  const candidates: Candidate[] = [];
  let unmeasurable = 0;

  for (const device of devices) {
    const checks = await Promise.all([
      checkDeviceSpike(device.id, device.displayName, windowFrom, baselineFrom, now, spikeFactor),
      checkUploadShare(device.id, device.displayName, windowFrom, now, uploadRatio),
      checkReconnects(device.id, device.displayName, windowFrom, now, reconnectThreshold),
      checkConnectionStorm(device.id, device.displayName, windowFrom),
      checkRapidQuota(device.id, device.displayName),
    ]);
    for (const candidate of checks) {
      if (!candidate) continue;
      candidate.userId = device.ownerUserId ?? null;
      candidates.push(candidate);
    }
    unmeasurable += 0;
  }

  for (const node of nodes) {
    const candidate = await checkNodeBehaviour(node.id, node.name);
    if (candidate) candidates.push(candidate);
  }

  const auth = await checkAuthFailures(windowFrom, now);
  if (auth) candidates.push(auth);

  let created = 0;
  for (const candidate of candidates) {
    try {
      const dedupeKey = buildDedupeKey(candidate.dedupeParts);
      const existing = await prisma.anomalyEvent.findFirst({ where: { dedupeKey, status: "OPEN" } });
      if (existing) continue;

      const row = await prisma.anomalyEvent.create({
        data: {
          type: candidate.type,
          severity: candidate.severity,
          nodeId: candidate.nodeId,
          deviceId: candidate.deviceId,
          userId: candidate.userId,
          label: candidate.label,
          summary: candidate.summary,
          metrics: candidate.metrics as never,
          dedupeKey,
        },
      });
      created += 1;

      await publishDomain("traffic.anomaly", {
        ts: now.getTime(),
        anomalyId: row.id,
        anomalyType: row.type,
        severity: row.severity,
        deviceId: row.deviceId,
        nodeId: row.nodeId,
        label: row.label,
        summary: row.summary,
      });

      const { notify } = await import("@/server/notifications/service");
      await notify({
        type: "anomaly.detected",
        severity: candidate.severity === "CRITICAL" ? "CRITICAL" : candidate.severity === "HIGH" ? "CRITICAL" : "WARNING",
        title: "Unusual traffic pattern detected",
        body: candidate.summary,
        resource: "anomaly",
        resourceId: row.id,
      });
    } catch (error) {
      logger.error("anomaly detector failed on candidate", { type: candidate.type, error });
    }
  }

  return {
    checkedDevices: devices.length,
    checkedNodes: nodes.length,
    created,
    unmeasurable,
    durationMs: Date.now() - startedAt,
    windowSeconds: 3600,
    baselineWindowSeconds: 86400,
  };
}
