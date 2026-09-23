import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { generateDeviceId } from "@/server/lib/ids";
import { record } from "@/server/audit";
import { getSetting } from "@/server/settings/service";
import { gigabytesToBytes } from "@/lib/format/units";

/**
 * Device lifecycle service.
 *
 * State machine for approval:
 *   PENDING -> APPROVED -> BLOCKED (operator) or QUOTA_EXCEEDED (engine)
 *   PENDING -> REJECTED
 *   any     -> APPROVED (via approve), BLOCKED (via block), PENDING (re-review)
 *
 * Rejected and pending devices get the generic client-safe response and never an
 * active credential - enforced here by refusing to create or assign configurations
 * to anything that is not APPROVED.
 */

export function isDeviceBlocked(device: {
  approvalState: string;
  connectionStatus: string;
  quotaExceededAt: Date | null;
  blockedAt: Date | null;
}): boolean {
  return (
    device.approvalState === "BLOCKED" ||
    device.approvalState === "REJECTED" ||
    device.connectionStatus === "QUOTA_EXCEEDED" ||
    device.approvalState === "PENDING" ||
    device.blockedAt !== null ||
    device.quotaExceededAt !== null
  );
}

/** Public shapes never include secrets, sealed payloads or hashes. */
function toDeviceView(device: {
  id: string;
  deviceId: string;
  displayName: string;
  client: string;
  platform: string;
  publicSourceIp: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date | null;
  connectionStatus: string;
  approvalState: string;
  securityState: string;
  uploadBytes: bigint;
  downloadBytes: bigint;
  quotaExceededAt: Date | null;
  blockedAt: Date | null;
  blockedReason: string | null;
  assignedNodeId: string | null;
  assignedConfigId: string | null;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLossPct: number | null;
  qualityScore: number | null;
  reconnectCount: number;
  createdAt: Date;
  updatedAt: Date;
  approvalNote: string | null;
  assignedNode?: { nodeId: string; name: string } | null;
}) {
  return {
    ...device,
    uploadBytes: device.uploadBytes.toString(),
    downloadBytes: device.downloadBytes.toString(),
    totalBytes: (device.uploadBytes + device.downloadBytes).toString(),
    blocked: isDeviceBlocked(device),
  };
}

