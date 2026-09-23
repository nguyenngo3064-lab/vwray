import "server-only";
import type { VpnNode } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { logger } from "@/server/lib/logger";
import { aggregator } from "@/server/realtime/aggregator";
import { queueSample, startFlusher, type PendingSample } from "@/server/traffic/buffer";
import { recordUsage } from "@/server/quota/engine";
import { getSetting } from "@/server/settings/service";
import { checkHotBucket } from "@/server/auth/rate-limit";

/**
 * Traffic collector: the single entry point for data-plane observations.
 *
 * One ingest call does four things, in this order, because the order is a product
 * decision:
 *
 *   1. RESOLVE  - map credential/public key to a device. Identity is the credential,
 *                 never the source IP (a NAT can share one IP across many devices).
 *   2. ACCOUNT  - feed the realtime aggregator first, so the live chart is never
 *                 blocked by database latency.
 *   3. RECORD   - queue the raw sample for the batched flush (raw rows + aggregates).
 *   4. ENFORCE  - call the quota engine, which may revoke a session and block the
 *                 peer at the gateway inside a transaction.
 *
 * Enforcement comes last on purpose: the byte must be counted before the limit can be
 * evaluated against it, otherwise a device could exceed its quota by one batch and
 * not be stopped until the following one.
 */

export interface IngestSample {
  /** Credential public key (WireGuard public key / Xray UUID) when known. */
  credentialPublicKey?: string | null;
  deviceId?: string | null;
  direction: "UPLOAD" | "DOWNLOAD";
  bytes: number;
  bytesOptimized?: number | null;
  packets?: number | null;
  connections?: number | null;
  hostname?: string | null;
  ip?: string | null;
  category?: string | null;
  ts?: number | null;
}

export interface IngestInput {
  samples: IngestSample[];
  timestamp?: number | null;
}

export interface IngestResult {
  accepted: number;
  unattributed: number;
  /** Samples that arrived for a device the gateway should have blocked. */
  blockedButReported: number;
  uploadBytes: number;
  downloadBytes: number;
  quotaBreaches: number;
  source: "REAL" | "MOCK";
}

/**
 * Development mock gate.
 *
 * Mock traffic is refused in production unconditionally, regardless of settings, and
 * refused outside development unless an operator explicitly opts in. Everything it
 * produces is stored with `source = MOCK`, so it can be filtered out of every query.
 */
export async function resolveIngestSource(node: VpnNode): Promise<"REAL" | "MOCK"> {
  const env = getEnv();
  const isMock = node.adapterKey === "mock" || !node.isRealGateway;

  if (!isMock) return "REAL";

  if (env.isProduction) {
    throw new Error("Mock gateway ingest is refused in production.");
  }

  if (!env.DEV_MOCK_GATEWAY_ENABLED) {
    throw new Error("Mock gateway ingest is disabled (DEV_MOCK_GATEWAY_ENABLED=false).");
  }

  const allowed = await getSetting<boolean>("system.allowDevMockIngest");
  if (!allowed) {
    throw new Error("Mock gateway ingest is disabled (system.allowDevMockIngest=false).");
  }

  logger.warn("ingesting development mock traffic", {
    nodeId: node.nodeId,
    note: "This data is labelled MOCK and never presented as production traffic.",
  });
  return "MOCK";
}

interface ResolvedDevice {
  deviceId: string;
  approvalState: string;
  connectionStatus: string;
  ownerUserId: string | null;
  assignedConfigId: string | null;
  quotaExceededAt: Date | null;
  blockedAt: Date | null;
}

/**
 * Processes one traffic batch from a gateway agent.
 *
 * Unattributable samples (no credential match) are still counted at the system and
 * node level: refusing to record bytes we actually observed would under-report usage
 * and make every derived number wrong. They are simply not attributed to a device.
 */
