import "server-only";
import { z } from "zod";
import { jsonOk } from "@/server/http/respond";
import { readJson, withConsole } from "@/server/http/guard";
import {
  approveDevice,
  blockDevice,
  disconnectDevice,
  getDevice,
  rejectDevice,
  updateDevice,
} from "@/server/devices/service";

const decisionSchema = z.object({
  note: z.string().max(300).optional().nullable(),
  nodeId: z.string().min(1).max(64).optional().nullable(),
});

const blockSchema = z.object({
  reason: z.string().min(1).max(300),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  optimizationProfileId: z.string().min(1).max(64).nullable().optional(),
  assignedNodeId: z.string().min(1).max(64).nullable().optional(),
  securityState: z.enum(["NORMAL", "REVIEW", "LOCKED"]).optional(),
});

const disconnectSchema = z.object({
  reason: z.string().max(300).default("revoked"),
});

interface RouteParams {
  params: Promise<{ id: string }>;
}

export const GET = withConsole(async (_request, ctx, extra: unknown) => {
  const { id } = await (extra as RouteParams).params;
  const device = await getDevice(id);
  return jsonOk(device, { requestId: ctx.requestId });
});

export const PATCH = withConsole(
  async (request, ctx, extra: unknown) => {
    const { id } = await (extra as RouteParams).params;
    const parsed = updateSchema.safeParse(await readJson(request));
    if (!parsed.success) throw new Error("Invalid payload.");
    const result = await updateDevice({
      deviceId: id,
      ...parsed.data,
      actorId: ctx.session.user.id,
      actorLabel: ctx.session.user.username,
      sourceIp: ctx.sourceIp,
    });
    return jsonOk(result, { requestId: ctx.requestId });
  },
  { role: "ADMIN" },
);

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ id: string }> },
) {
  const { id } = await routeContext.params;
  const action = new URL(request.url).searchParams.get("action");

  if (action === "approve") {
    return withConsole(async (innerRequest, ctx) => {
      const parsed = decisionSchema.safeParse(await readJson(innerRequest));
      if (!parsed.success) throw new Error("Invalid payload.");
      const result = await approveDevice({
        deviceId: id,
        note: parsed.data.note,
        nodeId: parsed.data.nodeId,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "reject") {
    return withConsole(async (innerRequest, ctx) => {
      const parsed = decisionSchema.safeParse(await readJson(innerRequest));
      if (!parsed.success) throw new Error("Invalid payload.");
      const result = await rejectDevice({
        deviceId: id,
        note: parsed.data.note,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "block") {
    return withConsole(async (innerRequest, ctx) => {
      const parsed = blockSchema.safeParse(await readJson(innerRequest));
      if (!parsed.success) throw new Error("Invalid payload.");
      const result = await blockDevice({
        deviceId: id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  if (action === "disconnect") {
    return withConsole(async (innerRequest, ctx) => {
      const parsed = disconnectSchema.safeParse(await readJson(innerRequest));
      if (!parsed.success) throw new Error("Invalid payload.");
      const result = await disconnectDevice({
        deviceId: id,
        reason: parsed.data.reason,
        actorId: ctx.session.user.id,
        actorLabel: ctx.session.user.username,
        sourceIp: ctx.sourceIp,
      });
      return jsonOk(result, { requestId: ctx.requestId });
    }, { role: "ADMIN" })(request);
  }

  const { withErrorHandling } = await import("@/server/http/respond");
  return withErrorHandling(async () => {
    throw new Error(`Unknown action "${action}".`);
  })(request);
}