export async function listDevices(filters?: {
  approvalState?: string;
  connectionStatus?: string;
  nodeId?: string;
  search?: string;
  skip?: number;
  take?: number;
}) {
  const where = {
    ...(filters?.approvalState ? { approvalState: filters.approvalState as never } : {}),
    ...(filters?.connectionStatus ? { connectionStatus: filters.connectionStatus as never } : {}),
    ...(filters?.nodeId ? { assignedNodeId: filters.nodeId } : {}),
    ...(filters?.search
      ? {
          OR: [
            { displayName: { contains: filters.search, mode: "insensitive" as const } },
            { deviceId: { contains: filters.search, mode: "insensitive" as const } },
            { client: { contains: filters.search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.device.findMany({
      where,
      orderBy: { lastSeenAt: "desc" },
      skip: filters?.skip ?? 0,
      take: Math.min(filters?.take ?? 25, 100),
      include: { assignedNode: { select: { nodeId: true, name: true } } },
    }),
    prisma.device.count({ where }),
  ]);

  return { items: rows.map(toDeviceView), total };
}

export async function getDevice(id: string) {
  const device = await prisma.device.findUnique({
    where: { id },
    include: {
      assignedNode: { select: { nodeId: true, name: true, protocol: true } },
      optimizationProfile: { select: { id: true, key: true, name: true } },
      quotas: true,
      enforcement: true,
      credentials: {
        where: { revokedAt: null },
        select: {
          id: true,
          kind: true,
          fingerprint: true,
          createdAt: true,
          expiresAt: true,
        },
      },
      sessions: { orderBy: { startedAt: "desc" }, take: 10 },
    },
  });
  if (!device) throw errors.notFound("Device");

  const sessions = device.sessions.map((session) => ({
    ...session,
    bytesUp: session.bytesUp.toString(),
    bytesDown: session.bytesDown.toString(),
  }));
  const quotas = device.quotas.map((quota) => ({
    ...quota,
    limitBytes: quota.limitBytes.toString(),
    usedBytes: quota.usedBytes.toString(),
    graceBytes: quota.graceBytes.toString(),
  }));

  return { ...toDeviceView(device), sessions, quotas, credentials: device.credentials };
}

/**
 * Registers a device. In PRIVATE MODE (the default) the device starts PENDING and
 * nothing else happens until an operator approves it. Outside private mode an
 * already-trusted device may start APPROVED, which is still an explicit decision.
 */
export async function registerDevice(input: {
  displayName: string;
  client: string;
  platform: string;
  presentedPublicKey?: string | null;
  publicSourceIp?: string | null;
}) {
  const privateMode = await getSetting<boolean>("auth.privateMode");
  const defaultProfileKey = await getSetting<string>("optimization.defaultProfileKey");

  const profile = await prisma.optimizationProfile.findUnique({
    where: { key: defaultProfileKey as never },
    select: { id: true },
  });

  const device = await prisma.device.create({
    data: {
      deviceId: generateDeviceId(),
      displayName: input.displayName.slice(0, 80),
      client: input.client.slice(0, 60),
      platform: input.platform.slice(0, 60),
      publicSourceIp: input.publicSourceIp?.slice(0, 64) ?? null,
      approvalState: privateMode ? "PENDING" : "APPROVED",
      connectionStatus: "OFFLINE",
      optimizationProfileId: profile?.id ?? null,
    },
  });

  await record({
    actor: { type: "SYSTEM", id: null, label: "device-registration" },
    action: "device.created",
    resource: "device",
    resourceId: device.id,
    result: "SUCCESS",
    sourceIp: input.publicSourceIp,
    metadata: {
      displayName: device.displayName,
      client: device.client,
      platform: device.platform,
      approvalState: device.approvalState,
    },
  });

  return { id: device.id, deviceId: device.deviceId, approvalState: device.approvalState };
}

export async function approveDevice(input: {
  deviceId: string;
  note?: string | null;
  nodeId?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");
  if (device.approvalState === "APPROVED") return { id: device.id, approvalState: device.approvalState };

  const defaultQuotaGb = await getSetting<number>("quota.defaultDeviceQuotaGb");

  const updated = await prisma.$transaction(async (tx) => {
    const approved = await tx.device.update({
      where: { id: device.id },
      data: {
        approvalState: "APPROVED",
        approvalNote: input.note?.slice(0, 300) ?? null,
        approvedById: input.actorId,
        approvedAt: new Date(),
        assignedNodeId: input.nodeId ?? device.assignedNodeId,
        connectionStatus: device.connectionStatus === "OFFLINE" ? "OFFLINE" : device.connectionStatus,
      },
    });

    // A newly approved device gets the configured default quota automatically, unless
    // the operator set "no quota" (0) or a quota already exists for it.
    if (defaultQuotaGb > 0) {
      const existing = await tx.quota.findFirst({
        where: { scope: "DEVICE", scopeRefId: device.id },
      });
      if (!existing) {
        await tx.quota.create({
          data: {
            scope: "DEVICE",
            scopeRefId: device.id,
            label: `Device quota for ${device.displayName}`,
            limitBytes: gigabytesToBytes(defaultQuotaGb),
            period: "MONTHLY",
            resetPolicy: "AUTO",
            deviceId: device.id,
          },
        });
      }
    }

    return approved;
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "device.approved",
    resource: "device",
    resourceId: device.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { nodeId: updated.assignedNodeId },
  });

  await notifyDeviceApproved(device.id, device.displayName);
  return { id: updated.id, approvalState: updated.approvalState };
}

async function notifyDeviceApproved(deviceId: string, displayName: string) {
  const { notify } = await import("@/server/notifications/service");
  await notify({
    type: "device.approved",
    severity: "INFO",
    title: "Device approved",
    body: `${displayName} was approved and may now receive a configuration.`,
    resource: "device",
    resourceId: deviceId,
  });
}

export async function rejectDevice(input: {
  deviceId: string;
  note?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");

  await prisma.device.update({
    where: { id: device.id },
    data: { approvalState: "REJECTED", approvalNote: input.note?.slice(0, 300) ?? null },
  });

  // The operator may know why; the rejected device only ever hears the generic line.
  const rejectMessage = await getSetting<string>("auth.rejectMessage");

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "device.rejected",
    resource: "device",
    resourceId: device.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { internalNote: input.note ?? null },
  });

  return { id: device.id, approvalState: "REJECTED", clientMessage: rejectMessage };
}

/**
 * Blocks a device, revoking its live sessions and flipping the gateway policy so the
 * data plane refuses its handshake. Sessions are closed immediately server-side; the
 * policy row makes the gateway do the same.
 */
export async function blockDevice(input: {
  deviceId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");

  const now = new Date();
  const reason = input.reason.slice(0, 300);

  await prisma.$transaction(async (tx) => {
    await tx.device.update({
      where: { id: device.id },
      data: { approvalState: "BLOCKED", blockedAt: now, blockedReason: reason },
    });

    await tx.vpnSession.updateMany({
      where: { deviceId: device.id, endedAt: null },
      data: { endedAt: now, endReason: "REVOKED" },
    });

    const existing = await tx.gatewayPolicyState.findFirst({
      where: { deviceId: device.id, nodeId: device.assignedNodeId },
      orderBy: { revision: "desc" },
    });
    const policyState = { state: "BLOCKED" as const, reason, revision: (existing?.revision ?? 0) + 1 };
    if (existing) {
      await tx.gatewayPolicyState.update({
        where: { id: existing.id },
        data: { ...policyState, appliedAt: null, ackedAt: null },
      });
    } else {
      await tx.gatewayPolicyState.create({
        data: { deviceId: device.id, nodeId: device.assignedNodeId, ...policyState },
      });
    }

    const { recordWithin, userActor } = await import("@/server/audit");
    await recordWithin(tx, {
      actor: userActor(input.actorId, input.actorLabel),
      action: "device.blocked",
      resource: "device",
      resourceId: device.id,
      result: "SUCCESS",
      sourceIp: input.sourceIp,
      metadata: { reason, sessionsRevoked: true },
    });
  });

  return { id: device.id, approvalState: "BLOCKED" };
}

/** Closes live sessions and revokes credentials for a device. */
export async function disconnectDevice(input: {
  deviceId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");

  const now = new Date();

  const closed = await prisma.vpnSession.updateMany({
    where: { deviceId: device.id, endedAt: null },
    data: { endedAt: now, endReason: input.reason.includes("quota") ? "QUOTA_EXCEEDED" : "REVOKED" },
  });

  await prisma.device.update({
    where: { id: device.id },
    data: { connectionStatus: "OFFLINE" },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "device.disconnected",
    resource: "device",
    resourceId: device.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { reason: input.reason, sessionsClosed: closed.count },
  });

  return { id: device.id, sessionsClosed: closed.count };
}

export async function updateDevice(input: {
  deviceId: string;
  displayName?: string;
  optimizationProfileId?: string | null;
  assignedNodeId?: string | null;
  securityState?: "NORMAL" | "REVIEW" | "LOCKED";
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}) {
  const device = await prisma.device.findUnique({ where: { id: input.deviceId } });
  if (!device) throw errors.notFound("Device");

  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      ...(input.displayName !== undefined ? { displayName: input.displayName.slice(0, 80) } : {}),
      ...(input.optimizationProfileId !== undefined
        ? { optimizationProfileId: input.optimizationProfileId }
        : {}),
      ...(input.assignedNodeId !== undefined ? { assignedNodeId: input.assignedNodeId } : {}),
      ...(input.securityState !== undefined ? { securityState: input.securityState } : {}),
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "device.updated",
    resource: "device",
    resourceId: device.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
  });

  return { id: updated.id };
}

/** Counts used by the dashboard device strip. Mock-free: counts real rows only where asked. */
export async function deviceCounts(source?: "REAL" | "MOCK") {
  const where = source ? { samples: { some: { source } } } : {};
  const [total, online, pending, blocked, quotaExceeded] = await Promise.all([
    prisma.device.count({ where }),
    prisma.device.count({ where: { ...where, connectionStatus: "ONLINE" } }),
    prisma.device.count({ where: { ...where, approvalState: "PENDING" } }),
    prisma.device.count({
      where: { ...where, OR: [{ approvalState: "BLOCKED" }, { approvalState: "REJECTED" }] },
    }),
    prisma.device.count({ where: { ...where, connectionStatus: "QUOTA_EXCEEDED" } }),
  ]);
  return { total, online, pending, blocked, quotaExceeded };
}
