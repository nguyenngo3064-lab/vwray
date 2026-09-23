import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { resolveRange } from "@/server/lib/time";
import { errors } from "@/server/lib/errors";

/**
 * Traffic heatmap.
 *
 * Built exclusively from `TrafficAggregate` rows that exist. Cells with no rows are
 * returned with `level: null` so the UI can render an empty cell instead of a coloured
 * zero - a heatmap that colourises "no data" as "low" is a lie told with colour.
 *
 * Levels are relative to THIS query's own distribution (quantiles of non-empty cells),
 * which is what makes "low / medium / high / peak" meaningful across ranges of very
 * different absolute volume.
 */

export type HeatmapDimension = "hour" | "day" | "device" | "node" | "user";
export type HeatmapLevel = "low" | "medium" | "high" | "peak";

export interface HeatmapCell {
  row: string;
  col: string;
  bytes: string;
  level: HeatmapLevel | null;
}

export interface HeatmapResult {
  dim: HeatmapDimension;
  range: { start: string; end: string; preset: string; granularity: "HOUR" | "DAY" };
  rows: Array<{ id: string; label: string; bytes: string }>;
  cols: Array<{ id: string; label: string }>;
  cells: HeatmapCell[];
  totalBytes: string;
  empty: boolean;
  reason: string | null;
  ignoredFilters: Array<{ filter: string; value: string; reason: string }>;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

async function labelLookup(prefix: "device" | "node" | "user", ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  if (prefix === "device") {
    const rows = await prisma.device.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true } });
    return new Map(rows.map((row) => [row.id, row.displayName]));
  }
  if (prefix === "node") {
    const rows = await prisma.vpnNode.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((row) => [row.id, row.name]));
  }
  const rows = await prisma.adminUser.findMany({ where: { id: { in: ids } }, select: { id: true, username: true } });
  return new Map(rows.map((row) => [row.id, row.username]));
}

