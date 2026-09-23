import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { getSetting } from "@/server/settings/service";
import { resolveRange } from "@/server/lib/time";

const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export function assertDomain(domain: string): string {
  const normalised = domain.trim().toLowerCase();
  if (!DOMAIN_PATTERN.test(normalised)) throw errors.validation(`"${domain}" is not a plain hostname.`);
  return normalised;
}

export async function listDnsLists() {
  const rows = await prisma.dnsList.findMany({
    orderBy: { name: "asc" },
    include: { entries: { select: { domain: true }, take: 20, orderBy: { domain: "asc" } } },
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    category: row.category,
    source: row.source,
    enabled: row.enabled,
    entryCount: row.entryCount,
    updatedAt: row.updatedAt.toISOString(),
    sampleEntries: row.entries.map((entry) => entry.domain),
  }));
}

async function dnsStatsFor(range: { start: Date; end: Date } | null, deviceId: string | null) {
  const [blocked, allowed] = await Promise.all([
    prisma.dnsQueryStat.aggregate({
      _sum: { count: true, estimatedBytesSaved: true },
      where: {
        action: "BLOCK",
        ...(range ? { bucketStart: { gte: range.start, lt: range.end } } : {}),
        ...(deviceId ? { deviceId } : {}),
      },
    }),
    prisma.dnsQueryStat.aggregate({
      _sum: { count: true },
      where: {
        action: "ALLOW",
        ...(range ? { bucketStart: { gte: range.start, lt: range.end } } : {}),
        ...(deviceId ? { deviceId } : {}),
      },
    }),
  ]);

  const [topBlocked, topAllowed] = await Promise.all([
    prisma.dnsQueryStat.groupBy({
      by: ["domainName", "category"],
      where: {
        action: "BLOCK",
        ...(range ? { bucketStart: { gte: range.start, lt: range.end } } : {}),
        ...(deviceId ? { deviceId } : {}),
      },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: 10,
    }),
    prisma.dnsQueryStat.groupBy({
      by: ["domainName", "category"],
      where: {
        action: "ALLOW",
        ...(range ? { bucketStart: { gte: range.start, lt: range.end } } : {}),
        ...(deviceId ? { deviceId } : {}),
      },
      _sum: { count: true },
      orderBy: { _sum: { count: "desc" } },
      take: 10,
    }),
  ]);

  return { blocked, allowed, topBlocked, topAllowed };
}

function toCount(value: bigint | null): string {
  return (value ?? 0n).toString();
}

export async function dnsOverview() {
  const [enabled, provider, lists] = await Promise.all([
    getSetting<boolean>("dns.filteringEnabled"),
    getSetting<string>("dns.provider").catch(() => "system"),
    listDnsLists(),
  ]);
  const stats = await dnsStatsFor(null, null);
  const blocked = toCount(stats.blocked._sum.count);
  const allowed = toCount(stats.allowed._sum.count);
  const blockedNum = Number(BigInt(blocked));
  const allowedNum = Number(BigInt(allowed));
  const total = blockedNum + allowedNum;
  const [assumedBytes] = await Promise.all([
    getSetting<number>("traffic.assumedBlockedResponseBytes").catch(() => 0),
  ]);

  return {
    enabled,
    provider,
    providerConfigured: provider.length > 0,
    lists,
    stats: {
      blocked,
      allowed,
      blockedPct: total > 0 ? Math.round((blockedNum / total) * 1000) / 10 : null,
      topBlocked: stats.topBlocked.map((row) => ({
        domain: row.domainName,
        count: (row._sum.count ?? 0n).toString(),
        category: row.category,
      })),
      topAllowed: stats.topAllowed.map((row) => ({
        domain: row.domainName,
        count: (row._sum.count ?? 0n).toString(),
        category: row.category,
      })),
    },
    estimatedBytesSaved:
      assumedBytes > 0 ? (stats.blocked._sum.estimatedBytesSaved ?? 0n).toString() : null,
    estimationBasis:
      assumedBytes > 0
        ? `ESTIMATED from an assumed ${assumedBytes} byte response per blocked lookup (setting traffic.assumedBlockedResponseBytes).`
        : null,
    disclaimer:
      "DNS filtering only decides whether a name resolves. It performs no TLS interception and inspects no encrypted payload.",
  };
}

