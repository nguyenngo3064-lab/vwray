"use client";

/**
 * Typed browser client for the console API.
 *
 * Every response follows the shared envelope ({ data, meta, requestId } on success,
 * { error: { code, message, details, retryable }, requestId } on failure). This
 * module is the only browser code that parses it, so pages work with real types
 * instead of `response.json()` guesses.
 */

export interface ApiErrorPayload {
  code: string;
  message: string;
  details: Record<string, unknown> | null;
  retryable: boolean;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | null;
  readonly retryable: boolean;
  readonly requestId: string | null;

  constructor(init: {
    status: number;
    code: string;
    message: string;
    details?: Record<string, unknown> | null;
    retryable?: boolean;
    requestId?: string | null;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.details = init.details ?? null;
    this.retryable = init.retryable ?? false;
    this.requestId = init.requestId ?? null;
  }
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
}

function readCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";").map((part) => part.trim());
  for (const part of parts) {
    if (part.startsWith("vwray_csrf=")) {
      return decodeURIComponent(part.slice("vwray_csrf=".length));
    }
  }
  return null;
}

export interface RequestOptions<TBody = unknown> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: TBody;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? (options.body !== undefined ? "POST" : "GET");

  const url = new URL(path, window.location.origin);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE") {
    const csrf = readCsrfToken();
    if (csrf) headers["x-vwray-csrf"] = csrf;
  }

  const response = await fetch(url.toString(), {
    method,
    headers,
    credentials: "same-origin",
    signal: options.signal,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  // A non-JSON answer means the request never reached our API layer (proxy, WAF or a
  // crashed server). Surface it as its own failure instead of a parse crash.
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError({
      status: response.status,
      code: response.status === 401 ? "UNAUTHENTICATED" : "DEPENDENCY_UNAVAILABLE",
      message:
        response.status === 401
          ? "Your session has expired. Sign in again."
          : `The control plane returned an unexpected response (HTTP ${response.status}).`,
      retryable: response.status >= 500,
    });
  }

  const payload = (await response.json()) as {
    data?: T;
    error?: ApiErrorPayload;
    meta?: PageMeta;
    requestId?: string;
  };

  if (!response.ok || payload.error) {
    const error = payload.error;
    if (error?.code === "UNAUTHENTICATED" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("vwray:unauthenticated"));
    }
    throw new ApiError({
      status: response.status,
      code: error?.code ?? "INTERNAL_ERROR",
      message: error?.message ?? "The request failed.",
      details: error?.details ?? null,
      retryable: error?.retryable ?? response.status >= 500,
      requestId: payload.requestId,
    });
  }

  return payload.data as T;
}

/** Shorthand for list endpoints that carry pagination metadata. */
export async function apiList<T>(
  path: string,
  options?: RequestOptions,
): Promise<{ items: T[]; meta: PageMeta }> {
  const method = options?.method ?? "GET";
  const url = new URL(path, window.location.origin);
  if (options?.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    const csrf = readCsrfToken();
    if (csrf) headers["x-vwray-csrf"] = csrf;
  }
  const response = await fetch(url.toString(), { method, headers, credentials: "same-origin" });
  const payload = (await response.json()) as { data?: T[]; items?: T[]; error?: ApiErrorPayload; meta?: PageMeta };
  if (!response.ok || payload.error) {
    throw new ApiError({
      status: response.status,
      code: payload.error?.code ?? "INTERNAL_ERROR",
      message: payload.error?.message ?? "The request failed.",
      details: payload.error?.details ?? null,
      retryable: payload.error?.retryable ?? false,
    });
  }
  const items = Array.isArray(payload.data) ? payload.data : (payload.items ?? []);
  return { items, meta: payload.meta ?? { page: 1, pageSize: items.length, total: items.length, hasMore: false } };
}
