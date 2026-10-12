import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { getNetworkSnapshot } from "@/server/network/discovery";

/**
 * Forces a fresh network detection pass (bypasses the snapshot cache).
 *
 * ADMIN-only and rate limited, because each refresh makes outbound HTTPS calls to
 * third-party IP echo services; an unauthenticated or VIEWER-triggered refresh
 * loop would be both noisy and a small amplification vector.
 */
export const POST = withConsole(
  async (_request, ctx) => {
    const snapshot = await getNetworkSnapshot({ force: true });
    return jsonOk(snapshot, { requestId: ctx.requestId });
  },
  { role: "ADMIN", rateLimit: { limit: 6, windowSeconds: 60 } },
);
