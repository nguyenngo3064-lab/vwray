import "server-only";
import { prisma } from "@/server/db/client";

/**
 * Global search ("search everything").
 *
 * One bounded query per entity type, capped at 5 hits each, so the endpoint stays O(1)
 * in the number of results rather than scanning tables. Secrets are never selected: the
 * projection below is the only thing that can reach a browser.
 */

export interface SearchHit {
  type: "device" | "user" | "node" | "config" | "receipt" | "policy" | "session" | "audit" | "quota" | "notification";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
  meta: Array<{ label: string; value: string }>;
}

export interface SearchResult {
  query: string;
  results: SearchHit[];
  total: number;
  searchedTypes: string[];
}

const PER_TYPE = 5;
const MIN_QUERY = 2;

export async function searchEverything(rawQuery: string): Promise<SearchResult> {
  const query = (rawQuery ?? "").trim();
  if (query.length < MIN_QUERY) {
    return { query, results: [], total: 0, searchedTypes: [] };
  }

  const contains = (value: string) => ({ contains: query, mode: "insensitive" as const });

  const [devices, users, nodes, configs, receipts, policies, sessions, audits, quotas, notifications] =
    await Promise.all([
      prisma.device.findMany({
        where: { OR: [{ displayName: contains(query) }, { deviceId: contains(query) }, { client: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, displayName: true, deviceId: true, connectionStatus: true, approvalState: true },
      }),
      prisma.adminUser.findMany({
        where: { OR: [{ username: contains(query) }, { displayName: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, username: true, displayName: true, role: true, status: true },
      }),
      prisma.vpnNode.findMany({
        where: { OR: [{ name: contains(query) }, { nodeId: contains(query) }, { publicEndpoint: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, name: true, nodeId: true, protocol: true, health: true },
      }),
      prisma.vpnConfig.findMany({
        where: { OR: [{ name: contains(query) }, { id: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, name: true, status: true, protocol: true, version: true },
      }),
      prisma.receipt.findMany({
        where: { OR: [{ receiptNumber: contains(query) }, { customerName: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, receiptNumber: true, customerName: true, simulatedTotal: true, currency: true, status: true },
      }),
      prisma.policy.findMany({
        where: { OR: [{ name: contains(query) }, { description: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, name: true, status: true, priority: true, targetKind: true },
      }),
      prisma.vpnSession.findMany({
        where: { gatewaySessionId: contains(query) },
        take: PER_TYPE,
        select: { id: true, gatewaySessionId: true, startedAt: true, endedAt: true, deviceId: true },
      }),
      prisma.auditLog.findMany({
        where: { OR: [{ action: contains(query) }, { resource: contains(query) }, { actorLabel: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, ts: true, action: true, resource: true, result: true, actorLabel: true },
      }),
      prisma.quota.findMany({
        where: { OR: [{ label: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, label: true, scope: true, limitBytes: true, usedBytes: true },
      }),
      prisma.notification.findMany({
        where: { OR: [{ title: contains(query) }, { body: contains(query) }] },
        take: PER_TYPE,
        select: { id: true, title: true, type: true, createdAt: true, readAt: true },
      }),
    ]);

  const results: SearchHit[] = [];

  for (const row of devices) {
    results.push({
      type: "device",
      id: row.id,
      title: row.displayName,
      subtitle: row.deviceId,
      href: `/devices?highlight=${row.id}`,
      meta: [
        { label: "Status", value: row.connectionStatus },
        { label: "Approval", value: row.approvalState },
      ],
    });
  }
  for (const row of users) {
    results.push({
      type: "user",
      id: row.id,
      title: row.username,
      subtitle: row.displayName,
      href: `/settings?highlight=${row.id}`,
      meta: [
        { label: "Role", value: row.role },
        { label: "Status", value: row.status },
      ],
    });
  }
  for (const row of nodes) {
    results.push({
      type: "node",
      id: row.id,
      title: row.name,
      subtitle: row.nodeId,
      href: `/nodes?highlight=${row.id}`,
      meta: [
        { label: "Protocol", value: row.protocol },
        { label: "Health", value: row.health },
      ],
    });
  }
  for (const row of configs) {
    results.push({
      type: "config",
      id: row.id,
      title: row.name,
      subtitle: `v${row.version}`,
      href: `/configurations?highlight=${row.id}`,
      meta: [
        { label: "Status", value: row.status },
        { label: "Protocol", value: row.protocol },
      ],
    });
  }
  for (const row of receipts) {
    results.push({
      type: "receipt",
      id: row.id,
      title: row.receiptNumber,
      subtitle: row.customerName,
      href: `/receipts?highlight=${row.id}`,
      meta: [
        { label: "Total", value: `${row.simulatedTotal} ${row.currency}` },
        { label: "Status", value: row.status },
      ],
    });
  }
  for (const row of policies) {
    results.push({
      type: "policy",
      id: row.id,
      title: row.name,
      subtitle: row.targetKind,
      href: `/policies?highlight=${row.id}`,
      meta: [
        { label: "Status", value: row.status },
        { label: "Priority", value: String(row.priority) },
      ],
    });
  }
  for (const row of sessions) {
    results.push({
      type: "session",
      id: row.id,
      title: row.gatewaySessionId,
      subtitle: row.deviceId,
      href: `/devices?highlight=${row.deviceId}`,
      meta: [
        { label: "Started", value: row.startedAt.toISOString() },
        { label: "Ended", value: row.endedAt ? row.endedAt.toISOString() : "open" },
      ],
    });
  }
  for (const row of audits) {
    results.push({
      type: "audit",
      id: row.id,
      title: row.action,
      subtitle: row.resource,
      href: `/audit?highlight=${row.id}`,
      meta: [
        { label: "Result", value: row.result },
        { label: "Actor", value: row.actorLabel },
        { label: "When", value: row.ts.toISOString() },
      ],
    });
  }
  for (const row of quotas) {
    results.push({
      type: "quota",
      id: row.id,
      title: row.label,
      subtitle: row.scope,
      href: `/quota?highlight=${row.id}`,
      meta: [
        { label: "Used", value: row.usedBytes.toString() },
        { label: "Limit", value: row.limitBytes.toString() },
      ],
    });
  }
  for (const row of notifications) {
    results.push({
      type: "notification",
      id: row.id,
      title: row.title,
      subtitle: row.type,
      href: `/overview?highlight=${row.id}`,
      meta: [
        { label: "When", value: row.createdAt.toISOString() },
        { label: "State", value: row.readAt ? "read" : "unread" },
      ],
    });
  }

  return {
    query,
    results,
    total: results.length,
    searchedTypes: [
      "device",
      "user",
      "node",
      "config",
      "receipt",
      "policy",
      "session",
      "audit",
      "quota",
      "notification",
    ],
  };
}
