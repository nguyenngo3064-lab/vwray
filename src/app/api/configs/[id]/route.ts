import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { revokeConfig, rollbackConfig } from "@/server/configs/service";
import { prisma } from "@/server/db/client";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const config = await prisma.vpnConfig.findUnique({
    where: { id },
    include: {
      device: { select: { id: true, displayName: true } },
      node: { select: { id: true, nodeId: true, name: true } },
      versions: { orderBy: { version: "desc" } },
    },
  });
  if (!config) throw errors.notFound("Configuration");

  const credentials = config.deviceId
    ? await prisma.deviceCredential.findMany({
        where: { deviceId: config.deviceId },
        select: { id: true, kind: true, fingerprint: true, createdAt: true, expiresAt: true, revokedAt: true },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];

  return jsonOk(
    {
      config: {
        ...config,
        createdAt: config.createdAt.toISOString(),
        updatedAt: config.updatedAt.toISOString(),
        expiresAt: config.expiresAt ? config.expiresAt.toISOString() : null,
        revokedAt: config.revokedAt ? config.revokedAt.toISOString() : null,
      },
      versions: config.versions.map((versionRow) => ({
        id: versionRow.id,
        version: versionRow.version,
        checksum: versionRow.checksum,
        summary: versionRow.summary,
        isActive: versionRow.isActive,
        changeNote: versionRow.changeNote,
        createdAt: versionRow.createdAt.toISOString(),
        supersededAt: versionRow.supersededAt ? versionRow.supersededAt.toISOString() : null,
      })),
      credentials: credentials.map((credential) => ({
        ...credential,
        createdAt: credential.createdAt.toISOString(),
        expiresAt: credential.expiresAt ? credential.expiresAt.toISOString() : null,
        revokedAt: credential.revokedAt ? credential.revokedAt.toISOString() : null,
      })),
    },
    { requestId: ctx.requestId },
  );
});

const revokeSchema = z.object({ reason: z.string().min(1).max(300) });
const expireSchema = z.object({ expiresAt: z.string().min(1).max(40) });
const rollbackSchema = z.object({ version: z.coerce.number().int().min(1) });

export async function POST(request: Request, routeContext: { params: Promise<{ id: string }> }) {
  const { id } = await routeContext.params;
  const action = new URL(request.url).searchParams.get("action");

  if (action === "revoke") {
    return withConsole(async (inner, ctx) => {
      const parsed = revokeSchema.safeParse(await readJson(inner));
      if (!parsed.success) throw errors.validation("A revocation reason is required.");
      const result = await revokeConfig({
        configId: id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "expire") {
    return withConsole(async (inner, ctx) => {
      const parsed = expireSchema.safeParse(await readJson(inner));
      if (!parsed.success) throw errors.validation("An expiry timestamp is required.");
      const expiresAt = new Date(parsed.data.expiresAt);
      if (Number.isNaN(expiresAt.getTime())) throw errors.validation("expiresAt must be an ISO timestamp.");
      await prisma.vpnConfig.update({
        where: { id },
        data: { status: "EXPIRED", expiresAt },
      });
      return jsonOk({ id, status: "EXPIRED" }, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "rollback") {
    return withConsole(async (inner, ctx) => {
      const parsed = rollbackSchema.safeParse(await readJson(inner));
      if (!parsed.success) throw errors.validation("A target version number is required.");
      const result = await rollbackConfig({
        configId: id,
        toVersion: parsed.data.version,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  const { withErrorHandling } = await import("@/server/http/respond");
  return withErrorHandling(async () => {
    throw errors.validation(`Unknown action "${action}". Use revoke, expire or rollback.`);
  })(request);
}
