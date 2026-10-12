import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getNetworkSnapshot } from "@/server/network/discovery";

/**
 * Deployment / network diagnostics for the console.
 *
 * Answers the five address questions separately (control-plane URL, outbound IP,
 * inbound reachability, VPN node endpoints, tunnel addresses) and refuses to
 * collapse them into one "your IP is X" claim. Every read is behind a session
 * (withConsole), so this data is never served anonymously.
 *
 * The cached snapshot is served by default; `?refresh=true` re-detects and is
 * limited to admins via the companion refresh route.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const snapshot = await getNetworkSnapshot();
    return jsonOk(snapshot, { requestId: ctx.requestId });
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
