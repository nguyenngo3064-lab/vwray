"use client";

/**
 * Client-safe response shapes: helpers, tones, auth and search.
 *
 * Mirrors of API payloads live here rather than in server modules so a page never
 * imports `server-only` code into the browser bundle. Fields the contract does not
 * yet guarantee are typed optional or `unknown`; renderers treat absence as
 * "Unavailable", never as zero.
 */

import type { Tone } from "@/components/ui/primitives";
import type { StreamStatus } from "@/lib/realtime/types";

export type { StreamStatus };

/* ------------------------------------------------------------- helpers --- */

/** Accepts the two envelope shapes the API family uses: a bare array or `{items}`. */
export function itemsOf<T>(data: unknown): T[] | null {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object" && Array.isArray((data as { items?: unknown }).items)) {
    return (data as { items: T[] }).items;
  }
  return null;
}

/** Total row count from either envelope shape, falling back to the local length. */
export function totalOf(data: unknown, fallback: number): number {
  if (data && typeof data === "object") {
    const total = (data as { total?: unknown }).total;
    if (typeof total === "number") return total;
  }
  return fallback;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** First non-empty string among candidate fields, or null when none was supplied. */
export function pickText(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return null;
}

export function numOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function strOf(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/* ---------------------------------------------------------------- tones --- */

export function streamTone(status: StreamStatus | null): Tone {
  switch (status) {
    case "live":
      return "info";
    case "mock":
      return "warning";
    case "stale":
      return "danger";
    default:
      return "neutral";
  }
}

export function severityTone(severity: string | null | undefined): Tone {
  const value = (severity ?? "").toUpperCase();
  if (value === "CRITICAL" || value === "HIGH") return "danger";
  if (value === "WARNING" || value === "MEDIUM" || value === "LOW") return "warning";
  return "info";
}

export function resultTone(result: string | null | undefined): Tone {
  const value = (result ?? "").toUpperCase();
  if (value.includes("DENY") || value.includes("FAIL")) return "danger";
  if (value.includes("SUCCESS") || value.includes("OK") || value === "SUCCEEDED") return "success";
  if (value === "RUNNING" || value === "SKIPPED") return "info";
  return "neutral";
}

export function receiptStatusTone(status: string): Tone {
  if (status === "ISSUED") return "success";
  if (status === "VOID") return "danger";
  return "neutral";
}

/* ---------------------------------------------------------------- auth ---- */

export interface ConsoleUser {
  username: string;
  displayName: string;
  role: string;
}

export interface AuthStateData {
  needsBootstrap: boolean;
  authenticated: boolean;
  user: ConsoleUser | null;
  expiresAt: string | null;
}

export interface BootstrapData {
  created: boolean;
  username?: string;
  accessCode?: string;
}

/* -------------------------------------------------------------- search --- */

export interface SearchResultMeta {
  label: string;
  value: string;
}

export interface SearchResultItem {
  type: string;
  id: string;
  title: string;
  subtitle?: string | null;
  href: string;
  meta?: SearchResultMeta[];
}

export interface SearchData {
  results: SearchResultItem[];
}

/** Fixed group order for the search dropdown; unknown types render last. */
const SEARCH_GROUP_ORDER = [
  "device",
  "node",
  "config",
  "receipt",
  "policy",
  "session",
  "audit",
  "quota",
  "user",
  "notification",
] as const;

export function groupSearchResults(
  results: SearchResultItem[],
): Array<{ type: string; items: SearchResultItem[] }> {
  const byType = new Map<string, SearchResultItem[]>();
  for (const result of results) {
    const bucket = byType.get(result.type);
    if (bucket) bucket.push(result);
    else byType.set(result.type, [result]);
  }
  const ordered: Array<{ type: string; items: SearchResultItem[] }> = [];
  for (const type of SEARCH_GROUP_ORDER) {
    const items = byType.get(type);
    if (items) ordered.push({ type, items });
    byType.delete(type);
  }
  for (const [type, items] of byType) ordered.push({ type, items });
  return ordered;
}
