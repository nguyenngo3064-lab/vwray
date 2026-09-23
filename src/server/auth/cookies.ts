import "server-only";
import { cookies } from "next/headers";
import { getEnv } from "@/server/config/env";

/**
 * Cookie handling.
 *
 * Two cookies are used:
 *   * `vwray_session` — the opaque session token. `HttpOnly` so a script cannot read
 *     it, `SameSite=Lax` so top-level navigations back into the console keep working
 *     while cross-site POSTs do not carry it, `Secure` in production.
 *   * `vwray_csrf` — the double-submit token. Deliberately NOT `HttpOnly`: the client
 *     has to read it and echo it in a header. It is worthless without the session
 *     cookie, which the attacker cannot read.
 *
 * Both are scoped to `/` and carry an explicit `path`, so clearing them is
 * unambiguous.
 */

export const SESSION_COOKIE = "vwray_session";
export const CSRF_COOKIE = "vwray_csrf";
export const CSRF_HEADER = "x-vwray-csrf";

function baseOptions(maxAgeSeconds: number) {
  const env = getEnv();
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: env.isProduction,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

export async function writeSessionCookies(input: {
  token: string;
  csrfToken: string;
  maxAgeSeconds: number;
}): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, input.token, baseOptions(input.maxAgeSeconds));
  store.set(CSRF_COOKIE, input.csrfToken, {
    ...baseOptions(input.maxAgeSeconds),
    httpOnly: false,
  });
}

export async function readSessionToken(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

export async function readCsrfCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(CSRF_COOKIE)?.value ?? null;
}

export async function clearSessionCookies(): Promise<void> {
  const store = await cookies();
  store.set(SESSION_COOKIE, "", { ...baseOptions(0), maxAge: 0 });
  store.set(CSRF_COOKIE, "", { ...baseOptions(0), httpOnly: false, maxAge: 0 });
}
