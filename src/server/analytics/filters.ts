import "server-only";
import { z } from "zod";
import { errors } from "@/server/lib/errors";
import type { TrafficFilters } from "@/server/analytics/traffic";

/**
 * Query-string parsing for the traffic family of endpoints.
 *
 * Lives outside the route files on purpose: a Next.js `route.ts` may only export HTTP
 * verbs plus build-time config, so shared parsing cannot live there. Keeping one
 * parser also guarantees the JSON view, the CSV export and the overview all accept
 * exactly the same filters - an export that silently honoured a different subset
 * would produce a file that does not match the screen it was downloaded from.
 */
const filterSchema = z.object({
  preset: z.enum(["today", "7d", "30d", "month", "custom"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  deviceId: z.string().max(64).optional(),
  nodeId: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  configId: z.string().max(64).optional(),
  category: z.string().max(60).optional(),
  direction: z.enum(["UPLOAD", "DOWNLOAD"]).optional(),
  source: z.enum(["REAL", "MOCK", "ALL"]).optional(),
});

export function parseTrafficFilters(url: URL): TrafficFilters {
  const parsed = filterSchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw errors.validation("One or more traffic filters are invalid.", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  return {
    preset: parsed.data.preset ?? "today",
    from: parsed.data.from ?? null,
    to: parsed.data.to ?? null,
    deviceId: parsed.data.deviceId ?? null,
    nodeId: parsed.data.nodeId ?? null,
    userId: parsed.data.userId ?? null,
    configId: parsed.data.configId ?? null,
    category: parsed.data.category ?? null,
    direction: parsed.data.direction ?? null,
    source: parsed.data.source ?? "REAL",
  };
}

export function parseConsumerFilters(url: URL) {
  const schema = z.object({
    preset: z.enum(["today", "7d", "30d", "month", "custom"]).optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    dimension: z
      .enum(["device", "user", "node", "category", "destination", "domain", "ip"])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    source: z.enum(["REAL", "MOCK", "ALL"]).optional(),
  });

  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    throw errors.validation("One or more consumer filters are invalid.");
  }

  return {
    preset: parsed.data.preset ?? "today",
    from: parsed.data.from ?? null,
    to: parsed.data.to ?? null,
    dimension: parsed.data.dimension ?? "device",
    limit: parsed.data.limit ?? 25,
    source: parsed.data.source ?? "REAL",
  };
}
