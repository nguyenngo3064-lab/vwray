import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { authenticateAgent } from "@/server/gateway/auth";
import { prisma } from "@/server/db/client";
import { getSetting } from "@/server/settings/service";
import { dnsDimKey } from "@/server/traffic/dimensions";
import { bucketStart } from "@/server/lib/time";
import { record } from "@/server/audit";

/**
 * DNS query statistics from the data plane (DATA PLANE -> CONTROL PLANE).
 *
 * Only outcomes are reported - a name was allowed or blocked - never query content and
 * never payload. The `estimatedBytesSaved` column is derived HERE from the configured
 * `traffic.assumedBlockedResponseBytes` assumption and is tagged `ESTIMATED`, because
 * the control plane has no way to know how much a blocked lookup would have cost, and
 * presenting an assumption as a measurement is exactly the failure the brief forbids.
 */

const entrySchema = z.object({
  domainName: z
    .string()
    .min(1)
    .max(253)
    // Hostname shape only: this is data, not a shell argument or a query string.
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i, {
      message: "domainName must be a plain hostname.",
    }),
  action: z.enum(["ALLOW", "BLOCK"]),
  deviceId: z.string().min(1).max(64).optional(),
  category: z.string().max(60).optional(),
  count: z.number().int().min(1).max(10_000_000),
});

const bodySchema = z.object({
  entries: z.array(entrySchema).min(1).max(2_000),
  timestamp: z.number().int().optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const { node } = await authenticateAgent(request);

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    throw errors.validation("The DNS statistics payload is invalid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const [assumedBytes, enabled] = await Promise.all([
    getSetting<number>("traffic.assumedBlockedResponseBytes").catch(() => 0),
    getSetting<boolean>("dns.filteringEnabled").catch(() => false),
  ]);

  if (!enabled) {
    // The agent reporting counts while filtering is off means a configuration drift.
    // Accept the data (it is still truth about what happened) but say so.
    await record({
      actor: { type: "GATEWAY", id: node.id, label: node.name },
      action: "dns.rule_changed",
      resource: "dns_query_stat",
      result: "FAILURE",
      metadata: { reason: "ingest_while_filtering_disabled", entries: parsed.data.entries.length },
    });
  }

  const at = new Date(parsed.data.timestamp ?? Date.now());
  const bucket = bucketStart(at, "HOUR");
  const bucketEnd = new Date(bucket.getTime() + 3_600_000);
  const source = node.isRealGateway ? "REAL" : "MOCK";

  const deviceIds = parsed.data.entries
    .map((entry) => entry.deviceId)
    .filter((id): id is string => Boolean(id));
  const devices = deviceIds.length
    ? await prisma.device.findMany({
        where: { deviceId: { in: deviceIds } },
        select: { id: true, deviceId: true },
      })
    : [];
  const deviceByPublicId = new Map(devices.map((row) => [row.deviceId, row.id]));

  let written = 0;
  for (const entry of parsed.data.entries) {
    const deviceId = entry.deviceId ? deviceByPublicId.get(entry.deviceId) ?? null : null;
    const dimKey = dnsDimKey({ deviceId, nodeId: node.id, domainName: entry.domainName });

    const existing = await prisma.dnsQueryStat.findFirst({
      where: {
        granularity: "HOUR",
        bucketStart: bucket,
        dimKey,
        action: entry.action,
        source,
      },
      select: { id: true, count: true },
    });

    if (existing) {
      await prisma.dnsQueryStat.update({
        where: { id: existing.id },
        data: { count: { increment: entry.count } },
      });
      written += 1;
      continue;
    }

    await prisma.dnsQueryStat.create({
      data: {
        bucketStart: bucket,
        granularity: "HOUR",
        dimKey,
        nodeId: node.id,
        deviceId,
        domainName: entry.domainName,
        category: entry.category ?? null,
        action: entry.action,
        count: BigInt(entry.count),
        estimatedBytesSaved:
          entry.action === "BLOCK" && assumedBytes > 0
            ? BigInt(assumedBytes) * BigInt(entry.count)
            : null,
        estimatedBytesKind: entry.action === "BLOCK" && assumedBytes > 0 ? "ESTIMATED" : null,
        source,
      },
    });
    written += 1;
  }

  // Silence the unused binding while keeping `bucketEnd` documented as the bucket's
  // exclusive end for anyone reading this alongside the retention job.
  void bucketEnd;

  return jsonOk({
    nodeId: node.nodeId,
    accepted: parsed.data.entries.length,
    written,
    at: at.toISOString(),
    estimationBasis:
      assumedBytes > 0
        ? `ESTIMATED from an assumed ${assumedBytes} byte response per blocked lookup (setting traffic.assumedBlockedResponseBytes).`
        : null,
  });
});

async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) throw errors.validation("A JSON request body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}