export async function dnsStats(input: {
  preset?: string;
  from?: string | null;
  to?: string | null;
  deviceId?: string | null;
}) {
  const range = resolveRange({ preset: input.preset ?? "30d", from: input.from, to: input.to });
  const stats = await dnsStatsFor(range, input.deviceId ?? null);
  const blocked = toCount(stats.blocked._sum.count);
  const allowed = toCount(stats.allowed._sum.count);
  const blockedNum = Number(BigInt(blocked));
  const allowedNum = Number(BigInt(allowed));
  const total = blockedNum + allowedNum;
  const assumedBytes = await getSetting<number>("traffic.assumedBlockedResponseBytes").catch(() => 0);

  const series = range
    ? await prisma.dnsQueryStat.groupBy({
        by: ["bucketStart", "action"],
        where: {
          bucketStart: { gte: range.start, lt: range.end },
          ...(input.deviceId ? { deviceId: input.deviceId } : {}),
        },
        _sum: { count: true },
        orderBy: { bucketStart: "asc" },
        take: 5_000,
      })
    : [];

  const byBucket = new Map<number, { blocked: bigint; allowed: bigint }>();
  for (const row of series) {
    const entry = byBucket.get(row.bucketStart.getTime()) ?? { blocked: 0n, allowed: 0n };
    if (row.action === "BLOCK") entry.blocked += row._sum.count ?? 0n;
    else entry.allowed += row._sum.count ?? 0n;
    byBucket.set(row.bucketStart.getTime(), entry);
  }

  return {
    range: range ? { start: range.start.toISOString(), end: range.end.toISOString() } : null,
    series: [...byBucket.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, entry]) => ({
        t,
        blocked: entry.blocked.toString(),
        allowed: entry.allowed.toString(),
      })),
    topBlocked: stats.topBlocked.map((row) => ({
      domain: row.domainName,
      count: (row._sum.count ?? 0n).toString(),
      category: row.category,
    })),
    topAllowed: stats.topAllowed.map((row) => ({
      domain: row.domainName,
      count: (row._sum.count ?? 0n).toString(),
      category: row.category,
    })),
    totals: {
      blocked,
      allowed,
      blockedPct: total > 0 ? Math.round((blockedNum / total) * 1000) / 10 : null,
    },
    estimatedBytesSaved:
      assumedBytes > 0 ? (stats.blocked._sum.estimatedBytesSaved ?? 0n).toString() : null,
    estimationBasis:
      assumedBytes > 0
        ? `ESTIMATED from an assumed ${assumedBytes} byte response per blocked lookup (setting traffic.assumedBlockedResponseBytes).`
        : null,
    disclaimer:
      "DNS filtering only decides whether a name resolves. It performs no TLS interception and inspects no encrypted payload.",
  };
}