export async function trafficHeatmap(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  dim?: string | null;
  deviceId?: string | null;
  nodeId?: string | null;
  userId?: string | null;
  source?: "REAL" | "MOCK" | "ALL" | null;
}): Promise<HeatmapResult> {
  const dim = (input.dim ?? "hour") as HeatmapDimension;
  if (!["hour", "day", "device", "node", "user"].includes(dim)) {
    throw errors.validation("Unknown heatmap dimension.", { allowed: ["hour", "day", "device", "node", "user"] });
  }

  const range = resolveRange({ preset: input.preset ?? "7d", from: input.from, to: input.to });
  if (!range) throw errors.validation("The requested time range is invalid.");
  const granularity = dim === "hour" || dim === "day" ? (dim === "hour" ? "HOUR" : "DAY") : "HOUR";

  const dimKeyPrefix =
    input.deviceId ? "device" : input.nodeId ? "node" : input.userId ? "user" : null;
  const dimKeyValue = input.deviceId ?? input.nodeId ?? input.userId ?? null;

  const where: Prisma.TrafficAggregateWhereInput = {
    bucketStart: { gte: range.start, lt: range.end },
    ...(input.source && input.source !== "ALL" ? { source: input.source } : {}),
    ...(dimKeyValue && dimKeyPrefix ? { dimKey: `${dimKeyPrefix}:${dimKeyValue}` } : {}),
    // For entity rows, only that dimension's hub rows; for hour/day use the system hub so
    // a cell is not the sum of the same traffic counted once per dimension.
    ...(dim === "hour" || dim === "day" ? (dimKeyValue ? {} : { dimKey: "system" }) : {}),
  };

  const rows = await prisma.trafficAggregate.findMany({
    where,
    select: { bucketStart: true, granularity: true, dimKey: true, deviceId: true, nodeId: true, userId: true, bytes: true },
    take: 200_000,
  });

  const ignoredFilters: HeatmapResult["ignoredFilters"] = [];
  if ((input.deviceId ? 1 : 0) + (input.nodeId ? 1 : 0) + (input.userId ? 1 : 0) > 1) {
    ignoredFilters.push({
      filter: "multiple entity filters",
      value: "device+node+user",
      reason: "Aggregates are stored per dimension, so a heatmap cell combines one dimension only.",
    });
  }

  const cellMap = new Map<string, { bytes: bigint; row: string; col: string }>();
  const rowTotals = new Map<string, bigint>();
  let total = 0n;

  const entityPrefix = dim === "device" ? "device" : dim === "node" ? "node" : dim === "user" ? "user" : null;

  for (const row of rows) {
    const bytes = row.bytes;
    let rowKey: string | null = null;
    let colKey: string | null = null;

    if (dim === "hour") {
      const date = new Date(row.bucketStart);
      const hour = String(date.getUTCHours()).padStart(2, "0");
      const day = date.toISOString().slice(0, 10);
      rowKey = day;
      colKey = hour;
    } else if (dim === "day") {
      const date = new Date(row.bucketStart);
      rowKey = DAYS[(date.getUTCDay() + 6) % 7];
      colKey = date.toISOString().slice(0, 10);
    } else if (entityPrefix) {
      if (row.dimKey.startsWith(`${entityPrefix}:`)) {
        rowKey = row.dimKey.slice(entityPrefix.length + 1);
        const date = new Date(row.bucketStart);
        colKey = `${date.toISOString().slice(0, 10)}T${String(date.getUTCHours()).padStart(2, "0")}:00`;
      }
    }

    if (!rowKey || !colKey) continue;
    const key = `${rowKey}\u0000${colKey}`;
    const existing = cellMap.get(key);
    if (existing) existing.bytes += bytes;
    else cellMap.set(key, { bytes, row: rowKey, col: colKey });

    rowTotals.set(rowKey, (rowTotals.get(rowKey) ?? 0n) + bytes);
    total += bytes;
  }

  const empty = cellMap.size === 0;
  const nonEmptyBytes = [...cellMap.values()].map((entry) => Number(entry.bytes)).sort((a, b) => a - b);
  const quantile = (q: number): number => {
    if (nonEmptyBytes.length === 0) return 0;
    const index = Math.min(nonEmptyBytes.length - 1, Math.floor(q * nonEmptyBytes.length));
    return nonEmptyBytes[index];
  };
  const q25 = quantile(0.25);
  const q50 = quantile(0.5);
  const q75 = quantile(0.75);

  const levelOf = (value: number): HeatmapLevel => {
    if (value <= q25) return "low";
    if (value <= q50) return "medium";
    if (value <= q75) return "high";
    return "peak";
  };

  // Row/column axis definitions.
  let rowAxis: Array<{ id: string; label: string }>;
  let colAxis: Array<{ id: string; label: string }>;

  if (dim === "hour") {
    const days = [...new Set([...cellMap.values()].map((entry) => entry.row))].sort();
    rowAxis = days.map((day) => ({ id: day, label: day }));
    colAxis = Array.from({ length: 24 }, (_, hour) => ({
      id: String(hour).padStart(2, "0"),
      label: `${String(hour).padStart(2, "0")}:00`,
    }));
  } else if (dim === "day") {
    rowAxis = DAYS.map((day) => ({ id: day, label: day }));
    colAxis = [...new Set([...cellMap.values()].map((entry) => entry.col))].sort().map((day) => ({ id: day, label: day }));
  } else if (entityPrefix) {
    const ids = [...rowTotals.keys()];
    const labels = await labelLookup(entityPrefix, ids);
    rowAxis = ids
      .map((id) => ({ id, label: labels.get(id) ?? `(${entityPrefix} ${id.slice(0, 8)})` }))
      .sort((left, right) => {
        const delta = (rowTotals.get(right.id) ?? 0n) - (rowTotals.get(left.id) ?? 0n);
        return delta > 0n ? 1 : delta < 0n ? -1 : 0;
      });
    colAxis = [...new Set([...cellMap.values()].map((entry) => entry.col))].sort().map((hour) => ({
      id: hour,
      label: hour.replace("T", " "),
    }));
  } else {
    rowAxis = [];
    colAxis = [];
  }

  const rowTotalsBytes = new Map<string, string>();
  for (const [key, value] of rowTotals) rowTotalsBytes.set(key, value.toString());

  return {
    dim,
    range: { start: range.start.toISOString(), end: range.end.toISOString(), preset: input.preset ?? "7d", granularity },
    rows: rowAxis.map((entry) => ({ ...entry, bytes: rowTotalsBytes.get(entry.id) ?? "0" })),
    cols: colAxis,
    cells: [...cellMap.values()].map((entry) => ({
      row: entry.row,
      col: entry.col,
      bytes: entry.bytes.toString(),
      level: levelOf(Number(entry.bytes)),
    })),
    totalBytes: total.toString(),
    empty,
    reason: empty ? "No traffic recorded in this range." : null,
    ignoredFilters,
  };
}

