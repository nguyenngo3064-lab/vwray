import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, readJson, withConsole } from "@/server/http/guard";
import { errors } from "@/server/lib/errors";
import { generateConfig, listConfigs } from "@/server/configs/service";

const listSchema = z.object({
  deviceId: z.string().min(1).max(64).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED", "EXPIRED"]).optional(),
});

export const GET = withConsole(async (_request, ctx) => {
  const parsed = listSchema.safeParse(Object.fromEntries(ctx.url.searchParams));
  if (!parsed.success) throw errors.validation("One or more config filters are invalid.");
  const pagination = paginationFrom(ctx.url);
  const { items, total } = await listConfigs({
    ...parsed.data,
    skip: pagination.skip,
    take: pagination.take,
  });
  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total },
    requestId: ctx.requestId,
  });
});

const createSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  deviceId: z.string().min(1).max(64),
  nodeId: z.string().min(1).max(64),
  protocol: z.enum(["WIREGUARD", "XRAY_VLESS", "XRAY_VMESS", "XRAY_TROJAN"]).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(3650).optional(),
  changeNote: z.string().max(300).optional().nullable(),
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = createSchema.safeParse(await readJson(request));
    if (!parsed.success) throw errors.validation("The config payload is invalid.");

    const { prisma } = await import("@/server/db/client");
    const node = await prisma.vpnNode.findUnique({ where: { id: parsed.data.nodeId } });
    if (!node) throw errors.notFound("VPN node");

    const protocol = parsed.data.protocol ?? node.protocol;
    if (protocol === "MOCK") throw errors.unsupported("The mock gateway cannot produce client configurations.");

    const device = await prisma.device.findUnique({ where: { id: parsed.data.deviceId } });
    const name =
      parsed.data.name ?? `${device?.displayName ?? "device"} · ${protocol.toLowerCase()} · ${new Date().toISOString().slice(0, 10)}`;

    const created = await generateConfig({
      name,
      deviceId: parsed.data.deviceId,
      nodeId: parsed.data.nodeId,
      protocol: protocol as "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN",
      changeNote: parsed.data.changeNote ?? null,
      expiresAt: parsed.data.expiresInDays
        ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000)
        : null,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });

    return jsonOk(
      {
        configId: created.configId,
        version: created.version,
        payload: created.payload,
        format: created.format,
        qrPayload: created.qrPayload,
        fingerprint: created.fingerprint,
        expiresAt: created.expiresAt ? created.expiresAt.toISOString() : null,
        summary: `${name} · ${protocol} · v${created.version}`,
      },
      { status: 201, requestId: ctx.requestId },
    );
  },
  { role: "ADMIN" },
);
