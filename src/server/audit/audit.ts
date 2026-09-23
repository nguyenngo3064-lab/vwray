import "server-only";
import type { AuditResult, Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { generateRequestId } from "@/server/lib/ids";
import type { AuditAction, AuditActor } from "@/server/audit/actions";

/**
 * Audit trail writer.
 *
 * Two rules keep the trail trustworthy:
 *   1. Metadata passes through a redaction stage, so a careless caller cannot persist
 *      a credential into an append-only table that is never cleaned up.
 *   2. A failure to write the audit row is logged loudly but does not roll back the
 *      business action. Callers that need both to succeed atomically use
 *      `recordWithin` inside their own transaction.
 */

export interface AuditEntry {
  actor: AuditActor;
  action: AuditAction;
  resource: string;
  resourceId?: string | null;
  result: AuditResult;
  sourceIp?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Key fragments whose values are replaced before an audit row is written. */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "secret",
  "token",
  "privatekey",
  "private_key",
  "psk",
  "code",
  "sealed",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
];

export function redactAuditMetadata(
  metadata: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | undefined {
  if (!metadata) return undefined;

  const walk = (value: unknown, depth = 0): Prisma.InputJsonValue => {
    if (depth > 5) return "[truncated]";
    if (value === null || value === undefined) return null as unknown as Prisma.InputJsonValue;
    if (typeof value === "string") {
      if (/^v1:[A-Za-z0-9_-]+:/.test(value) || value.startsWith("scrypt$")) return "[redacted]";
      return value.length > 500 ? `${value.slice(0, 500)}[truncated]` : value;
    }
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => walk(entry, depth + 1));
    if (typeof value === "object") {
      const output: Record<string, Prisma.InputJsonValue> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const lower = key.toLowerCase();
        output[key] = SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment))
          ? "[redacted]"
          : walk(entry, depth + 1);
      }
      return output;
    }
    return String(value);
  };

  return walk(metadata);
}

function toRow(entry: AuditEntry, requestId: string) {
  return {
    actorType: entry.actor.type,
    actorId: entry.actor.type === "USER" ? entry.actor.id : null,
    actorLabel: entry.actor.label,
    action: entry.action,
    resource: entry.resource,
    resourceId: entry.resourceId ?? null,
    result: entry.result,
    sourceIp: entry.sourceIp ?? null,
    requestId: entry.requestId ?? requestId,
    metadata: redactAuditMetadata(entry.metadata),
  };
}

/** Writes one audit row. Never throws. */
export async function record(entry: AuditEntry): Promise<void> {
  const requestId = entry.requestId ?? generateRequestId();
  try {
    await prisma.auditLog.create({ data: toRow(entry, requestId) });
  } catch (error) {
    logger.error("audit write failed", {
      action: entry.action,
      resource: entry.resource,
      resourceId: entry.resourceId,
      requestId,
      error,
    });
  }
}

/**
 * Writes the audit row inside the caller's transaction, so the business write and
 * its audit record commit together. Used for quota enforcement and credential
 * revocation, where an action without a trail would be worse than a failed action.
 */
export async function recordWithin(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
  await tx.auditLog.create({ data: toRow(entry, entry.requestId ?? generateRequestId()) });
}

type OptionalFields = {
  resourceId?: string | null;
  sourceIp?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
};

/** Convenience wrapper for the common success case. */
export async function recordSuccess(
  actor: AuditActor,
  action: AuditAction,
  resource: string,
  options?: OptionalFields,
): Promise<void> {
  await record({ actor, action, resource, result: "SUCCESS", ...options });
}

/** Convenience wrapper for a denial or validation failure. */
export async function recordFailure(
  actor: AuditActor,
  action: AuditAction,
  resource: string,
  result: Extract<AuditResult, "FAILURE" | "DENIED"> = "FAILURE",
  options?: OptionalFields,
): Promise<void> {
  await record({ actor, action, resource, result, ...options });
}

/** Convenience wrapper for an authorisation denial (role or CSRF failure). */
export async function recordDenied(
  actor: AuditActor,
  action: AuditAction,
  resource: string,
  options?: OptionalFields,
): Promise<void> {
  await record({ actor, action, resource, result: "DENIED", ...options });
}
