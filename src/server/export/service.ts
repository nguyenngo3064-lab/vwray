import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { resolveRange } from "@/server/lib/time";
import { toCsv } from "@/server/http/respond";
import { generateReport } from "@/server/reports/service";

/**
 * Export centre.
 *
 * One entry point for every CSV/JSON download in the console. Three guarantees:
 *
 *   1. Every select names its columns, so a key, hash, token or seal can never reach a
 *      spreadsheet by accident. If a column is not named below, it does not ship.
 *   2. CSV goes through `toCsv`, which quotes and neutralises formula injection.
 *   3. Every export is audited with the dataset, bounds and row count.
 */

export type ExportDataset = "traffic" | "devices" | "nodes" | "billing" | "receipts" | "optimization" | "audit" | "reports";
export type ExportFormat = "csv" | "json";

export const EXPORT_DATASETS: ExportDataset[] = [
  "traffic",
  "devices",
  "nodes",
  "billing",
  "receipts",
  "optimization",
  "audit",
  "reports",
];

export interface ExportResult {
  filename: string;
  contentType: string;
  body: string;
  rows: number;
  dataset: ExportDataset;
  format: ExportFormat;
}

const MAX_ROWS = 10_000;

type Row = Record<string, unknown>;

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function asRows(values: Row[]): Row[] {
  return values.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, stringify(value)])),
  );
}

async function trafficRows(range: { start: Date; end: Date }): Promise<Row[]> {
  const rows = await prisma.trafficAggregate.findMany({
    where: { bucketStart: { gte: range.start, lt: range.end } },
    orderBy: { bucketStart: "desc" },
    take: MAX_ROWS,
    select: {
      granularity: true,
      bucketStart: true,
      bucketEnd: true,
      dimKey: true,
      direction: true,
      bytes: true,
      bytesOptimized: true,
      packets: true,
      connections: true,
      source: true,
      category: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function deviceRows(): Promise<Row[]> {
  const rows = await prisma.device.findMany({
    take: MAX_ROWS,
    orderBy: { createdAt: "desc" },
    // No credentials, no sealed payloads, no tokens: the export projection is the allowlist.
    select: {
      deviceId: true,
      displayName: true,
      client: true,
      platform: true,
      connectionStatus: true,
      approvalState: true,
      securityState: true,
      uploadBytes: true,
      downloadBytes: true,
      quotaExceededAt: true,
      blockedAt: true,
      blockedReason: true,
      firstSeenAt: true,
      lastSeenAt: true,
      reconnectCount: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function nodeRows(): Promise<Row[]> {
  const rows = await prisma.vpnNode.findMany({
    take: MAX_ROWS,
    orderBy: { name: "asc" },
    select: {
      nodeId: true,
      name: true,
      location: true,
      provider: true,
      protocol: true,
      health: true,
      adapterKey: true,
      activeSessions: true,
      maxSessions: true,
      weight: true,
      draining: true,
      maintenance: true,
      lastHeartbeatAt: true,
      registeredAt: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function billingRows(): Promise<Row[]> {
  const rows = await prisma.costRecord.findMany({
    take: MAX_ROWS,
    orderBy: { computedAt: "desc" },
    select: {
      scope: true,
      label: true,
      periodStart: true,
      periodEnd: true,
      rawBytes: true,
      optimizedBytes: true,
      savedBytes: true,
      billableGb: true,
      baseFee: true,
      pricePerGb: true,
      computedCost: true,
      costWithoutOptimization: true,
      savedCost: true,
      currency: true,
      inputHash: true,
      source: true,
      computedAt: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function receiptRows(): Promise<Row[]> {
  const rows = await prisma.receipt.findMany({
    take: MAX_ROWS,
    orderBy: { generatedAt: "desc" },
    select: {
      receiptNumber: true,
      customerName: true,
      deviceId: true,
      periodStart: true,
      periodEnd: true,
      rawBytes: true,
      optimizedBytes: true,
      savedBytes: true,
      savingPct: true,
      savingsKind: true,
      pricePerGb: true,
      baseFee: true,
      billableGb: true,
      simulatedTotal: true,
      currency: true,
      verificationHash: true,
      providerLabel: true,
      status: true,
      source: true,
      generatedAt: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function optimizationRows(range: { start: Date; end: Date }): Promise<Row[]> {
  const rows = await prisma.optimizationRecord.findMany({
    where: { bucketStart: { gte: range.start, lt: range.end } },
    orderBy: { bucketStart: "desc" },
    take: MAX_ROWS,
    select: {
      granularity: true,
      bucketStart: true,
      bucketEnd: true,
      dimKey: true,
      originalBytes: true,
      optimizedBytes: true,
      savedBytes: true,
      savingPct: true,
      kind: true,
      estimationBasis: true,
      source: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

async function auditRows(range: { start: Date; end: Date }): Promise<Row[]> {
  const rows = await prisma.auditLog.findMany({
    where: { ts: { gte: range.start, lt: range.end } },
    orderBy: { ts: "desc" },
    take: MAX_ROWS,
    select: {
      ts: true,
      actorType: true,
      actorLabel: true,
      action: true,
      resource: true,
      resourceId: true,
      result: true,
      sourceIp: true,
    },
  });
  return asRows(rows.map((row) => ({ ...row })));
}

export async function exportDataset(input: {
  dataset: string;
  format: string;
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
  requestId?: string | null;
}): Promise<ExportResult> {
  const dataset = input.dataset.toLowerCase() as ExportDataset;
  if (!EXPORT_DATASETS.includes(dataset)) {
    throw errors.validation(`Unknown dataset. Choose one of: ${EXPORT_DATASETS.join(", ")}.`);
  }
  const format = input.format.toLowerCase();
  if (format !== "csv" && format !== "json") {
    throw errors.validation("Format must be csv or json.");
  }

  const range = resolveRange({ preset: input.preset ?? "7d", from: input.from, to: input.to }) ?? {
    start: new Date(0),
    end: new Date(),
  };

  let rows: Row[];
  if (dataset === "traffic") rows = await trafficRows(range);
  else if (dataset === "devices") rows = await deviceRows();
  else if (dataset === "nodes") rows = await nodeRows();
  else if (dataset === "billing") rows = await billingRows();
  else if (dataset === "receipts") rows = await receiptRows();
  else if (dataset === "optimization") rows = await optimizationRows(range);
  else if (dataset === "audit") rows = await auditRows(range);
  else {
    const report = await generateReport({
      type: "CUSTOM",
      format: "JSON",
      from: input.from ?? range.start.toISOString(),
      to: input.to ?? range.end.toISOString(),
      actorId: input.actorId,
      actorLabel: input.actorLabel,
    });
    rows = asRows([{ reportId: report.id, byteLength: report.byteLength, sections: report.sectionNames.join(";") }]);
  }

  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const body = format === "csv" ? toCsv(rows, columns) : JSON.stringify(rows, null, 2);
  const filename = `vwray-${dataset}-${range.start.toISOString().slice(0, 10)}.${format}`;

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "export.generated",
    resource: "export",
    resourceId: dataset,
    result: "SUCCESS",
    sourceIp: input.sourceIp ?? null,
    requestId: input.requestId ?? null,
    metadata: { dataset, format, rows: rows.length, from: range.start.toISOString(), to: range.end.toISOString() },
  });

  return {
    filename,
    contentType: format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
    body,
    rows: rows.length,
    dataset,
    format,
  };
}
