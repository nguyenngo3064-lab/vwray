import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { resolveRange } from "@/server/lib/time";
import { getSetting } from "@/server/settings/service";
import { maskIp } from "@/server/http/guard";

/**
 * Top data consumers.
 *
 * The brief is explicit and this module is built around it: a VPN gateway CANNOT see
 * which application produced a packet. There is therefore no "TikTok / YouTube /
 * Facebook" dimension here, and none can be added without a real attribution source.
 * What is offered is what the network layer legitimately exposes, each entry carrying
 * HOW it was attributed and how confident that attribution is:
 *
 *   DNS          - the device asked our resolver for this hostname
 *   SNI          - a TLS ClientHello carried the name in clear
 *   HOST_HEADER  - an unencrypted HTTP request carried the name
 *   IP_ONLY      - only a destination address was visible
 *   NONE         - the destination could not be attributed at all
 *
 * Byte totals come from the hub aggregate rows for the entity dimensions
 * (device/user/node/category). Destination-level BYTE totals additionally require
 * `domainId` on the aggregate, which the collector only sets when the data plane
 * reports a destination; when that never happens the list is honestly empty rather
 * than filled with DNS request counts relabelled as bytes.
 */

export type ConsumerDimension =
  | "device"
  | "user"
  | "node"
  | "category"
  | "destination"
  | "domain"
  | "ip";

export interface ConsumerEntry {
  rank: number;
  dimension: string;
  label: string;
  sublabel: string | null;
  bytes: string;
  sharePct: number | null;
  optimizedBytes: string | null;
  savedBytes: string | null;
  savingPct: number | null;
  category: string | null;
  protocol: string | null;
  attribution: "DNS" | "SNI" | "HOST_HEADER" | "IP_ONLY" | "NONE" | null;
  confidence: number | null;
}

export interface ConsumerResult {
  dimension: ConsumerDimension;
  appAttributionAvailable: false;
  note: string;
  items: ConsumerEntry[];
  /** Reason the list is empty, when it is empty for a structural rather than a data reason. */
  unavailableReason: string | null;
  totalBytes: string;
}

const APP_ATTRIBUTION_NOTE =
  "Application-level attribution is unavailable: a VPN gateway cannot determine which application " +
  "generated a packet. Entries are attributed from DNS queries, TLS SNI or HTTP Host headers where the " +
  "network layer legitimately exposes them, or from the destination address alone. Each entry states its " +
  "attribution method and confidence.";

const DESTINATION_UNAVAILABLE_REASON =
  "No traffic aggregate carries destination attribution for this period. Destination-level byte totals " +
  "require the data plane to report a hostname or IP per sample; when it does not, this breakdown stays " +
  "empty instead of substituting DNS request counts, which are not bytes.";

