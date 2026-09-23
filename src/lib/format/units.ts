/**
 * Byte, rate and ratio formatting.
 *
 * These helpers exist to make one requirement mechanical: a value that could not be
 * measured must never render as `0`. Every function here accepts `null` and returns
 * the literal string "Unavailable" instead of a number, so a missing measurement
 * cannot be mistaken for a real zero somewhere in the UI.
 */

export const BYTES_PER_KB = 1024;
export const BYTES_PER_MB = 1024 ** 2;
export const BYTES_PER_GB = 1024 ** 3;
export const BYTES_PER_TB = 1024 ** 4;

export const UNAVAILABLE = "Unavailable" as const;
export const NO_DATA = "No data available" as const;

const UNIT_STEPS: Array<{ limit: number; suffix: string; divisor: number }> = [
  { limit: BYTES_PER_TB, suffix: "TB", divisor: BYTES_PER_TB },
  { limit: BYTES_PER_GB, suffix: "GB", divisor: BYTES_PER_GB },
  { limit: BYTES_PER_MB, suffix: "MB", divisor: BYTES_PER_MB },
  { limit: BYTES_PER_KB, suffix: "KB", divisor: BYTES_PER_KB },
];

/** `1.42 GB`, `840 MB`, `0 B`. Null/undefined render as "Unavailable". */
export function formatBytes(value: bigint | number | null | undefined, precision = 2): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return UNAVAILABLE;
  if (numeric === 0) return "0 B";

  const negative = numeric < 0;
  const absolute = Math.abs(numeric);
  const step = UNIT_STEPS.find((candidate) => absolute >= candidate.limit);

  if (!step) return `${negative ? "-" : ""}${Math.round(absolute)} B`;
  const scaled = absolute / step.divisor;
  const decimals = scaled >= 100 ? 0 : precision;
  return `${negative ? "-" : ""}${scaled.toFixed(decimals)} ${step.suffix}`;
}

/** Decimal GB used for billing math display (1 GB = 1024^3 bytes). */
export function bytesToGigabytes(
  value: bigint | number | null | undefined,
  precision = 3,
): number | null {
  if (value === null || value === undefined) return null;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return null;
  const gb = numeric / BYTES_PER_GB;
  const factor = 10 ** precision;
  return Math.round(gb * factor) / factor;
}

export function gigabytesToBytes(gb: number): bigint {
  return BigInt(Math.round(gb * BYTES_PER_GB));
}

/**
 * Bits per second, the unit network operators expect. Stored values are bytes per
 * second, so they are converted before formatting.
 */
export function formatBitsPerSecond(bytesPerSecond: number | null | undefined, precision = 2): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return UNAVAILABLE;
  if (!Number.isFinite(bytesPerSecond)) return UNAVAILABLE;
  const bitsPerSecond = bytesPerSecond * 8;
  if (bitsPerSecond === 0) return "0 bps";

  const steps: Array<{ limit: number; suffix: string; divisor: number }> = [
    { limit: 1e9, suffix: "Gbps", divisor: 1e9 },
    { limit: 1e6, suffix: "Mbps", divisor: 1e6 },
    { limit: 1e3, suffix: "Kbps", divisor: 1e3 },
  ];
  const step = steps.find((candidate) => bitsPerSecond >= candidate.limit);
  if (!step) return `${Math.round(bitsPerSecond)} bps`;
  const scaled = bitsPerSecond / step.divisor;
  return `${scaled.toFixed(scaled >= 100 ? 0 : precision)} ${step.suffix}`;
}

/** Throughput the operator thinks in: `1.42 MB/s`. */
export function formatBytesPerSecond(bytesPerSecond: number | null | undefined, precision = 2): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined) return UNAVAILABLE;
  return `${formatBytes(bytesPerSecond, precision)}/s`;
}

/** `37.4%`. Null stays "Unavailable"; 0 renders as "0%". */
export function formatPercent(value: number | null | undefined, precision = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNAVAILABLE;
  return `${value.toFixed(precision)}%`;
}

export function formatCount(value: number | bigint | null | undefined): string {
  if (value === null || value === undefined) return UNAVAILABLE;
  const numeric = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isFinite(numeric)) return UNAVAILABLE;
  return numeric.toLocaleString("en-US");
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return UNAVAILABLE;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours === 0) return `${minutes} m`;
  return `${hours} h ${minutes} m`;
}

export function formatDurationBetween(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): string {
  if (!start) return UNAVAILABLE;
  const startDate = start instanceof Date ? start : new Date(start);
  const endDate = end ? (end instanceof Date ? end : new Date(end)) : new Date();
  const ms = endDate.getTime() - startDate.getTime();
  if (!Number.isFinite(ms) || ms < 0) return UNAVAILABLE;
  return formatDurationMs(ms);
}

/** Input accepted from quota/settings forms, without binary-unit mistakes. */
export function parseGigabytesToBytes(input: string | number | null | undefined): bigint | null {
  if (input === null || input === undefined || input === "") return null;
  const numeric = typeof input === "number" ? input : Number(input);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return gigabytesToBytes(numeric);
}

export function formatGb(value: number | string | null | undefined, precision = 3): string {
  if (value === null || value === undefined || value === "") return UNAVAILABLE;
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return UNAVAILABLE;
  return `${numeric.toFixed(precision)} GB`;
}

/**
 * Quota ratio as a 0-100 percentage. `null` means the ratio is undefined (a zero
 * limit), not zero usage.
 */
export function quotaPercent(
  usedBytes: bigint | number,
  limitBytes: bigint | number,
): number | null {
  const limit = typeof limitBytes === "bigint" ? Number(limitBytes) : limitBytes;
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const used = typeof usedBytes === "bigint" ? Number(usedBytes) : usedBytes;
  const percent = (used / limit) * 100;
  return Math.round(percent * 10) / 10;
}

/** Savings percentage, undefined when the original volume is zero. */
export function savingsPercent(
  originalBytes: bigint | number | null | undefined,
  optimizedBytes: bigint | number | null | undefined,
): number | null {
  if (originalBytes === null || originalBytes === undefined) return null;
  if (optimizedBytes === null || optimizedBytes === undefined) return null;
  const original = typeof originalBytes === "bigint" ? Number(originalBytes) : originalBytes;
  const optimized = typeof optimizedBytes === "bigint" ? Number(optimizedBytes) : optimizedBytes;
  if (!Number.isFinite(original) || !Number.isFinite(optimized) || original <= 0) return null;
  const percent = ((original - optimized) / original) * 100;
  return Math.round(percent * 10) / 10;
}

/**
 * Applies the brief's saving formula explicitly, so callers cannot accidentally
 * report a saving without the original volume that justifies it.
 */
export function applySavingFormula(
  originalBytes: bigint,
  optimizedBytes: bigint,
): { savedBytes: bigint; actualSavingPercent: number | null } {
  const savedBytes = originalBytes - optimizedBytes;
  const denominator = Number(originalBytes);
  const actualSavingPercent =
    denominator > 0 ? Math.round((Number(savedBytes) / denominator) * 1000) / 10 : null;
  return { savedBytes, actualSavingPercent };
}
