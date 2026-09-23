import "server-only";
import type { AnomalyStatus, AnomalyType, NotificationSeverity, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";

/**
 * Anomaly QUERY and REVIEW surface.
 *
 * Detection (deciding that something is anomalous) lives in the detector and is owned
 * elsewhere; this module only reads what was detected and records operator reviews.
 * Phrasing stays neutral throughout: an anomaly is an observation to review, never an
 * accusation, and the raw metrics that triggered it are always returned so an operator
 * can judge for themselves.
 */

export interface AnomalyView {
  id: string;
  detectedAt: string;
  type: AnomalyType;
  severity: NotificationSeverity;
  nodeId: string | null;
  nodeLabel: string | null;
  deviceId: string | null;
  deviceLabel: string | null;
  userId: string | null;
  label: string;
  summary: string;
  metrics: Prisma.JsonValue;
  status: AnomalyStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  note: string | null;
}

type AnomalyRow = Prisma.AnomalyEventGetPayload<{
  include: { device: { select: { displayName: true } } };
}>;

/**
 * `AnomalyEvent.nodeId` has no relation to `VpnNode` (the node may be removed while
 * the anomaly is kept as evidence), so labels are resolved by a separate bounded
 * lookup rather than assumed to still exist.
 */
async function nodeLabelsOf(rows: Array<{ nodeId: string | null }>): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.nodeId).filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const nodes = await prisma.vpnNode.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  return new Map(nodes.map((node) => [node.id, node.name]));
}

function toView(row: AnomalyRow, nodeLabel: string | null): AnomalyView {
  return {
    id: row.id,
    detectedAt: row.detectedAt.toISOString(),
    type: row.type,
    severity: row.severity,
    nodeId: row.nodeId,
    nodeLabel,
    deviceId: row.deviceId,
    deviceLabel: row.device?.displayName ?? null,
    userId: row.userId,
    label: row.label,
    summary: row.summary,
    metrics: row.metrics,
    status: row.status,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    note: row.note,
  };
}

const DEVICE_INCLUDE = { device: { select: { displayName: true } } } as const;

export async function listAnomalies(filters?: {
  status?: AnomalyStatus;
  type?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: AnomalyView[]; total: number; open: number }> {
  const typeFilter = filters?.type ? { type: filters.type as AnomalyType } : {};
  const where: Prisma.AnomalyEventWhereInput = {
    ...(filters?.status ? { status: filters.status } : {}),
    ...typeFilter,
  };
  const limit = Math.max(1, Math.min(Math.floor(filters?.limit ?? 50), 200));
  const offset = Math.max(0, Math.floor(filters?.offset ?? 0));

  const [rows, total, open] = await Promise.all([
    prisma.anomalyEvent.findMany({
      where,
      orderBy: { detectedAt: "desc" },
      take: limit,
      skip: offset,
      include: DEVICE_INCLUDE,
    }),
    prisma.anomalyEvent.count({ where }),
    prisma.anomalyEvent.count({ where: { ...typeFilter, status: "OPEN" } }),
  ]);

  const nodes = await nodeLabelsOf(rows);
  return {
    items: rows.map((row) => toView(row, row.nodeId ? (nodes.get(row.nodeId) ?? null) : null)),
    total,
    open,
  };
}

/** Records an operator's review decision. Audits `security.anomaly_reviewed`. */
export async function reviewAnomaly(input: {
  id: string;
  status: "REVIEWED" | "DISMISSED";
  note?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<AnomalyView> {
  const existing = await prisma.anomalyEvent.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Anomaly");

  const updated = await prisma.anomalyEvent.update({
    where: { id: input.id },
    data: {
      status: input.status,
      reviewedBy: input.actorId,
      reviewedAt: new Date(),
      note: input.note ?? null,
    },
    include: DEVICE_INCLUDE,
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.anomaly_reviewed",
    resource: "anomaly",
    resourceId: updated.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    metadata: {
      type: updated.type,
      severity: updated.severity,
      previousStatus: existing.status,
      status: updated.status,
      note: input.note ?? null,
    },
  });

  const nodes = await nodeLabelsOf([updated]);
  return toView(updated, updated.nodeId ? (nodes.get(updated.nodeId) ?? null) : null);
}
