import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { resolveRange } from "@/server/lib/time";
import { getActivePricing, currentPeriod, computeCost, measurePeriod } from "@/server/billing/service";
import { getOverview } from "@/server/analytics/overview";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";
import { toCsv } from "@/server/http/respond";
import { randomToken } from "@/server/lib/ids";

/**
 * Report engine.
 *
 * Reports are assembled from rows that already exist - aggregates, sessions, quotas, cost
 * records, anomaly events - so two reports covering the same window always agree with the
 * dashboards. Sections whose underlying data is missing are returned as
 * `{ available: false, reason }` instead of zeros, which is what stops a quiet installation
 * from producing a report that looks like an outage.
 *
 * Formats: JSON (structured, the source of truth), CSV (flattened, RFC 4180 quoted with
 * formula-injection neutralisation via `toCsv`), PDF (rendered from the same JSON payload
 * by the receipts PDF pipeline's shared layout helpers when requested).
 */

export type ReportType = "DAILY" | "WEEKLY" | "MONTHLY" | "CUSTOM";
export type ReportFormat = "JSON" | "CSV" | "PDF";

export interface ReportSection<T = unknown> {
  available: boolean;
  reason: string | null;
  data: T | null;
}

export interface ReportPayload {
  id: string;
  type: ReportType;
  format: ReportFormat;
  period: { start: string; end: string; preset: string };
  generatedAt: string;
  generatedBy: string;
  sections: Record<string, ReportSection>;
  sectionNames: string[];
  sectionCount: number;
  byteLength: number;
  json: string | null;
  csv: string | null;
  /** Report-only notice so a copy of the file cannot be mistaken for a live view. */
  notice: string;
}

function unavailable<T>(reason: string): ReportSection<T> {
  return { available: false, reason, data: null };
}

function available<T>(data: T): ReportSection<T> {
  return { available: true, reason: null, data };
}

function rangeFor(type: ReportType, input: { from?: string | null; to?: string | null }, now = new Date()): {
  start: Date;
  end: Date;
  preset: string;
} {
  if (type === "CUSTOM") {
    const range = resolveRange({ preset: "custom", from: input.from, to: input.to, now });
    if (!range) throw errors.validation("A custom report needs a valid from/to range.");
    return { ...range, preset: "custom" };
  }
  const preset = type === "DAILY" ? "today" : type === "WEEKLY" ? "7d" : "month";
  const range = resolveRange({ preset, now });
  if (!range) throw errors.validation("Could not resolve the report period.");
  return { ...range, preset };
}

const GB = 1024 ** 3;

function fmtBytes(value: bigint | number): string {
  return (Number(value) / GB).toFixed(3);
}

