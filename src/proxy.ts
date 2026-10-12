import { NextResponse, type NextRequest } from "next/server";

/**
 * Unauthenticated visitors never reach a console page.
 *
 * This proxy is the fast first gate: it runs before rendering and redirects any
 * request to a protected page that carries no session cookie. It is deliberately
 * dependency-free (no database, no shared modules) because Next invokes it
 * separately from the render code.
 *
 * It is NOT the security boundary — a cookie can be forged or stale. The real
 * check is `getSession()` in `src/app/(console)/layout.tsx`, which verifies the
 * token against the database and revokes expired sessions. This layer exists so
 * that even the HTML shell of the console is not served to anonymous callers.
 *
 * `next` is always a same-origin relative path built from the request URL, never
 * taken from user input, so this redirect cannot be turned into an open redirect.
 */
const SESSION_COOKIE = "vwray_session";

/** Console page roots. `/login` and `/api/*` are intentionally not listed. */
const PROTECTED_PREFIXES = [
  "/devices",
  "/nodes",
  "/configurations",
  "/quota",
  "/optimization",
  "/dns",
  "/settings",
  "/overview",
  "/audit",
  "/diagnostics",
] as const;

function isProtected(pathname: string): boolean {
  if (pathname === "/") return true;
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Only same-origin relative paths survive; everything else falls back to the console root. */
export function safeNextPath(pathname: string, search = ""): string {
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\\")) {
    return "/devices";
  }
  // Reject anything that could change the origin when parsed by URL(): backslashes,
  // embedded scheme (`/\/evil.com`) or control characters.
  if (/[\u0000-\u001f]/.test(pathname)) return "/devices";
  return `${pathname}${search}`;
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (!isProtected(pathname)) return NextResponse.next();

  const hasSessionCookie = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  if (hasSessionCookie) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", safeNextPath(pathname, search));
  return NextResponse.redirect(login);
}
