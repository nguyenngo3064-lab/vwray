import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { hashSecret, sha256Hex, sealSecret, verifySecret } from "@/server/lib/crypto";
import { randomHex } from "@/server/lib/ids";
import { record } from "@/server/audit";
import { assertSafeOutboundUrl } from "@/server/security/ssrf";

/**
 * Programmatic access: API keys and webhook endpoints.
 *
 * API keys are the machine credential for the console API. Like session tokens they
 * are stored as hashes, but with two additions that matter for a long-lived key:
 *   * a visible `prefix`, so an operator can identify a key in a list without the
 *     secret ever being returned again,
 *   * an explicit `scopes` list, checked by `authorizeApiKey`, so a read-only
 *     integration cannot approve devices or reset quotas by accident.
 *
 * Webhook endpoints live in this module because they share the threat model: an
 * operator-supplied URL the server will later call (see security/ssrf.ts).
 */

export const API_KEY_SCOPES = [
  "traffic:read",
  "devices:read",
  "devices:write",
  "nodes:read",
  "nodes:write",
  "quota:read",
  "quota:write",
  "billing:read",
  "receipts:read",
  "receipts:write",
  "audit:read",
  "settings:read",
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export function isKnownScope(scope: string): scope is ApiKeyScope {
  return (API_KEY_SCOPES as readonly string[]).includes(scope);
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  active: boolean;
  createdBy: string | null;
}

export async function listApiKeys(): Promise<ApiKeySummary[]> {
  const rows = await prisma.apiKey.findMany({
    orderBy: { createdAt: "desc" },
    include: { createdBy: { select: { username: true } } },
  });
  const now = Date.now();

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    lastUsedAt: row.lastUsedAt,
    active: row.revokedAt === null && (row.expiresAt === null || row.expiresAt.getTime() > now),
    createdBy: row.createdBy?.username ?? null,
  }));
}

/**
 * Creates a key and returns the plaintext exactly once.
 *
 * Format: `vwk_<prefix>_<secret>`. The prefix is what lists show; the secret is
 * hashed with scrypt, so a database leak does not yield usable keys.
 */
export async function createApiKey(input: {
  name: string;
  scopes: string[];
  expiresInDays: number | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; key: string; prefix: string; scopes: string[]; expiresAt: Date | null }> {
  const unknown = input.scopes.filter((scope) => !isKnownScope(scope));
  if (unknown.length > 0) {
    throw errors.validation("The key requests scopes that do not exist.", { unknown });
  }
  if (input.scopes.length === 0) {
    throw errors.validation("A key must have at least one scope.");
  }

  const prefix = randomHex(4);
  const secret = randomHex(24);
  const plaintext = `vwk_${prefix}_${secret}`;
  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const created = await prisma.apiKey.create({
    data: {
      name: input.name.slice(0, 80),
      prefix,
      keyHash: hashSecret(plaintext),
      scopes: input.scopes,
      createdById: input.actorId,
      expiresAt,
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.api_key_created",
    resource: "api_key",
    resourceId: created.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { name: created.name, prefix, scopes: input.scopes, expiresAt },
  });

  return { id: created.id, key: plaintext, prefix, scopes: input.scopes, expiresAt };
}

export async function revokeApiKey(input: {
  keyId: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const existing = await prisma.apiKey.findUnique({ where: { id: input.keyId } });
  if (!existing) throw errors.notFound("API key");

  await prisma.apiKey.update({ where: { id: input.keyId }, data: { revokedAt: new Date() } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.api_key_revoked",
    resource: "api_key",
    resourceId: input.keyId,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { prefix: existing.prefix, name: existing.name },
  });
}

export interface ApiKeyPrincipal {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
}

/**
 * Authenticates `Authorization: Bearer vwk_...`.
 *
 * The key is looked up by its VISIBLE PREFIX first, so a request carrying a random
 * key costs one indexed query and zero scrypt work. Only the single matching row is
 * then verified with the slow KDF, which keeps the endpoint resistant to a
 * brute-force flood without letting an attacker turn it into a CPU sink.
 */
export async function authenticateApiKey(rawKey: string): Promise<ApiKeyPrincipal> {
  const parts = rawKey.split("_");
  if (parts.length !== 3 || parts[0] !== "vwk" || !parts[1] || !parts[2]) {
    throw errors.unauthenticated("The API key is malformed.");
  }

  const row = await prisma.apiKey.findUnique({ where: { prefix: parts[1] } });
  if (!row || row.revokedAt) throw errors.unauthenticated("The API key is not valid.");
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    throw errors.unauthenticated("The API key has expired.");
  }
  if (!verifySecret(rawKey, row.keyHash)) {
    throw errors.unauthenticated("The API key is not valid.");
  }

  // Touch `lastUsedAt` at most once a minute: a busy integration must not turn every
  // call into a write.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await prisma.apiKey
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);
  }

  return { id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes };
}