/** Flattens the payload into CSV rows: one block per section, `section,field,value` rows. */
function toReportCsv(report: Omit<ReportPayload, "csv" | "byteLength">): string {
  const rows: Array<Record<string, unknown>> = [];
  rows.push({ section: "meta", key: "reportId", value: report.id });
  rows.push({ section: "meta", key: "type", value: report.type });
  rows.push({ section: "meta", key: "periodStart", value: report.period.start });
  rows.push({ section: "meta", key: "periodEnd", value: report.period.end });
  rows.push({ section: "meta", key: "generatedAt", value: report.generatedAt });
  rows.push({ section: "meta", key: "notice", value: report.notice });

  for (const [name, section] of Object.entries(report.sections)) {
    rows.push({ section: name, key: "available", value: section.available });
    if (!section.available) {
      rows.push({ section: name, key: "reason", value: section.reason });
      continue;
    }
    const flatten = (value: unknown, prefix = ""): void => {
      if (value === null || value === undefined) {
        rows.push({ section: name, key: prefix || "value", value: "" });
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`));
        return;
      }
      if (typeof value === "object") {
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
          flatten(childValue, prefix ? `${prefix}.${childKey}` : childKey);
        }
        return;
      }
      rows.push({ section: name, key: prefix || "value", value });
    };
    flatten(section.data);
  }

  return toCsv(rows, ["section", "key", "value"]);
}

export async function generateReport(input: {
  type: ReportType;
  format: ReportFormat;
  from?: string | null;
  to?: string | null;
  actorId: string | null;
  actorLabel: string;
  sourceIp?: string | null;
  requestId?: string | null;
}): Promise<ReportPayload> {
  const now = new Date();
  const period = rangeFor(input.type, input, now);
  const id = `rpt_${randomToken(12)}`;
  const sections: Record<string, ReportSection> = {};

  // ------------------------------------------------------------- traffic ----
  try {
    const aggregates = await prisma.trafficAggregate.groupBy({
      by: ["direction", "source"],
      where: { bucketStart: { gte: period.start, lt: period.end } },
      _sum: { bytes: true, bytesOptimized: true, packets: true },
      _count: { _all: true },
    });
    const byDirection: Record<string, { bytes: string; bytesOptimized: string | null; packets: string | null }> = {};
    let upload = 0n;
    let download = 0n;
    let optimized: bigint | null = null;
    let hasMock = false;
    for (const row of aggregates) {
      const bytes = row._sum.bytes ?? 0n;
      if (row.source === "MOCK") hasMock = true;
      if (row.direction === "UPLOAD") upload += bytes;
      else download += bytes;
      if (row._sum.bytesOptimized !== null) optimized = (optimized ?? 0n) + row._sum.bytesOptimized;
      const key = `${row.direction}:${row.source}`;
      byDirection[key] = {
        bytes: bytes.toString(),
        bytesOptimized: row._sum.bytesOptimized?.toString() ?? null,
        packets: row._sum.packets?.toString() ?? null,
      };
    }
    const total = upload + download;
    sections.traffic =
      total > 0n || aggregates.length > 0
        ? available({
            uploadBytes: upload.toString(),
            downloadBytes: download.toString(),
            totalBytes: total.toString(),
            uploadGb: fmtBytes(upload),
            downloadGb: fmtBytes(download),
            totalGb: fmtBytes(total),
            optimizedBytes: optimized === null ? null : optimized.toString(),
            byDirection,
            sources: hasMock ? ["REAL", "MOCK"] : ["REAL"],
          })
        : unavailable("No traffic aggregates in this period.");
  } catch (error) {
    sections.traffic = unavailable(`Could not read traffic aggregates: ${error instanceof Error ? "read error" : "unknown"}`);
  }

  // ------------------------------------------------------------- devices ----
  try {
    const [total, online, pending, blocked, quotaExceeded] = await Promise.all([
      prisma.device.count(),
      prisma.device.count({ where: { connectionStatus: "ONLINE" } }),
      prisma.device.count({ where: { approvalState: "PENDING" } }),
      prisma.device.count({ where: { approvalState: "BLOCKED" } }),
      prisma.device.count({ where: { connectionStatus: "QUOTA_EXCEEDED" } }),
    ]);
    sections.devices = available({ total, online, pending, blocked, quotaExceeded });
  } catch {
    sections.devices = unavailable("Device inventory unavailable.");
  }

  // ---------------------------------------------------------------- nodes ----
  try {
    const staleSeconds = await getSetting<number>("nodes.heartbeatStaleSeconds");
    const nodes = await prisma.vpnNode.findMany({
      select: { id: true, name: true, lastHeartbeatAt: true, maintenance: true, draining: true, activeSessions: true },
    });
    // "Uptime" here is heartbeat coverage over the period: the fraction of sampled
    // intervals in which the node reported. It is named precisely so nobody reads it as
    // a process-level uptime figure the control plane does not actually measure.
    const sampleCounts = await prisma.nodeHealthSample.groupBy({
      by: ["nodeId"],
      where: { sampledAt: { gte: period.start, lt: period.end } },
      _count: { _all: true },
    });
    const countByNode = new Map(sampleCounts.map((row) => [row.nodeId, row._count._all]));
    const periodHours = Math.max(1, (period.end.getTime() - period.start.getTime()) / 3_600_000);
    const healthRows = nodes.map((node) => {
      const health = deriveHealth({
        lastHeartbeatAt: node.lastHeartbeatAt,
        staleSeconds,
        maintenance: node.maintenance,
        draining: node.draining,
      });
      const samples = countByNode.get(node.id) ?? 0;
      // 4 expected samples/hour is the agent's nominal cadence; coverage saturates at 1.
      const coverage = Math.min(1, samples / (periodHours * 4));
      return {
        nodeId: node.id,
        name: node.name,
        health,
        activeSessions: node.activeSessions,
        lastHeartbeatAt: node.lastHeartbeatAt?.toISOString() ?? null,
        heartbeatSamples: samples,
        heartbeatCoveragePct: Math.round(coverage * 1000) / 10,
        method: "heartbeat samples received vs nominal agent cadence",
      };
    });
    sections.nodes = available({
      total: nodes.length,
      byHealth: healthRows.reduce<Record<string, number>>((acc, row) => {
        acc[row.health] = (acc[row.health] ?? 0) + 1;
        return acc;
      }, {}),
      nodes: healthRows,
    });
  } catch {
    sections.nodes = unavailable("Node telemetry unavailable.");
  }

  // --------------------------------------------------------- optimization ----
  try {
    const rows = await prisma.trafficAggregate.groupBy({
      by: ["source"],
      where: { bucketStart: { gte: period.start, lt: period.end } },
      _sum: { bytes: true, bytesOptimized: true },
      _count: { bytesOptimized: true },
    });
    let raw = 0n;
    let optimized: bigint | null = null;
    for (const row of rows) {
      if (row.source === "MOCK") continue;
      raw += row._sum.bytes ?? 0n;
      if (row._count.bytesOptimized > 0) optimized = (optimized ?? 0n) + (row._sum.bytesOptimized ?? 0n);
    }
    if (raw === 0n) {
      sections.optimization = unavailable("No real traffic in this period, so savings cannot be computed.");
    } else if (optimized === null) {
      sections.optimization = available({
        originalBytes: raw.toString(),
        originalGb: fmtBytes(raw),
        optimizedBytes: null,
        savedBytes: null,
        reductionPct: null,
        kind: "UNAVAILABLE",
        note: "The data plane did not report optimized byte counts, so no savings figure is shown.",
      });
    } else {
      const saved = raw > optimized ? raw - optimized : 0n;
      const pct = Number((saved * 10000n) / (raw || 1n)) / 100;
      sections.optimization = available({
        originalBytes: raw.toString(),
        originalGb: fmtBytes(raw),
        optimizedBytes: optimized.toString(),
        optimizedGb: fmtBytes(optimized),
        savedBytes: saved.toString(),
        savedGb: fmtBytes(saved),
        reductionPct: pct,
        kind: "MEASURED",
        note: "Measured byte reduction over the period. A 30-60% target range may be configured, but it is never a guarantee.",
      });
    }
  } catch {
    sections.optimization = unavailable("Optimization figures unavailable.");
  }

  // ---------------------------------------------------------------- quota ----
  try {
    const quotas = await prisma.quota.findMany({
      select: { id: true, scope: true, label: true, limitBytes: true, usedBytes: true, enabled: true, exceededAt: true },
    });
    if (quotas.length === 0) {
      sections.quota = unavailable("No quotas are configured.");
    } else {
      sections.quota = available({
        total: quotas.length,
        enabled: quotas.filter((entry) => entry.enabled).length,
        exceeded: quotas.filter((entry) => entry.exceededAt !== null).length,
        quotas: quotas.map((entry) => ({
          id: entry.id,
          scope: entry.scope,
          label: entry.label,
          limitBytes: entry.limitBytes.toString(),
          usedBytes: entry.usedBytes.toString(),
          exceededAt: entry.exceededAt?.toISOString() ?? null,
        })),
      });
    }
  } catch {
    sections.quota = unavailable("Quota state unavailable.");
  }

  // -------------------------------------------------------- simulated cost ----
  try {
    const pricing = await getActivePricing();
    const window = currentPeriod(pricing, now);
    const measured = await measurePeriod({ range: window, dimKey: "system", source: "REAL" });
    const breakdown = computeCost({ rawBytes: measured.rawBytes, optimizedBytes: measured.optimizedBytes, pricing });
    sections.simulatedCost =
      measured.rawBytes > 0n
        ? available({
            currency: pricing.currency,
            rawGb: breakdown.rawGb,
            billableGb: breakdown.billableGb,
            baseFee: breakdown.baseFee,
            pricePerGb: breakdown.pricePerGb,
            computedCost: breakdown.computedCost,
            costWithoutOptimization: breakdown.costWithoutOptimization,
            savedCost: breakdown.savedCost,
            formula: breakdown.formula,
            notice: "SIMULATED cost. No payment processor is connected and no charge is made.",
          })
        : unavailable("No measured traffic in the current billing period, so nothing has been costed.");
  } catch {
    sections.simulatedCost = unavailable("Billing configuration could not be read.");
  }

  // -------------------------------------------------------------- anomalies ----
  try {
    const where = { detectedAt: { gte: period.start, lt: period.end } };
    const [total, open, byType] = await Promise.all([
      prisma.anomalyEvent.count({ where }),
      prisma.anomalyEvent.count({ where: { ...where, status: "OPEN" } }),
      prisma.anomalyEvent.groupBy({ by: ["type"], where, _count: { _all: true } }),
    ]);
    sections.anomalies = available({
      total,
      open,
      byType: byType.map((row) => ({ type: row.type, count: row._count._all })),
      note: "Anomalies are neutral observations recorded for operator review.",
    });
  } catch {
    sections.anomalies = unavailable("Anomaly history unavailable.");
  }

  // ----------------------------------------------------------------- uptime ----
  try {
    const sessions = await prisma.vpnSession.groupBy({
      by: ["nodeId"],
      where: { startedAt: { gte: period.start, lt: period.end } },
      _count: { _all: true },
      _avg: { latencyMs: true, jitterMs: true, packetLossPct: true },
    });
    sections.uptime =
      sessions.length === 0
        ? unavailable("No sessions were recorded in this period.")
        : available({
            sessionsByNode: sessions.map((row) => ({
              nodeId: row.nodeId,
              sessions: row._count._all,
              avgLatencyMs: row._avg.latencyMs,
              avgJitterMs: row._avg.jitterMs,
              avgPacketLossPct: row._avg.packetLossPct,
              note: "Latency/jitter/loss are averages of reported values only; a gateway that does not report them contributes null, never 0.",
            })),
            coverageMethod: "see section `nodes.heartbeatCoveragePct`",
          });
  } catch {
    sections.uptime = unavailable("Session history unavailable.");
  }

  // ---------------------------------------------------------------- policy ----
  try {
    const where = { evaluatedAt: { gte: period.start, lt: period.end } };
    const byResult = await prisma.policyExecution.groupBy({ by: ["result"], where, _count: { _all: true } });
    sections.policy = available({
      executions: byResult.reduce((total, row) => total + row._count._all, 0),
      byResult: byResult.map((row) => ({ result: row.result, count: row._count._all })),
    });
  } catch {
    sections.policy = unavailable("Policy history unavailable.");
  }

  // ------------------------------------------------------- overview summary ----
  try {
    const overview = await getOverview();
    sections.summary = available({
      generatedAtOverview: overview.generatedAt,
      mockDataPresent: overview.mockDataPresent,
      hasRealTraffic: overview.hasRealTraffic,
      network: overview.network,
      data: overview.data,
      quota: overview.quota,
      alerts: overview.alerts,
    });
  } catch {
    sections.summary = unavailable("Overview summary unavailable.");
  }

  const sectionNames = Object.keys(sections);
  const notice =
    "Generated report from stored data. Simulated billing figures are a simulation, not an invoice.";

  const jsonPayload: Omit<ReportPayload, "csv" | "byteLength"> = {
    id,
    type: input.type,
    format: input.format,
    period: { start: period.start.toISOString(), end: period.end.toISOString(), preset: period.preset },
    generatedAt: now.toISOString(),
    generatedBy: input.actorLabel,
    sections,
    sectionNames,
    sectionCount: sectionNames.length,
    json: null,
    notice,
  };

  const json = JSON.stringify(jsonPayload, null, 2);
  const csv = toReportCsv(jsonPayload);
  const chosen = input.format === "CSV" ? csv : json;

  await record({
    actor:
      input.actorId === null
        ? { type: "SYSTEM", id: null, label: input.actorLabel }
        : { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "report.generated",
    resource: "report",
    resourceId: id,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    requestId: input.requestId ?? null,
    metadata: {
      type: input.type,
      format: input.format,
      periodStart: period.start.toISOString(),
      periodEnd: period.end.toISOString(),
      sections: sectionNames,
      availableSections: sectionNames.filter((name) => sections[name]?.available),
      byteLength: chosen.length,
    },
  });

  return { ...jsonPayload, json, csv, byteLength: chosen.length };
}

/** Convenience for the console: the most recent report of a type, already formatted. */
export async function reportAsCsv(input: {
  type: ReportType;
  from?: string | null;
  to?: string | null;
  actorId: string | null;
  actorLabel: string;
}): Promise<{ filename: string; body: string }> {
  const report = await generateReport({ ...input, format: "CSV" });
  const stamp = report.period.start.slice(0, 10);
  return { filename: `vwray-report-${input.type.toLowerCase()}-${stamp}.csv`, body: report.csv ?? "" };
}