/** Drill-down for one cell: what, when, and which devices/nodes produced the bytes. */
export async function heatmapCell(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  dim?: string | null;
  row: string;
  col: string;
}): Promise<{
  ts: string | null;
  label: { row: string; col: string };
  bytes: string;
  devices: Array<{ id: string; label: string; bytes: string }>;
  nodes: Array<{ id: string; label: string; bytes: string }>;
  users: Array<{ id: string; label: string; bytes: string }>;
  available: boolean;
  reason: string | null;
}> {
  const dim = (input.dim ?? "hour") as HeatmapDimension;
  const range = resolveRange({ preset: input.preset ?? "7d", from: input.from, to: input.to });
  if (!range) throw errors.validation("The requested time range is invalid.");

  // Resolve the cell back to a concrete window where the dimension allows it.
  let cellStart = range.start;
  let cellEnd = range.end;
  if (dim === "hour") {
    cellStart = new Date(`${input.row}T${input.col.padStart(2, "0")}:00:00.000Z`);
    cellEnd = new Date(cellStart.getTime() + 3_600_000);
  } else if (dim === "day") {
    cellStart = new Date(`${input.col}T00:00:00.000Z`);
    cellEnd = new Date(cellStart.getTime() + 86_400_000);
  }
  if (Number.isNaN(cellStart.getTime()) || cellStart < range.start || cellStart > range.end) {
    cellStart = range.start;
    cellEnd = range.end;
  }

  const rows = await prisma.trafficAggregate.findMany({
    where: { bucketStart: { gte: cellStart, lt: cellEnd } },
    select: { dimKey: true, deviceId: true, nodeId: true, userId: true, bytes: true },
    take: 100_000,
  });

  const byDevice = new Map<string, bigint>();
  const byNode = new Map<string, bigint>();
  const byUser = new Map<string, bigint>();
  let total = 0n;
  for (const row of rows) {
    if (row.dimKey.startsWith("device:")) {
      const id = row.dimKey.slice(7);
      byDevice.set(id, (byDevice.get(id) ?? 0n) + row.bytes);
    } else if (row.dimKey.startsWith("node:")) {
      const id = row.dimKey.slice(5);
      byNode.set(id, (byNode.get(id) ?? 0n) + row.bytes);
    } else if (row.dimKey.startsWith("user:")) {
      const id = row.dimKey.slice(5);
      byUser.set(id, (byUser.get(id) ?? 0n) + row.bytes);
    } else if (row.dimKey === "system") {
      total += row.bytes;
    }
  }
  if (total === 0n) {
    for (const value of byDevice.values()) total += value;
  }

  const deviceLabels = await labelLookup("device", [...byDevice.keys()]);
  const nodeLabels = await labelLookup("node", [...byNode.keys()]);
  const userLabels = await labelLookup("user", [...byUser.keys()]);

  const mapTo = (values: Map<string, bigint>, labels: Map<string, string>, fallback: string) =>
    [...values.entries()]
      .sort((a, b) => (b[1] > a[1] ? 1 : -1))
      .map(([id, bytes]) => ({ id, label: labels.get(id) ?? `(${fallback} ${id.slice(0, 8)})`, bytes: bytes.toString() }));

  const empty = total === 0n;
  return {
    ts: cellStart.toISOString(),
    label: { row: input.row, col: input.col },
    bytes: total.toString(),
    devices: mapTo(byDevice, deviceLabels, "device"),
    nodes: mapTo(byNode, nodeLabels, "node"),
    users: mapTo(byUser, userLabels, "user"),
    available: !empty,
    reason: empty ? "No traffic recorded for this cell." : null,
  };
}