/** Throws unless the principal holds the scope. */
export function authorizeApiKey(principal: ApiKeyPrincipal, scope: ApiKeyScope): void {
  if (!principal.scopes.includes(scope) && !principal.scopes.includes("*")) {
    throw errors.forbidden(`This API key does not hold the "${scope}" scope.`);
  }
}

/** Short, non-secret digest of a prefix, so two keys can be told apart in a log. */
export function keyFingerprint(prefix: string): string {
  return sha256Hex(prefix).slice(0, 12);
}

// ------------------------------------------------------------- webhooks ------

export interface WebhookSummary {
  id: string;
  name: string;
  /** Host only: a full URL can carry a tenant token in its path. */
  host: string;
  events: string[];
  enabled: boolean;
  hasSecret: boolean;
  lastDeliveryAt: Date | null;
  lastStatus: string | null;
  failureCount: number;
  createdAt: Date;
}

export async function listWebhooks(): Promise<WebhookSummary[]> {
  const rows = await prisma.webhookEndpoint.findMany({ orderBy: { createdAt: "desc" } });
  return rows.map((row) => {
    let host = "invalid-url";
    try {
      host = new URL(row.url).host;
    } catch {
      // Stored before validation tightened up: shown as invalid rather than crashing.
    }
    return {
      id: row.id,
      name: row.name,
      host,
      events: row.events,
      enabled: row.enabled,
      hasSecret: Boolean(row.secretSealed),
      lastDeliveryAt: row.lastDeliveryAt,
      lastStatus: row.lastStatus,
      failureCount: row.failureCount,
      createdAt: row.createdAt,
    };
  });
}

export async function createWebhook(input: {
  name: string;
  url: string;
  events: string[];
  secret?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; host: string }> {
  const safe = await assertSafeOutboundUrl(input.url);

  const created = await prisma.webhookEndpoint.create({
    data: {
      name: input.name.slice(0, 80),
      url: safe.url.toString(),
      events: input.events.length > 0 ? input.events : ["*"],
      secretSealed: input.secret ? sealSecret(input.secret) : null,
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.webhook_created",
    resource: "webhook_endpoint",
    resourceId: created.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: {
      name: created.name,
      host: safe.url.host,
      resolved: safe.resolved,
      events: created.events,
      signed: Boolean(input.secret),
    },
  });

  return { id: created.id, host: safe.url.host };
}

export async function updateWebhook(input: {
  id: string;
  enabled?: boolean;
  url?: string;
  events?: string[];
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Webhook endpoint");

  let normalisedUrl: string | undefined;
  if (input.url) {
    const safe = await assertSafeOutboundUrl(input.url);
    normalisedUrl = safe.url.toString();
  }

  await prisma.webhookEndpoint.update({
    where: { id: input.id },
    data: {
      ...(normalisedUrl ? { url: normalisedUrl } : {}),
      ...(input.events ? { events: input.events } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.webhook_updated",
    resource: "webhook_endpoint",
    resourceId: input.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: {
      urlChanged: Boolean(normalisedUrl),
      enabled: input.enabled ?? existing.enabled,
      events: input.events ?? existing.events,
    },
  });
}

export async function deleteWebhook(input: {
  id: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<void> {
  const existing = await prisma.webhookEndpoint.findUnique({ where: { id: input.id } });
  if (!existing) throw errors.notFound("Webhook endpoint");

  await prisma.webhookEndpoint.delete({ where: { id: input.id } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "security.webhook_updated",
    resource: "webhook_endpoint",
    resourceId: input.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { action: "deleted", name: existing.name },
  });
}