function share(bytes: bigint, total: bigint): number | null {
  if (total === 0n) return null;
  return round1((Number(bytes) / Number(total)) * 100);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function normaliseDimension(value: string | null | undefined): ConsumerDimension {
  const allowed: ConsumerDimension[] = ["device", "user", "node", "category", "destination", "domain", "ip"];
  const candidate = (value ?? "device") as ConsumerDimension;
  return allowed.includes(candidate) ? candidate : "device";
}

async function safeMaskSetting(): Promise<boolean> {
  try {
    return await getSetting<boolean>("security.maskSourceIps");
  } catch {
    // Failing closed (masking) is the privacy-preserving default.
    return true;
  }
}

export async function queryConsumers(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  dimension?: string | null;
  limit?: number;
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Promise<ConsumerResult> {
  const dimension = normaliseDimension(input.dimension);
  const range = resolveRange({ preset: input.preset, from: input.from, to: input.to });
  if (!range) throw errors.validation("The selected date range is invalid.");

  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
  const source = input.source && input.source !== "ALL" ? input.source : undefined;

  if (dimension === "destination" || dimension === "domain" || dimension === "ip") {
    return destinationConsumers({ range, dimension, limit, source });
  }

  const grouped = await prisma.trafficAggregate.groupBy({
    by: ["dimKey"],
    where: {
      dimKey: { startsWith: `${dimension}:` },
      bucketStart: { gte: range.start, lt: range.end },
      ...(source ? { source } : {}),
    },
    _sum: { bytes: true, bytesOptimized: true },
  });

  const rows = grouped
    .map((row) => ({
      id: row.dimKey.slice(dimension.length + 1),
      bytes: row._sum.bytes ?? 0n,
      optimized: row._sum.bytesOptimized ?? null,
    }))
    .filter((row) => row.bytes > 0n)
    .sort((left, right) => (right.bytes > left.bytes ? 1 : -1))
    .slice(0, limit);

  const totalBytes = grouped.reduce((sum, row) => sum + (row._sum.bytes ?? 0n), 0n);
  const labels = await labelFor(dimension, rows.map((row) => row.id));

  const items: ConsumerEntry[] = rows.map((row, index) => ({
    rank: index + 1,
    dimension,
    label: dimension === "category" ? row.id : (labels.get(row.id) ?? `(removed) ${row.id.slice(0, 8)}`),
    sublabel: dimension === "category" ? null : row.id.slice(0, 12),
    bytes: row.bytes.toString(),
    sharePct: share(row.bytes, totalBytes),
    optimizedBytes: row.optimized === null ? null : row.optimized.toString(),
    savedBytes: row.optimized === null ? null : (row.bytes - row.optimized).toString(),
    savingPct:
      row.optimized === null || row.bytes === 0n
        ? null
        : round1((Number(row.bytes - row.optimized) / Number(row.bytes)) * 100),
    // An entity has no destination attribution here; null renders as "not attributed".
    category: null,
    protocol: null,
    attribution: null,
    confidence: null,
  }));

  return {
    dimension,
    appAttributionAvailable: false,
    note: APP_ATTRIBUTION_NOTE,
    items,
    unavailableReason:
      items.length === 0
        ? "No aggregated traffic was recorded for this dimension in the selected period."
        : null,
    totalBytes: totalBytes.toString(),
  };
}

async function destinationConsumers(input: {
  range: { start: Date; end: Date };
  dimension: ConsumerDimension;
  limit: number;
  source?: "REAL" | "MOCK";
}): Promise<ConsumerResult> {
  const maskIps = await safeMaskSetting();

  const grouped = await prisma.trafficAggregate.groupBy({
    by: ["domainId"],
    where: {
      domainId: { not: null },
      bucketStart: { gte: input.range.start, lt: input.range.end },
      ...(input.source ? { source: input.source } : {}),
    },
    _sum: { bytes: true, bytesOptimized: true },
  });

  const entries = grouped
    .map((row) => ({
      domainId: row.domainId as string,
      bytes: row._sum.bytes ?? 0n,
      optimized: row._sum.bytesOptimized ?? null,
    }))
    .sort((left, right) => (right.bytes > left.bytes ? 1 : -1))
    .slice(0, input.limit);

  const destinations = await prisma.trafficDestination.findMany({
    where: { id: { in: entries.map((entry) => entry.domainId) } },
  });
  const byId = new Map(destinations.map((row) => [row.id, row]));
  const totalBytes = grouped.reduce((sum, row) => sum + (row._sum.bytes ?? 0n), 0n);

  const items: ConsumerEntry[] = entries.map((entry, index) => {
    const destination = byId.get(entry.domainId);
    const hostname = destination?.hostname ?? null;
    const rawIp = destination?.ip ?? null;
    const displayIp = rawIp ? (maskIps ? maskIp(rawIp, true) : rawIp) : null;

    return {
      rank: index + 1,
      dimension: input.dimension,
      label:
        input.dimension === "ip"
          ? (displayIp ?? "unattributed destination")
          : (hostname ?? displayIp ?? "unattributed destination"),
      sublabel: hostname && displayIp ? displayIp : null,
      bytes: entry.bytes.toString(),
      sharePct: share(entry.bytes, totalBytes),
      optimizedBytes: entry.optimized === null ? null : entry.optimized.toString(),
      savedBytes: entry.optimized === null ? null : (entry.bytes - entry.optimized).toString(),
      savingPct:
        entry.optimized === null || entry.bytes === 0n
          ? null
          : round1((Number(entry.bytes - entry.optimized) / Number(entry.bytes)) * 100),
      category: destination?.category ?? null,
      protocol: destination?.protocol ?? null,
      attribution: (destination?.attribution as ConsumerEntry["attribution"]) ?? "NONE",
      confidence: destination?.confidence ?? null,
    };
  });

  return {
    dimension: input.dimension,
    appAttributionAvailable: false,
    note: APP_ATTRIBUTION_NOTE,
    items,
    unavailableReason: items.length === 0 ? DESTINATION_UNAVAILABLE_REASON : null,
    totalBytes: totalBytes.toString(),
  };
}

async function labelFor(
  dimension: ConsumerDimension,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  if (dimension === "node") {
    const rows = await prisma.vpnNode.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
  if (dimension === "user") {
    const rows = await prisma.adminUser.findMany({
      where: { id: { in: ids } },
      select: { id: true, username: true },
    });
    return new Map(rows.map((row) => [row.id, row.username]));
  }
  const rows = await prisma.device.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  return new Map(rows.map((row) => [row.id, row.displayName]));
}
