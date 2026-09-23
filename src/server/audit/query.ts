import "server-only";
import type { ActorType, AuditResult, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";

/**
 * Audit trail QUERY side.
 *
 * The writer lives in `audit/audit.ts`; this module exists so the audit page and its
 * CSV export share exactly one filter interpretation - an export that honoured a
 * different subset than the screen would produce a file that disagrees with what the
 * operator was looking at.
 *
 * Facets (distinct actions / resources / actors) come from a BOUNDED scan: take 200
 * of each, most recent first. A full distinct over a multi-year append-only table is
 * a table scan per keystroke of the filter box; 200 recent values cover the filters
 * anyone actually uses while keeping the endpoint predictable on a small VPS.
 */

const FACET_CAP = 200;

/** Upper bound the CSV export will ever write, so the endpoint cannot dump a full table. */
export const AUDIT_EXPORT_MAX_ROWS = 10_000;

const ACTOR_TYPES: readonly string[] = ["USER", "SYSTEM", "GATEWAY", "API_KEY"];
const RESULTS: readonly string[] = ["SUCCESS", "FAILURE", "DENIED"];

export interface AuditRow {
  id: string;
  ts: string;
  actorType: ActorType;
  actorId: string | null;
  actorLabel: string;
  action: string;
  resource: string;
  resourceId: string | null;
  result: AuditResult;
  sourceIp: string | null;
  requestId: string | null;
  /** Pass-through of the stored, already-redacted metadata. Never augmented here. */
  metadata: Prisma.JsonValue;
}

export interface AuditFacets {
  actions: string[];
  resources: string[];
  actors: Array<{ id: string; label: string; type: ActorType }>;
}

export interface AuditFilters {
  page: number;
  pageSize: number;
  action?: string | null;
  resource?: string | null;
  actorType?: string | null;
  result?: string | null;
  search?: string | null;
  from?: string | null;
  to?: string | null;
}

function parseTs(raw: string | null | undefined, field: string): Date | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) {
    throw errors.validation(`The "${field}" filter must be an ISO timestamp.`);
  }
  return value;
}

function toRow(row: Prisma.AuditLogGetPayload<Record<string, never>>): AuditRow {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    actorType: row.actorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    action: row.action,
    resource: row.resource,
    resourceId: row.resourceId,
    result: row.result,
    sourceIp: row.sourceIp,
    requestId: row.requestId,
    metadata: row.metadata,
  };
}

async function loadFacets(): Promise<AuditFacets> {
  const [actions, resources, actors] = await Promise.all([
    prisma.auditLog.findMany({
      distinct: ["action"],
      orderBy: { ts: "desc" },
      take: FACET_CAP,
      select: { action: true },
    }),
    prisma.auditLog.findMany({
      distinct: ["resource"],
      orderBy: { ts: "desc" },
      take: FACET_CAP,
      select: { resource: true },
    }),
    prisma.auditLog.findMany({
      distinct: ["actorId"],
      orderBy: { ts: "desc" },
      take: FACET_CAP,
      select: { actorId: true, actorLabel: true, actorType: true },
    }),
  ]);

  return {
    actions: actions.map((row) => row.action).sort((a, b) => a.localeCompare(b)),
    resources: resources.map((row) => row.resource).sort((a, b) => a.localeCompare(b)),
    actors: actors
      .filter((row) => row.actorId !== null)
      .map((row) => ({ id: row.actorId as string, label: row.actorLabel, type: row.actorType }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * Filtered audit query with bounded facets.
 *
 * `page`/`pageSize` are already normalised by the caller (`paginationFrom`), except for
 * the CSV export which deliberately asks for up to AUDIT_EXPORT_MAX_ROWS in one page so
 * the file matches the on-screen filter exactly.
 */
export async function queryAuditLogs(
  filters: AuditFilters,
): Promise<{ items: AuditRow[]; total: number; facets: AuditFacets }> {
  if (filters.actorType && !ACTOR_TYPES.includes(filters.actorType)) {
    throw errors.validation(`"${filters.actorType}" is not a valid actor type.`);
  }
  if (filters.result && !RESULTS.includes(filters.result)) {
    throw errors.validation(`"${filters.result}" is not a valid audit result.`);
  }

  const from = parseTs(filters.from, "from");
  const to = parseTs(filters.to, "to");
  if (from && to && to.getTime() < from.getTime()) {
    throw errors.validation("The audit range must end after it starts.");
  }

  const search = filters.search?.trim() ? String(filters.search).trim() : null;

  const where: Prisma.AuditLogWhereInput = {
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.resource ? { resource: filters.resource } : {}),
    ...(filters.actorType ? { actorType: filters.actorType as ActorType } : {}),
    ...(filters.result ? { result: filters.result as AuditResult } : {}),
    ...(from ?? to
      ? { ts: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    ...(search
      ? {
          OR: [
            { actorLabel: { contains: search, mode: "insensitive" as const } },
            { action: { contains: search, mode: "insensitive" as const } },
            { resource: { contains: search, mode: "insensitive" as const } },
            { resourceId: { contains: search, mode: "insensitive" as const } },
            { requestId: { contains: search, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const pageSize = Math.max(1, Math.min(filters.pageSize, AUDIT_EXPORT_MAX_ROWS));
  const page = Math.max(1, Math.floor(filters.page));

  const [rows, total, facets] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { ts: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where }),
    loadFacets(),
  ]);

  return { items: rows.map(toRow), total, facets };
}
