import "server-only";
import type { ConnectionEventType, NotificationSeverity, Prisma, TimelineActor } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { buildDedupeKey } from "@/server/lib/ids";

/**
 * Connection timeline.
 *
 * Every meaningful thing that happens to a device or a node is written here as a fact:
 * when, what, on which node, how much traffic, why, and who or what caused it. The
 * console reads this table for the per-device timeline, the global search and the
 * explainability view, so an operator never has to trust a prose summary that was
 * generated somewhere else.
 *
 * Two properties matter:
 *
 *   1. **Nothing is narrated.** `reason` is filled from data the platform observed
 *      (a quota figure, an end reason reported by the gateway, a health transition).
 *      When the platform does not know why, the field stays null and the UI says so.
 *   2. **Repetition is collapsed, not hidden.** A flapping reconnect produces ONE row
 *      with `repeatCount` incremented, because a timeline with 900 identical rows is as
 *      useless as one with none.
 *
 * Writing a timeline row never fails the business operation that triggered it: a lost
 * timeline entry is logged, but a rejected traffic batch or a rolled-back quota
 * enforcement would be worse.
 */

export interface TimelineEventInput {
  type: ConnectionEventType;
  ts?: Date;
  deviceId?: string | null;
  userId?: string | null;
  nodeId?: string | null;
  sessionId?: string | null;
  bytesUp?: bigint | null;
  bytesDown?: bigint | null;
  reason?: string | null;
  actor?: TimelineActor;
  actorId?: string | null;
  actorLabel?: string | null;
  severity?: NotificationSeverity;
  metadata?: Record<string, unknown>;
  /**
   * When provided, an identical open event is incremented instead of duplicated. Callers
   * pass a stable tuple (type + subject + reason class), never a timestamp, so the same
   * real-world situation collapses and a genuinely new one does not.
   */
  dedupeParts?: Array<string | number | null | undefined>;
}

function jsonOrNull(value: Record<string, unknown> | undefined): Prisma.InputJsonValue | undefined {
  if (!value) return undefined;
  // Reuse the audit redactor's philosophy: never persist a sealed secret or a hash
  // through a side door. Timeline metadata is ids, counts and measurements only.
  const json = JSON.stringify(value, (_key, entry) => {
    if (typeof entry === "string" && (/^v1:[A-Za-z0-9_-]+:/.test(entry) || entry.startsWith("scrypt$"))) {
      return "[redacted]";
    }
    if (typeof entry === "bigint") return entry.toString();
    return entry;
  });
  return JSON.parse(json) as Prisma.InputJsonValue;
}

export async function recordTimelineEvent(input: TimelineEventInput): Promise<void> {
  const ts = input.ts ?? new Date();
  const dedupeKey = input.dedupeParts ? buildDedupeKey([input.type, ...input.dedupeParts]) : null;

  const data = {
    type: input.type,
    ts,
    deviceId: input.deviceId ?? null,
    userId: input.userId ?? null,
    nodeId: input.nodeId ?? null,
    sessionId: input.sessionId ?? null,
    bytesUp: input.bytesUp ?? null,
    bytesDown: input.bytesDown ?? null,
    reason: input.reason ?? null,
    actor: input.actor ?? ("SYSTEM" as TimelineActor),
    actorId: input.actorId ?? null,
    actorLabel: input.actorLabel ?? null,
    severity: input.severity ?? ("INFO" as NotificationSeverity),
    metadata: jsonOrNull(input.metadata),
  };

  try {
    if (dedupeKey) {
      await prisma.connectionEvent.upsert({
        where: { dedupeKey },
        create: { ...data, dedupeKey },
        // The newest occurrence wins for timestamp/reason, and the count is preserved.
        update: { ts, reason: data.reason, metadata: data.metadata, repeatCount: { increment: 1 } },
      });
      return;
    }
    await prisma.connectionEvent.create({ data });
  } catch (error) {
    logger.error("timeline write failed", { type: input.type, deviceId: input.deviceId, error });
  }
}

export interface TimelineQuery {
  deviceId?: string | null;
  nodeId?: string | null;
  userId?: string | null;
  types?: ConnectionEventType[] | null;
  actor?: TimelineActor | null;
  severity?: NotificationSeverity | null;
  from?: Date | null;
  to?: Date | null;
  /** Free text matched against reason, actor label and the human type name. */
  search?: string | null;
  page: number;
  pageSize: number;
  order?: "asc" | "desc";
}

