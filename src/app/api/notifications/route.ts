import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { listNotifications, markAllRead, markRead } from "@/server/notifications/service";

/**
 * In-dashboard notifications.
 *
 * Unread items are what the bell badge shows, so the default filter is `unreadOnly`
 * only when asked; the page needs both counts and gets them from `meta` to avoid a
 * second request that could race the first.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const unreadOnly = ctx.url.searchParams.get("unreadOnly") === "true";
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? "30") || 30, 100);
    const result = await listNotifications({ unreadOnly, limit });
    return jsonOk(result.items, {
      meta: { total: result.total, unread: result.unread, pageSize: limit, page: 1, hasMore: false },
      requestId: ctx.requestId,
    });
  },
  { rateLimit: { limit: 120, windowSeconds: 60 } },
);

const markSchema = z
  .object({
    ids: z.array(z.string().min(1).max(64)).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((value) => value.all === true || (value.ids?.length ?? 0) > 0, {
    message: "Provide ids to mark, or all: true.",
  });

/** Marks notifications read. Only an authenticated operator can do this. */
export const POST = withConsole(
  async (request, ctx) => {
    const parsed = markSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("A notification selection is required.");

    const marked = parsed.data.all
      ? await markAllRead()
      : await markRead(parsed.data.ids ?? []);

    return jsonOk({ marked }, { requestId: ctx.requestId });
  },
  { role: "VIEWER", rateLimit: { limit: 60, windowSeconds: 60 } },
);
