"use client";

/**
 * Shared client plumbing for the operations pages.
 *
 * Two thin loaders sit on top of `apiFetch`/`apiList` because the pages need what a
 * single-value hook cannot carry: the pagination envelope (`meta`) and the device
 * counts that ride along with it. Both abort on unmount, both re-request only when the
 * *contents* of a query change (never on object identity), and both surface the shared
 * `ApiError` so every page can render the same six states.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ApiError, apiFetch, apiList, type PageMeta } from "@/lib/api/client";
import { Button, ErrorState, Field, Input, LoadingState, Select } from "@/components/ui/primitives";
import { Modal } from "@/components/ui/interactive";
import { describeApiError, mutationMessage } from "./ops-contract";

export type QueryValue = string | number | boolean | null | undefined;
export type QueryInput = Record<string, QueryValue>;

function stableQueryKey(query?: QueryInput): string {
  if (!query) return "";
  return Object.keys(query)
    .sort()
    .map((key) => `${key}=${String(query[key] ?? "")}`)
    .join("&");
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof Error) {
    return new ApiError({ status: 0, code: "NETWORK_ERROR", message: error.message, retryable: true });
  }
  return new ApiError({
    status: 0,
    code: "NETWORK_ERROR",
    message: "The request failed before a response arrived.",
    retryable: true,
  });
}

export interface ResourceState<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

/** One object read. `path === null` means "do not request yet". */
export function useResource<T>(
  path: string | null,
  query?: QueryInput,
  options?: { refreshMs?: number },
): ResourceState<T> {
  const queryRef = useRef<QueryInput>(query ?? {});
  queryRef.current = query ?? {};
  const queryKey = stableQueryKey(query);
  const refreshMs = options?.refreshMs;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    apiFetch<T>(path, { query: queryRef.current, signal: controller.signal })
      .then((value) => {
        if (!active) return;
        setData(value);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(toApiError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, queryKey, nonce]);

  useEffect(() => {
    if (!refreshMs || !path) return;
    const timer = window.setInterval(() => setNonce((value) => value + 1), refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs, path]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, loading, refresh };
}

export interface ListState<T> {
  items: T[];
  meta: PageMeta;
  /** The envelope meta exactly as received, for fields outside PageMeta. */
  rawMeta: unknown;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

/** Paginated read that keeps the server's `meta` intact. */
export function useList<T>(
  path: string | null,
  query: QueryInput,
  options?: { pageSize?: number },
): ListState<T> {
  const queryRef = useRef(query);
  queryRef.current = query;
  const queryKey = stableQueryKey(query);
  const defaultPageSize = options?.pageSize ?? 25;

  const [items, setItems] = useState<T[]>([]);
  const [meta, setMeta] = useState<PageMeta>({ page: 1, pageSize: defaultPageSize, total: 0, hasMore: false });
  const [rawMeta, setRawMeta] = useState<unknown>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!path) {
      setItems([]);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);

    const requested = queryRef.current;
    const requestedPage = typeof requested.page === "number" ? requested.page : 1;
    const requestedSize =
      typeof requested.pageSize === "number" && requested.pageSize > 0 ? requested.pageSize : defaultPageSize;

    apiList<T>(path, { query: requested, signal: controller.signal })
      .then((result) => {
        if (!active) return;
        const received = result.meta;
        const page = typeof received.page === "number" ? received.page : requestedPage;
        const pageSize = typeof received.pageSize === "number" ? received.pageSize : requestedSize;
        const total = typeof received.total === "number" ? received.total : result.items.length;
        setItems(result.items);
        setRawMeta(received);
        setMeta({
          page,
          pageSize,
          total,
          hasMore: typeof received.hasMore === "boolean" ? received.hasMore : page * pageSize < total,
        });
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!active || controller.signal.aborted) return;
        setError(toApiError(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [path, queryKey, nonce, defaultPageSize]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);
  return { items, meta, rawMeta, error, loading, refresh };
}

/** Debounce for search inputs so typing does not become one request per keystroke. */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface FilterQuery {
  get: (key: string, fallback?: string) => string;
  number: (key: string, fallback: number) => number;
  flag: (key: string) => boolean;
  set: (updates: Record<string, QueryValue>) => void;
  clear: () => void;
  active: boolean;
}

/**
 * Filters live in the URL, so a view is shareable and a reload lands on the same
 * slice. `set` removes a key when the value is empty, false or null.
 */
export function useFilterQuery(): FilterQuery {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const raw = searchParams.toString();

  const get = useCallback((key: string, fallback = "") => searchParams.get(key) ?? fallback, [searchParams]);

  const number = useCallback(
    (key: string, fallback: number) => {
      const parsed = Number(searchParams.get(key));
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    },
    [searchParams],
  );

  const flag = useCallback((key: string) => searchParams.get(key) === "true", [searchParams]);

  const set = useCallback(
    (updates: Record<string, QueryValue>) => {
      const next = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined || value === "" || value === false) next.delete(key);
        else next.set(key, String(value));
      }
      const queryString = next.toString();
      router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const clear = useCallback(() => router.replace(pathname, { scroll: false }), [pathname, router]);
  return { get, number, flag, set, clear, active: raw.length > 0 };
}

/** Loading, then the right failure state, then the content. */

/** Compact filter bar: one search box plus small select dropdowns. */
export function FilterBar({
  filters,
  search,
}: {
  filters: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    options: { id: string; label: string }[];
  }[];
  search?: { value: string; placeholder?: string; onChange: (value: string) => void };
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 p-2">
      {search && (
        <input
          type="search"
          className="input flex-1 min-w-[16rem]"
          placeholder={search.placeholder ?? "Search"}
          value={search.value}
          onChange={(event) => search.onChange(event.target.value)}
          aria-label={search.placeholder ?? "Search"}
        />
      )}
      {filters.map((filter) => (
        <Select
          key={filter.id}
          value={filter.value}
          onChange={(event) => filter.onChange(event.target.value)}
          aria-label={filter.label}
        >
          <option value="">All {filter.label.toLowerCase()}</option>
          {filter.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </Select>
      ))}
    </div>
  );
}


export function AsyncPanel({
  loading,
  error,
  subject,
  onRetry,
  rows = 6,
  label,
  children,
}: {
  loading: boolean;
  error: ApiError | null;
  subject: string;
  onRetry?: () => void;
  rows?: number;
  label?: string;
  children: ReactNode;
}) {
  if (loading) return <LoadingState label={label ?? `Loading ${subject}`} rows={rows} />;
  if (error) {
    const descriptor = describeApiError(error, subject);
    return (
      <ErrorState
        title={descriptor.title}
        message={descriptor.message}
        requestId={descriptor.requestId}
        onRetry={descriptor.retryable ? onRetry : undefined}
      />
    );
  }
  return <>{children}</>;
}

/** Page title block. Kept identical across the operations pages. */
export function PageLead({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-end lg:justify-between">
      <div className="max-w-3xl space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-primary">{title}</h1>
        <div className="text-[12.5px] leading-relaxed text-muted">{description}</div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Small explanatory line used under dense tables. */
export function MicroNote({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`text-[11.5px] leading-relaxed text-faint ${className ?? ""}`}>{children}</p>;
}

// ------------------------------------------------------------------ actions ---

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ActionRunner {
  busy: boolean;
  error: string | null;
  notice: string | null;
  clear: () => void;
  run: <T>(
    path: string,
    options?: {
      method?: "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      successNote?: string;
      onDone?: () => void;
    },
  ) => Promise<ActionResult<T>>;
}

/**
 * One place where a mutation is awaited. An empty JSON body is sent for methods that
 * carry none, because the API rejects a missing body rather than treating it as `{}`.
 */
export function useActionRunner(): ActionRunner {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(async <T,>(
    path: string,
    options?: {
      method?: "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      successNote?: string;
      onDone?: () => void;
    },
  ): Promise<ActionResult<T>> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiFetch<T>(path, {
        method: options?.method ?? "POST",
        body: options?.body ?? {},
      });
      if (options?.successNote) setNotice(options.successNote);
      options?.onDone?.();
      return { ok: true, data };
    } catch (caught) {
      const message = mutationMessage(caught);
      setError(message);
      return { ok: false, error: message };
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
  }, []);

  return { busy, error, notice, run, clear };
}

export interface ActionField {
  id: string;
  label: string;
  hint?: string;
  kind: "text" | "textarea" | "select" | "number";
  value: string;
  onChange: (value: string) => void;
  options?: { id: string; label: string }[];
  placeholder?: string;
  required?: boolean;
}

/** A modal whose whole job is one confirmed mutation. */
export function ActionModal({
  open,
  title,
  description,
  fields,
  submitLabel,
  danger,
  ready,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  fields: ActionField[];
  submitLabel: string;
  danger?: boolean;
  ready: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={danger ? "danger" : "primary"} onClick={onSubmit} disabled={busy || !ready}>
            {busy ? "Working" : submitLabel}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {description ? <MicroNote>{description}</MicroNote> : null}
        {fields.map((field) => (
          <Field key={field.id} label={field.label} hint={field.hint} htmlFor={field.id}>
            {field.kind === "select" ? (
              <Select
                id={field.id}
                value={field.value}
                onChange={(event) => field.onChange(event.target.value)}
              >
                <option value="">Not set</option>
                {(field.options ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            ) : field.kind === "textarea" ? (
              <textarea
                id={field.id}
                className="input h-auto min-h-[4.5rem] py-2"
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => field.onChange(event.target.value)}
              />
            ) : (
              <Input
                id={field.id}
                type={field.kind === "number" ? "number" : "text"}
                value={field.value}
                placeholder={field.placeholder}
                onChange={(event) => field.onChange(event.target.value)}
              />
            )}
          </Field>
        ))}
        {error ? (
          <p className="text-[12px] text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}