export interface TimelineEntry {
  id: string;
  ts: string;
  type: ConnectionEventType;
  typeLabel: string;
  deviceId: string | null;
  deviceLabel: string | null;
  nodeId: string | null;
  nodeLabel: string | null;
  userId: string | null;
  sessionId: string | null;
  bytesUp: string | null;
  bytesDown: string | null;
  reason: string | null;
  actor: TimelineActor;
  actorLabel: string | null;
  severity: NotificationSeverity;
  metadata: unknown;
  repeatCount: number;
}

/** Turns `DEVICE_CONNECTED` into `Device connected`. Kept in one place for search + UI. */
export function timelineTypeLabel(type: string): string {
  const words = type.split("_");
  return words.map((word, index) => (index === 0 ? word.charAt(0) + word.slice(1).toLowerCase() : word.toLowerCase())).join(" ");
}

export async function listTimeline(query: TimelineQuery): Promise<{ items: TimelineEntry[]; total: number }> {
  const where: Prisma.ConnectionEventWhereInput = {
    ...(query.deviceId ? { deviceId: query.deviceId } : {}),
    ...(query.nodeId ? { nodeId: query.nodeId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.types && query.types.length > 0 ? { type: { in: query.types } } : {}),
    ...(query.actor ? { actor: query.actor } : {}),
    ...(query.severity ? { severity: query.severity } : {}),
    ...(query.from || query.to
      ? { ts: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }
      : {}),
    ...(query.search
      ? {
          OR: [
            { reason: { contains: query.search, mode: "insensitive" } },
            { actorLabel: { contains: query.search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const page = Math.max(1, query.page);
  const pageSize = Math.min(200, Math.max(1, query.pageSize));

  const [rows, total] = await Promise.all([
    prisma.connectionEvent.findMany({
      where,
      orderBy: { ts: query.order ?? "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.connectionEvent.count({ where }),
  ]);

  // One lookup per dimension instead of a join per row: the timeline is read far more
  // often than it is written, but it is also the widest table in the console.
  const deviceIds = [...new Set(rows.map((row) => row.deviceId).filter((id): id is string => Boolean(id)))];
  const nodeIds = [...new Set(rows.map((row) => row.nodeId).filter((id): id is string => Boolean(id)))];

  const [devices, nodes] = await Promise.all([
    deviceIds.length > 0
      ? prisma.device.findMany({ where: { id: { in: deviceIds } }, select: { id: true, displayName: true } })
      : Promise.resolve([]),
    nodeIds.length > 0
      ? prisma.vpnNode.findMany({ where: { id: { in: nodeIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const deviceLabels = new Map(devices.map((row) => [row.id, row.displayName]));
  const nodeLabels = new Map(nodes.map((row) => [row.id, row.name]));

  return {
    items: rows.map((row) => ({
      id: row.id,
      ts: row.ts.toISOString(),
      type: row.type,
      typeLabel: timelineTypeLabel(row.type),
      deviceId: row.deviceId,
      deviceLabel: row.deviceId ? (deviceLabels.get(row.deviceId) ?? null) : null,
      nodeId: row.nodeId,
      nodeLabel: row.nodeId ? (nodeLabels.get(row.nodeId) ?? null) : null,
      userId: row.userId,
      sessionId: row.sessionId,
      bytesUp: row.bytesUp === null ? null : row.bytesUp.toString(),
      bytesDown: row.bytesDown === null ? null : row.bytesDown.toString(),
      reason: row.reason,
      actor: row.actor,
      actorLabel: row.actorLabel,
      severity: row.severity,
      metadata: row.metadata ?? null,
      repeatCount: row.repeatCount,
    })),
    total,
  };
}

/** Distinct event types that actually exist, so a filter never offers an empty option. */
export async function timelineTypeFacets(): Promise<Array<{ type: ConnectionEventType; count: number }>> {
  const grouped = await prisma.connectionEvent.groupBy({
    by: ["type"],
    _count: { _all: true },
    orderBy: { _count: { type: "desc" } },
  });
  return grouped.map((row) => ({ type: row.type, count: row._count._all }));
}
