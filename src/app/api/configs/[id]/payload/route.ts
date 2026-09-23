import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { getConfigPayload } from "@/server/configs/service";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(
  async (_request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const versionRaw = ctx.url.searchParams.get("version");
    const version = versionRaw ? Number(versionRaw) : null;
    if (versionRaw && (!Number.isInteger(version) || (version as number) < 1)) {
      throw errors.validation("version must be a positive integer.");
    }
    const payload = await getConfigPayload({
      configId: id,
      version,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(
      {
        ...payload,
        warning: "Viewing is audited. This payload contains live credentials; treat it as a secret.",
      },
      { requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
