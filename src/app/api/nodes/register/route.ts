import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { readJson, sourceIpOf } from "@/server/http/guard";
import { getEnv } from "@/server/config/env";
import { errors } from "@/server/lib/errors";
import { safeEqual } from "@/server/lib/ids";
import { registerNodeAgent } from "@/server/nodes/service";

const registrationSchema = z.object({
  nodeId: z.string().min(1).max(100),
  name: z.string().min(1).max(80),
  location: z.string().min(1).max(80),
  publicEndpoint: z.string().min(1).max(120),
  port: z.coerce.number().int().min(1).max(65535),
  protocol: z.enum(["WIREGUARD", "XRAY_VLESS", "XRAY_VMESS", "XRAY_TROJAN", "MOCK"]),
  capabilities: z.array(z.string().max(60)).max(30).default([]),
  isRealGateway: z.boolean().default(false),
});

export const POST = withErrorHandling(async (request: Request) => {
  const configured = getEnv().NODE_ENROLLMENT_TOKEN;
  const supplied = request.headers.get("x-vwray-enrollment-token") ?? "";
  if (!configured || !safeEqual(supplied, configured)) {
    throw errors.unauthenticated("A valid node enrollment token is required.");
  }

  const parsed = registrationSchema.safeParse(await readJson(request));
  if (!parsed.success) throw errors.validation("The node registration payload is invalid.");

  const registered = await registerNodeAgent({ ...parsed.data, sourceIp: sourceIpOf(request) });
  return jsonOk(
    { node: { id: registered.id, nodeId: registered.nodeId }, agentToken: registered.agentToken },
    { status: 201 },
  );
});