export async function createDnsList(input: {
  name: string;
  kind: "BLOCKLIST" | "ALLOWLIST";
  category?: string | null;
  source?: string | null;
  entries?: string[];
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; entryCount: number; skipped: number }> {
  const domains = [...new Set((input.entries ?? []).map((entry) => entry.trim().toLowerCase()).filter(Boolean))];
  const valid: string[] = [];
  let skipped = 0;
  for (const domain of domains) {
    try {
      valid.push(assertDomain(domain));
    } catch {
      skipped += 1;
    }
  }

  const list = await prisma.dnsList.create({
    data: {
      name: input.name.slice(0, 80),
      kind: input.kind,
      category: input.category?.slice(0, 60) ?? null,
      source: input.source?.slice(0, 120) ?? null,
      entryCount: 0,
    },
  });

  if (valid.length > 0) {
    await prisma.dnsListEntry.createMany({
      data: valid.map((domain) => ({ listId: list.id, domain })),
      skipDuplicates: true,
    });
  }
  const entryCount = await prisma.dnsListEntry.count({ where: { listId: list.id } });
  await prisma.dnsList.update({ where: { id: list.id }, data: { entryCount } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "dns.list_created",
    resource: "dns_list",
    resourceId: list.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { name: list.name, kind: list.kind, entryCount, skipped },
  });

  return { id: list.id, entryCount, skipped };
}

export async function updateDnsList(input: {
  id: string;
  name?: string;
  enabled?: boolean;
  add?: string[];
  remove?: string[];
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; entryCount: number; skipped: number }> {
  const list = await prisma.dnsList.findUnique({ where: { id: input.id } });
  if (!list) throw errors.notFound("DNS list");

  let skipped = 0;
  const additions: string[] = [];
  for (const raw of input.add ?? []) {
    try {
      additions.push(assertDomain(raw));
    } catch {
      skipped += 1;
    }
  }
  const removals = (input.remove ?? []).map((raw) => raw.trim().toLowerCase()).filter(Boolean);

  await prisma.$transaction(async (tx) => {
    if (additions.length > 0) {
      await tx.dnsListEntry.createMany({
        data: additions.map((domain) => ({ listId: list.id, domain })),
        skipDuplicates: true,
      });
    }
    if (removals.length > 0) {
      await tx.dnsListEntry.deleteMany({ where: { listId: list.id, domain: { in: removals } } });
    }
    await tx.dnsList.update({
      where: { id: list.id },
      data: {
        ...(input.name !== undefined ? { name: input.name.slice(0, 80) } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        entryCount: await tx.dnsListEntry.count({ where: { listId: list.id } }),
      },
    });
  });

  const entryCount = await prisma.dnsListEntry.count({ where: { listId: list.id } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "dns.list_updated",
    resource: "dns_list",
    resourceId: list.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { added: additions.length, removed: removals.length, skipped, entryCount },
  });

  return { id: list.id, entryCount, skipped };
}

export async function deleteDnsList(input: {
  id: string;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string }> {
  const list = await prisma.dnsList.findUnique({ where: { id: input.id } });
  if (!list) throw errors.notFound("DNS list");

  await prisma.dnsList.delete({ where: { id: list.id } });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "dns.list_updated",
    resource: "dns_list",
    resourceId: list.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { name: list.name, deleted: true },
  });

  return { id: list.id };
}

export async function upsertDnsRule(input: {
  action: "ALLOW" | "BLOCK";
  domain: string;
  scope?: string | null;
  note?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string; action: "ALLOW" | "BLOCK"; domain: string }> {
  const domain = assertDomain(input.domain);

  let custom = await prisma.dnsList.findFirst({ where: { name: "custom" } });
  if (!custom) {
    custom = await prisma.dnsList.create({
      data: { name: "custom", kind: input.action === "BLOCK" ? "BLOCKLIST" : "ALLOWLIST", source: "operator" },
    });
  }

  const entry = await prisma.dnsListEntry.upsert({
    where: { listId_domain_scope: { listId: custom.id, domain, scope: input.scope ?? "" } },
    create: { listId: custom.id, domain, scope: input.scope ?? null, note: input.note?.slice(0, 300) ?? null },
    update: { note: input.note?.slice(0, 300) ?? undefined },
  });

  await prisma.dnsList.update({
    where: { id: custom.id },
    data: { entryCount: await prisma.dnsListEntry.count({ where: { listId: custom.id } }) },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "dns.rule_changed",
    resource: "dns_list_entry",
    resourceId: entry.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { domain, action: input.action, scope: input.scope ?? null },
  });

  return { id: entry.id, action: input.action, domain };
}
