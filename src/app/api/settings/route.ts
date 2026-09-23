import "server-only";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { z } from "zod";
import { listSettings, updateSetting } from "@/server/settings/service";

export const GET = withConsole(async (_request, ctx) => {
  const category = ctx.url.searchParams.get("category") as never;
  return jsonOk(await listSettings(category ?? undefined), { requestId: ctx.requestId });
});

const schema = z.object({ key: z.string().min(1), value: z.unknown() });

export const PATCH = withConsole(
  async (request, ctx) => {
    const parsed = schema.safeParse(await readJson(request));
    if (!parsed.success) throw parsed.error;
    return jsonOk(
      await updateSetting({
        key: parsed.data.key,
        value: parsed.data.value,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      }),
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
