import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { paginationFrom, readJson, withConsole } from "@/server/http/guard";
import {
  approveDevice,
  deviceCounts,
  listDevices,
  registerDevice,
  rejectDevice,
} from "@/server/devices/service";

const listSchema = z.object({
  approvalState: z.enum(["PENDING", "APPROVED", "REJECTED", "BLOCKED"]).optional(),
  connectionStatus: z.enum(["ONLINE", "OFFLINE", "CONNECTING", "QUOTA_EXCEEDED", "REVOKED"]).optional(),
  nodeId: z.string().min(1).max(64).optional(),
  search: z.string().min(1).max(80).optional(),
});

const registerSchema = z.object({
  displayName: z.string().min(1).max(80),
  client: z.string().min(1).max(60),
  platform: z.string().min(1).max(60),
  presentedPublicKey: z.string().max(200).optional().nullable(),
  publicSourceIp: z.string().max(64).optional().nullable(),
});

export const GET = withConsole(async (_request, ctx) => {
  const filters = listSchema.safeParse({
    approvalState: ctx.url.searchParams.get("approvalState") ?? undefined,
    connectionStatus: ctx.url.searchParams.get("connectionStatus") ?? undefined,
    nodeId: ctx.url.searchParams.get("nodeId") ?? undefined,
    search: ctx.url.searchParams.get("search") ?? undefined,
  });
  if (!filters.success) {
    throw new Error("Invalid query.");
  }
  const pagination = paginationFrom(ctx.url);
  const { items, total } = await listDevices({ ...filters.data, skip: pagination.skip, take: pagination.take });
  const counts = await deviceCounts();

  return jsonOk(items, {
    meta: { ...pagination, total, hasMore: pagination.skip + items.length < total, counts },
    requestId: ctx.requestId,
  });
});

export const POST = withConsole(
  async (request, ctx) => {
    const parsed = registerSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new Error("Invalid payload.");
    const created = await registerDevice({
      ...parsed.data,
      publicSourceIp: ctx.sourceIp ?? parsed.data.publicSourceIp ?? null,
    });
    return jsonOk(created, { status: 201, requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);