export async function ingest(
  node: VpnNode,
  input: IngestInput,
): Promise<IngestResult> {
  const source = await resolveIngestSource(node);
  const empty: IngestResult = {
    accepted: 0,
    unattributed: 0,
    blockedButReported: 0,
    uploadBytes: 0,
    downloadBytes: 0,
    quotaBreaches: 0,
    source,
  };

  if (!input.samples || input.samples.length === 0) return empty;

  // Bound ingest per node so one misbehaving agent cannot monopolise the process.
  const hot = checkHotBucket(`ingest:${node.nodeId}`, 120, 60);
  if (!hot.allowed) {
    logger.warn("ingest rate limited", { nodeId: node.nodeId, retryAfter: hot.retryAfterSeconds });
    return empty;
  }

  // 1. RESOLVE identity from credentials. Never from the source IP: a NAT shares one
  //    IP across many devices, and an address changes while an identity must not.
  const keys = Array.from(
    new Set(
      input.samples
        .map((sample) => sample.credentialPublicKey?.trim())
        .filter((key): key is string => Boolean(key)),
    ),
  );

  const credentials = keys.length
    ? await prisma.deviceCredential.findMany({
        where: { publicKey: { in: keys }, revokedAt: null },
        select: {
          publicKey: true,
          device: {
            select: {
              id: true,
              deviceId: true,
              approvalState: true,
              connectionStatus: true,
              ownerUserId: true,
              assignedConfigId: true,
              quotaExceededAt: true,
              blockedAt: true,
            },
          },
        },
      })
    : [];

  const byKey = new Map<string, ResolvedDevice>();
  for (const credential of credentials) {
    const device = credential.device;
    byKey.set(credential.publicKey, {
      deviceId: device.id,
      approvalState: device.approvalState,
      connectionStatus: device.connectionStatus,
      ownerUserId: device.ownerUserId,
      assignedConfigId: device.assignedConfigId,
      quotaExceededAt: device.quotaExceededAt,
      blockedAt: device.blockedAt,
    });
  }

  const perDevice = new Map<
    string,
    {
      upload: bigint;
      download: bigint;
      connections: number;
      userId: string | null;
      configId: string | null;
    }
  >();

  let unattributed = 0;
  let blockedButReported = 0;
  let uploadBytes = 0;
  let downloadBytes = 0;
  let connections = 0;

  const now = new Date();

  // Samples may also carry an explicit device id (some gateway integrations only know
  // that). Resolve those too, so attribution does not depend on which identifier the
  // agent happened to have.
  const explicitIds = Array.from(
    new Set(
      input.samples
        .map((sample) => sample.deviceId?.trim())
        .filter((id): id is string => Boolean(id))
        .filter((id) => !Array.from(byKey.values()).some((device) => device.deviceId === id)),
    ),
  );
  const explicitDevices = explicitIds.length
    ? await prisma.device.findMany({
        where: { id: { in: explicitIds } },
        select: {
          id: true,
          approvalState: true,
          connectionStatus: true,
          ownerUserId: true,
          assignedConfigId: true,
          quotaExceededAt: true,
          blockedAt: true,
        },
      })
    : [];
  const byId = new Map<string, ResolvedDevice>();
  for (const device of explicitDevices) {
    byId.set(device.id, {
      deviceId: device.id,
      approvalState: device.approvalState,
      connectionStatus: device.connectionStatus,
      ownerUserId: device.ownerUserId,
      assignedConfigId: device.assignedConfigId,
      quotaExceededAt: device.quotaExceededAt,
      blockedAt: device.blockedAt,
    });
  }

  // 2 + 3. ACCOUNT and RECORD.
  for (const sample of input.samples) {
    const bytes = Math.max(0, Math.floor(sample.bytes));
    if (bytes === 0) continue;

    const resolved =
      (sample.credentialPublicKey ? byKey.get(sample.credentialPublicKey.trim()) : undefined) ??
      (sample.deviceId ? byId.get(sample.deviceId.trim()) : undefined);

    const isUpload = sample.direction === "UPLOAD";
    if (isUpload) uploadBytes += bytes;
    else downloadBytes += bytes;
    connections += sample.connections ?? 0;

    queueSample({
      ts: sample.ts ? new Date(sample.ts) : now,
      nodeId: node.id,
      deviceId: resolved?.deviceId ?? null,
      userId: resolved?.ownerUserId ?? null,
      configId: resolved?.assignedConfigId ?? null,
      direction: isUpload ? "UPLOAD" : "DOWNLOAD",
      bytes: BigInt(bytes),
      bytesOptimized:
        sample.bytesOptimized === null || sample.bytesOptimized === undefined
          ? null
          : BigInt(Math.max(0, Math.floor(sample.bytesOptimized))),
      packets: sample.packets ?? null,
      connections: sample.connections ?? null,
      domainId: null,
      category: sample.category ?? null,
      source,
    });

    if (!resolved) {
      unattributed += 1;
      continue;
    }

    if (resolved.quotaExceededAt || resolved.blockedAt) {
      // The gateway should not be reporting this peer. The bytes are still counted -
      // usage accounting must stay truthful - but the block is left in force.
      blockedButReported += 1;
      continue;
    }

    const bucket = perDevice.get(resolved.deviceId) ?? {
      upload: 0n,
      download: 0n,
      connections: 0,
      userId: resolved.ownerUserId,
      configId: resolved.assignedConfigId,
    };
    bucket.upload += isUpload ? BigInt(bytes) : 0n;
    bucket.download += isUpload ? 0n : BigInt(bytes);
    bucket.connections = Math.max(bucket.connections, sample.connections ?? 0);
    perDevice.set(resolved.deviceId, bucket);
  }

  // The buffer only becomes durable (and therefore flushable) once something is queued.
  startFlusher();

  // Feed the live chart BEFORE touching the database: a slow write must never make the
  // realtime graph lag behind the data plane.
  aggregator.ingest({
    nodeId: node.id,
    uploadBytes,
    downloadBytes,
    connections,
    sessions: perDevice.size,
    mock: source === "MOCK",
  });

  // Persist device counters and connection state.
  for (const [deviceId, bucket] of perDevice) {
    await prisma.device.update({
      where: { id: deviceId },
      data: {
        uploadBytes: { increment: bucket.upload },
        downloadBytes: { increment: bucket.download },
        lastSeenAt: now,
        connectionStatus: "ONLINE",
      },
    });
  }

  // 4. ENFORCE quotas against the bytes just observed. This may revoke a session and
  //    block the peer at the gateway, in a transaction, before returning.
  let quotaBreaches = 0;
  for (const [deviceId, bucket] of perDevice) {
    const evaluations = await recordUsage({
      deviceId,
      uploadBytes: bucket.upload,
      downloadBytes: bucket.download,
      nodeId: node.id,
      userId: bucket.userId,
      configId: bucket.configId,
    });
    if (evaluations.some((evaluation) => evaluation.state === "QUOTA_EXCEEDED")) {
      quotaBreaches += 1;
    }
  }

  if (blockedButReported > 0) {
    logger.warn("gateway reported traffic for a blocked device", {
      nodeId: node.nodeId,
      count: blockedButReported,
    });
  }

  return {
    accepted: input.samples.length,
    unattributed,
    blockedButReported,
    uploadBytes,
    downloadBytes,
    quotaBreaches,
    source,
  };
}
