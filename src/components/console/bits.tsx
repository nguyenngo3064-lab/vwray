import type { ReactNode } from "react";
import { formatBytes, parseByteCount } from "@/lib/format/units";
import { UNAVAILABLE } from "@/lib/format/units";

/**
 * Small presentational pieces shared by the console pages.
 *
 * Server-safe (no "use client"): every component here is a pure function of its
 * props. The honesty rules are encoded once - a missing byte count renders
 * "Unavailable", a missing money figure renders "Unavailable", and the mock-data
 * badge only appears when an API response actually reports mock data.
 */

/** Rendered ONLY when an API response reports mock data. Never decorative. */
export function MockDataBadge({ show, className }: { show?: boolean | null; className?: string }) {
  if (!show) return null;
  return (
    <span className={`status status-warning ${className ?? ""}`} role="status">
      DEVELOPMENT MOCK DATA
    </span>
  );
}

/** Wire byte string (or null) with the shared "Unavailable" fallback. */
export function ByteValue({
  value,
  className,
  precision = 2,
}: {
  value: string | number | bigint | null | undefined;
  className?: string;
  precision?: number;
}) {
  const parsed = typeof value === "string" ? parseByteCount(value) : (value ?? null);
  const text = formatBytes(parsed ?? null, precision);
  if (text === UNAVAILABLE) return <span className={`unavailable ${className ?? ""}`}>{UNAVAILABLE}</span>;
  return <span className={`data-value ${className ?? ""}`}>{text}</span>;
}

/** Money figure; null/undefined render as "Unavailable", never as 0. */
export function Money({
  value,
  currency,
  className,
  digits = 2,
}: {
  value: number | string | null | undefined;
  currency?: string | null;
  className?: string;
  digits?: number;
}) {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : null;
  if (numeric === null || !Number.isFinite(numeric)) {
    return <span className={`unavailable ${className ?? ""}`}>{UNAVAILABLE}</span>;
  }
  const prefix = currency ? `${currency} ` : "";
  return <span className={`data-value ${className ?? ""}`}>{`${prefix}${numeric.toFixed(digits)}`}</span>;
}

/** A number that may not have been measured; null renders as "Unavailable". */
export function NumValue({
  value,
  suffix,
  digits = 1,
  className,
}: {
  value: number | null | undefined;
  suffix?: string;
  digits?: number;
  className?: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={`unavailable ${className ?? ""}`}>{UNAVAILABLE}</span>;
  }
  return (
    <span className={`data-value ${className ?? ""}`}>
      {value.toFixed(digits)}
      {suffix ? suffix : ""}
    </span>
  );
}

/**
 * Expandable Calculation / Source line. Renders nothing at all when the API
 * did not supply an explanation - the console never invents one.
 */
export function CalculationLine({ label, text }: { label?: string; text: string | null | undefined }) {
  if (!text || text.trim().length === 0) return null;
  return (
    <details className="group border-t border-border pt-2">
      <summary className="micro-label cursor-pointer select-none list-none hover:text-primary">
        {label ?? "Calculation / Source"}
      </summary>
      <p className="mt-1.5 font-mono text-[11.5px] leading-relaxed text-muted">{text}</p>
    </details>
  );
}

/** Compact label/value pair for dense strips. */
export function StripItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5 px-3 py-2">
      <dt className="micro-label truncate">{label}</dt>
      <dd className="truncate text-[13px]">{children}</dd>
    </div>
  );
}

/**
 * Static byte-column band used for hourly/daily history. Intensity communicates
 * volume; there is no animation because the data is not live.
 */
export function SeriesBand({
  points,
  height = 96,
  label,
}: {
  points: Array<{ t: number; totalBytes: string; uploadBytes?: string; downloadBytes?: string }>;
  height?: number;
  label: string;
}) {
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center border border-border" style={{ height }}>
        <span className="micro-label">No data available</span>
      </div>
    );
  }
  let max = 0;
  const values = points.map((point) => {
    const parsed = parseByteCount(point.totalBytes);
    const numeric = parsed === null ? 0 : Number(parsed);
    if (Number.isFinite(numeric) && numeric > max) max = numeric;
    return numeric;
  });
  return (
    <div className="flex items-end gap-px overflow-hidden border border-border bg-canvas" style={{ height }} role="img" aria-label={label}>
      {points.map((point, index) => {
        const value = values[index] ?? 0;
        const fraction = max > 0 ? value / max : 0;
        const hour = new Date(point.t);
        const stamp = Number.isNaN(hour.getTime()) ? "unknown time" : hour.toISOString();
        return (
          <div
            key={`${point.t}-${index}`}
            className="min-w-px flex-1 bg-series-download/70 transition-opacity hover:opacity-100"
            style={{ height: `${Math.max(value > 0 ? 3 : 1, Math.round(fraction * (height - 2)))}px`, opacity: value > 0 ? 0.8 : 0.25 }}
            title={`${stamp} · ${formatBytes(parseByteCount(point.totalBytes))}`}
          />
        );
      })}
    </div>
  );
}
