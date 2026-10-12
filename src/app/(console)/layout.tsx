import { redirect } from "next/navigation";
import { publicEnv } from "@/server/config/env";
import { getSession } from "@/server/auth/service";
import { ConsoleShell } from "@/components/console/console-shell";

/**
 * Console layout — the server-side security boundary for every console page.
 *
 * The proxy in `src/proxy.ts` rejects cookie-less requests before rendering, but a
 * cookie alone proves nothing: this layout resolves the session token against the
 * database on every render, so an expired, revoked or forged session never sees
 * the console shell, let alone data. Data itself arrives from `withConsole`-guarded
 * API routes, which re-check the session, CSRF token and role per request.
 */
export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  const { appUrl } = publicEnv();
  return (
    <ConsoleShell
      publicUrl={appUrl}
      user={{
        username: session.user.username,
        displayName: session.user.displayName,
        role: session.user.role,
      }}
    >
      {children}
    </ConsoleShell>
  );
}