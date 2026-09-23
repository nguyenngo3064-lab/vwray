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

/**
 * State chip. Accepts either a child label or a `label` prop so a caller can render
 * a plain state string without wrapping it in JSX.
 */
export function StatusPill({
  tone,
  label,
  children,
  title,
}: {
  tone?: Tone;
  label?: string;
  children?: ReactNode;
  title?: string;
}) {
  return (
    <span className={`status ${tone ? toneClass(tone) : ""}`} title={title}>
      {children ?? label}
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

/** `error` is accepted as a caller-friendly alias for the `danger` tone. */
export type CalloutKind = "error" | "warning" | "info" | "danger" | "success";

export function Callout({
  kind,
  tone,
  title,
  children,
}: {
  kind?: CalloutKind;
  tone?: Tone;
  title?: ReactNode;
  children: ReactNode;
}) {
  const tone2: Tone | undefined = tone ?? (kind === "error" ? "danger" : kind);
  const text =
    tone2 === "success"
      ? "text-success"
      : tone2 === "warning"
        ? "text-warning"
        : tone2 === "danger"
          ? "text-danger"
          : tone2 === "info"
            ? "text-info"
            : "text-muted";
  const border =
    tone2 === "success"
      ? "border-success/40"
      : tone2 === "warning"
        ? "border-warning/40"
        : tone2 === "danger"
          ? "border-danger/40"
          : tone2 === "info"
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
    </div>
  );
}
