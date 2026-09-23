import "server-only";
import type { SettingCategory } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record, userActor } from "@/server/audit";
import {
  SETTING_BY_KEY,
  SETTING_DEFINITIONS,
  SETTINGS_BY_CATEGORY,
  type SettingDefinition,
} from "@/server/settings/definitions";

/**
 * Settings service.
 *
 * Reads are cached in-process for a short window because the quota engine and the
 * traffic collector read several settings per ingested batch; without a cache the
 * ingest path would issue a database query per setting per batch. Writes invalidate
 * the cache immediately, so an operator never acts on a stale enforcement value.
 */

const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function invalidateSettingsCache(keys?: string[]): void {
  if (!keys) {
    cache.clear();
    return;
  }
  for (const key of keys) cache.delete(key);
}

function parseOrDefault(definition: SettingDefinition, raw: unknown): unknown {
  const parsed = definition.schema.safeParse(raw ?? definition.defaultValue);
  return parsed.success ? parsed.data : definition.defaultValue;
}

/** Reads a single setting, falling back to the registry default. */
export async function getSetting<T = unknown>(key: string): Promise<T> {
  const definition = SETTING_BY_KEY.get(key);
  if (!definition) {
    throw errors.internal(`Unknown setting "${key}". Add it to the settings registry first.`);
  }

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value as T;

  const row = await prisma.systemSetting.findUnique({ where: { key } });
  const value = parseOrDefault(definition, row?.value);

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value as T;
}

/** Reads many settings in one round trip, applying defaults for missing rows. */
export async function getSettings(keys: string[]): Promise<Record<string, unknown>> {
  const unknownKeys = keys.filter((key) => !SETTING_BY_KEY.has(key));
  if (unknownKeys.length > 0) {
    throw errors.internal(`Unknown settings requested: ${unknownKeys.join(", ")}`);
  }

  const now = Date.now();
  const missing = keys.filter((key) => {
    const entry = cache.get(key);
    return !entry || entry.expiresAt <= now;
  });

  if (missing.length > 0) {
    const rows = await prisma.systemSetting.findMany({ where: { key: { in: missing } } });
    const byKey = new Map(rows.map((row) => [row.key, row.value]));
    for (const key of missing) {
      const definition = SETTING_BY_KEY.get(key) as SettingDefinition;
      cache.set(key, {
        value: parseOrDefault(definition, byKey.get(key)),
        expiresAt: now + CACHE_TTL_MS,
      });
    }
  }

  const output: Record<string, unknown> = {};
  for (const key of keys) output[key] = cache.get(key)?.value;
  return output;
}

export interface SettingView {
  key: string;
  category: SettingCategory;
  description: string;
  impact: string | null;
  sensitive: boolean;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  /** Coarse shape of the accepted value, so the settings form can pick a control. */
  shape: "boolean" | "number" | "string" | "list" | "object";
}

function describeShape(definition: SettingDefinition): SettingView["shape"] {
  const fallback = definition.defaultValue;
  if (typeof fallback === "boolean") return "boolean";
  if (typeof fallback === "number") return "number";
  if (typeof fallback === "string") return "string";
  if (Array.isArray(fallback)) return "list";
  return "object";
}

/** Full settings surface with current values, for the settings page. */
export async function listSettings(category?: SettingCategory): Promise<SettingView[]> {
  const definitions = category
    ? (SETTINGS_BY_CATEGORY[category] ?? [])
    : (SETTING_DEFINITIONS as unknown as SettingDefinition[]);

  const rows = await prisma.systemSetting.findMany({
    where: { key: { in: definitions.map((definition) => definition.key) } },
  });
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  return definitions.map((definition) => {
    const raw = stored.get(definition.key);
    return {
      key: definition.key,
      category: definition.category,
      description: definition.description,
      impact: definition.impact ?? null,
      sensitive: definition.sensitive ?? false,
      value: parseOrDefault(definition, raw),
      defaultValue: definition.defaultValue,
      isDefault: raw === undefined || raw === null,
      shape: describeShape(definition),
    };
  });
}

/**
 * Validates and persists one setting. The value must satisfy the registry schema
 * before it can reach any engine.
 */
export async function updateSetting(input: {
  key: string;
  value: unknown;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ key: string; value: unknown }> {
  const definition = SETTING_BY_KEY.get(input.key);
  if (!definition) throw errors.notFound(`Setting "${input.key}"`);

  const parsed = definition.schema.safeParse(input.value);
  if (!parsed.success) {
    throw errors.validation(`The value for "${input.key}" is invalid.`, {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
      expected: describeShape(definition),
    });
  }

  await prisma.systemSetting.upsert({
    where: { key: input.key },
    create: {
      key: input.key,
      category: definition.category,
      description: definition.description,
      value: parsed.data as never,
      updatedById: input.actorId,
    },
    update: { value: parsed.data as never, updatedById: input.actorId },
  });

  invalidateSettingsCache([input.key]);

  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: input.key === "system.maintenanceMode" ? "settings.maintenance_mode" : "settings.updated",
    resource: "system_setting",
    resourceId: input.key,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { key: input.key, value: parsed.data },
  });

  return { key: input.key, value: parsed.data };
}

/** Seeds every registry default that has no row yet. Used by bootstrap and tests. */
export async function ensureSettingsSeeded(): Promise<number> {
  const existing = await prisma.systemSetting.findMany({ select: { key: true } });
  const existingKeys = new Set(existing.map((row) => row.key));

  const missing = (SETTING_DEFINITIONS as unknown as SettingDefinition[]).filter(
    (definition) => !existingKeys.has(definition.key),
  );
  if (missing.length === 0) return 0;

  await prisma.systemSetting.createMany({
    data: missing.map((definition) => ({
      key: definition.key,
      category: definition.category,
      description: definition.description,
      value: definition.defaultValue as never,
    })),
    skipDuplicates: true,
  });

  invalidateSettingsCache();
  return missing.length;
}
