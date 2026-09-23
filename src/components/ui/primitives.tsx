import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from "react";

/**
 * Server-safe presentational primitives for the operations console.
 *
 * Deliberately NO "use client" directive: these are pure functions of their props
 * (no state, no effects, no browser APIs), so server components may import them -
 * `api-types.ts` does exactly that for the `Tone` type. Anything stateful lives in
 * `interactive.tsx`.
 *
 * Styling binds to the console tokens in `globals.css` (.panel, .btn, .input,
 * .data-table, .status, .unavailable): a component never invents its own surface or
 * radius. Status colour is semantic-only - a tone is only ever passed for a measured
 * state, never for decoration.
 */

export type Tone = "neutral" | "success" | "warning" | "danger" | "info";

function toneClass(tone: Tone): string {
  switch (tone) {
    case "success":
      return "status-success";
    case "warning":
      return "status-warning";
    case "danger":
      return "status-danger";
    case "info":
      return "status-info";
    default:
      return "";
  }
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {title !== undefined || actions !== undefined ? (
        <div className="panel-header">
          <span className="micro-label">{title}</span>
          {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={bodyClassName ?? "p-3"}>{children}</div>
    </section>
  );
}

export function SectionHeading({
  label,
  description,
  actions,
}: {
  label: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold tracking-tight text-primary">{label}</h2>
        {description ? <div className="text-[12px] leading-relaxed text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="micro-label">{label}</dt>
      <dd className={`data-value text-lg ${tone ? toneClass(tone) : ""}`}>{value}</dd>
      {hint ? <div className="text-[11.5px] text-faint">{hint}</div> : null}
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <dt className="micro-label">{label}</dt>
      <dd className="data-value text-right text-[13px]">{value}</dd>
    </div>
  );
}

/** A missing measurement renders as "Unavailable" - never as 0. */
export function Unavailable({ label }: { label?: string }) {
  return <span className="unavailable">{label ?? "Unavailable"}</span>;
}

export function StatusPill({
  tone,
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`status ${tone ? toneClass(tone) : ""}`} title={title}>
      {children}
    </span>
  );
}

/** Quota / savings progress. `percent === null` means unmeasurable, not empty. */
export function UsageBar({ percent, tone }: { percent: number | null; tone?: Tone }) {
  if (percent === null || !Number.isFinite(percent)) {
    return <span className="unavailable">Unavailable</span>;
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const fill =
    tone === "success"
      ? "bg-success"
      : tone === "warning"
        ? "bg-warning"
        : tone === "danger"
          ? "bg-danger"
          : tone === "info"
            ? "bg-info"
            : "bg-muted";
  return (
    <div
      className="h-1.5 w-full min-w-16 overflow-hidden bg-elevated"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className={`h-full ${fill}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}

export function Callout({
  tone,
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const text =
    tone === "success"
      ? "text-success"
      : tone === "warning"
        ? "text-warning"
        : tone === "danger"
          ? "text-danger"
          : tone === "info"
            ? "text-info"
            : "text-muted";
  const border =
    tone === "success"
      ? "border-success/40"
      : tone === "warning"
        ? "border-warning/40"
        : tone === "danger"
          ? "border-danger/40"
          : tone === "info"
            ? "border-info/40"
            : "border-border";
  return (
    <div className={`panel border-l-2 p-3 ${border}`} role="note">
      {title ? <p className={`text-[12px] font-medium ${text}`}>{title}</p> : null}
      <div className="text-[12.5px] leading-relaxed text-muted">{children}</div>
    </div>
  );
}

export function LoadingState({ label, rows }: { label?: string; rows?: number }) {
  const count = Math.max(1, Math.min(rows ?? 6, 24));
  return (
    <div role="status" aria-label={label ?? "Loading"} className="space-y-2 p-3">
      <span className="sr-only">{label ?? "Loading"}</span>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="h-3 animate-pulse bg-elevated" aria-hidden="true" />
      ))}
    </div>
  );
}

export function ErrorState({
  title,
  message,
  requestId,
  onRetry,
}: {
  title: string;
  message?: ReactNode;
  requestId?: string | null;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="panel space-y-2 p-4">
      <p className="text-[13px] font-medium text-danger">{title}</p>
      {message ? <p className="text-[12.5px] leading-relaxed text-muted">{message}</p> : null}
      {requestId ? <p className="font-mono text-[11px] text-faint">request {requestId}</p> : null}
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

export function EmptyState({
  title,
  message,
  actions,
}: {
  title: string;
  message?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="space-y-1.5 px-4 py-10 text-center">
      <p className="text-[13px] font-medium text-primary">{title}</p>
      {message ? <p className="text-[12px] leading-relaxed text-muted">{message}</p> : null}
      {actions ? <div className="flex items-center justify-center gap-2 pt-2">{actions}</div> : null}
    </div>
  );
}

export interface TableColumn<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right";
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  empty,
  caption,
}: {
  columns: TableColumn<T>[];
  rows: T[];
  keyOf: (row: T, index: number) => string;
  empty?: ReactNode;
  caption?: string;
}) {
  if (rows.length === 0) {
    return <>{empty ?? <EmptyState title="No rows" message="Nothing matches the current filters." />}</>;
  }
  return (
    <div className="table-scroll">
      <table className="data-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === "right" ? "text-right" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={keyOf(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={column.align === "right" ? "text-right" : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const current = Math.max(1, Math.min(page, totalPages));
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-2 pt-2">
      <p className="text-[11.5px] text-faint" aria-live="polite">
        Page {current} of {totalPages} · {total.toLocaleString("en-US")} total
      </p>
      <div className="flex items-center gap-2">
        <Button onClick={() => onPage(current - 1)} disabled={current <= 1} aria-label="Previous page">
          Prev
        </Button>
        <Button onClick={() => onPage(current + 1)} disabled={current >= totalPages} aria-label="Next page">
          Next
        </Button>
      </div>
    </nav>
  );
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "danger";
  size?: "sm" | "md" | "lg";
};

export function Button({ variant, size, className, type, ...rest }: ButtonProps) {
  const tone = variant === "primary" ? "btn-primary" : variant === "danger" ? "btn-danger" : "";
  const sizeClass = size === "sm" ? "px-2 py-0.5 text-[11px]" : size === "lg" ? "px-4 py-1.5 text-[13px]" : "";
  return <button type={type ?? "button"} className={`btn ${tone} ${sizeClass} ${className ?? ""}`} {...rest} />;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

export function Input({ className, ...rest }: InputProps) {
  return <input className={`input ${className ?? ""}`} {...rest} />;
}

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select({ className, children, ...rest }: SelectProps) {
  return (
    <select className={`input ${className ?? ""}`} {...rest}>
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      <label htmlFor={htmlFor} className="micro-label block">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[11.5px] leading-relaxed text-faint">{hint}</p> : null}

export function StatusPill({ tone, label, children }: { tone?: Tone; label?: string; children?: ReactNode }) {
  return (
    <span className={`status ${toneClass(tone ?? "neutral")} inline-flex items-center gap-1 px-1.5 py-0.5 text-[10.5px] uppercase tracking-wide`}>
      {children ?? label}
    </span>
  );
}

export function Callout({ kind, title, children }: { kind: "error" | "warning" | "info"; title?: string; children?: ReactNode }) {
  const borderColor = kind === "error" ? "border-danger/30" : kind === "warning" ? "border-warning/30" : "border-info/30";
  const bgColor = kind === "error" ? "bg-danger/5" : kind === "warning" ? "bg-warning/5" : "bg-info/5";
  return (
    <div className={`panel ${borderColor} ${bgColor} p-3`}>
      {title ? <div className="text-[11px] font-medium text-muted mb-1">{title}</div> : null}
      {children ? <div className="text-[12px] text-muted">{children}</div> : null}
    </div>
  );
}

export function UsageBar({ value, max, label, tone }: { value: number; max: number; label?: string; tone?: Tone }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">{label ?? `${value.toLocaleString()} / ${max.toLocaleString()}`}</span>
        <span className={`text-[11px] ${tone ? toneClass(tone) : "text-muted"}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-1.5 bg-canvas overflow-hidden rounded-full">
        <div className={`h-full rounded-full ${tone ? toneClass(tone) : "bg-muted"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function EmptyState({ title, message }: { title: string; message?: string }) {
  return (
    <div className="py-6 text-center">
      <div className="text-[13px] font-medium text-primary">{title}</div>
      {message ? <div className="text-[12px] text-muted mt-1.5 leading-relaxed">{message}</div> : null}
    </div>
  );
}

export function LoadingState({ subject, rows }: { subject?: string; rows?: number }) {
  const height = rows ? `min-h-[calc(${rows} * 2.75rem + 0.5rem)]` : "min-h-[3rem]";
  return (
    <div className={`space-y-1 ${height}`}>
      <div className="text-[11.5px] text-muted">Loading {subject ?? "data"}…</div>
    </div>
  );
}

export function ErrorState({ subject, onRetry }: { subject?: string; onRetry?: () => void }) {
  return (
    <div className="space-y-2">
      <div className="text-[11.5px] text-danger">Could not load {subject ?? "data"}.</div>
      {onRetry ? <Button onClick={onRetry}>Retry</Button> : null}
    </div>
  );
}

    </div>
  );
}
