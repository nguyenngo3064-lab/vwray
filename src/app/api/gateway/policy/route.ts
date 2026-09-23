import "server-only";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { authenticateAgent } from "@/server/gateway/auth";
import { getSetting } from "@/server/settings/service";
import { prisma } from "@/server/db/client";
import { resolvePolicy } from "@/server/gateway/policy";

/**
 * Policy pull (CONTROL PLANE -> DATA PLANE).
 *
 * This endpoint is the enforcement contract. Quota breaches, blocks, revocations and
 * PRIVATE MODE rejections all land here as `GatewayPolicyState` rows, and the agent
 * applies them LOCALLY. Consequences that make this the right design:
 *
 *   * a control-plane outage cannot silently re-enable a device that was blocked,
 *   * the agent needs no credentials of its own to make an allow/deny decision,
 *   * `revision` is monotonic, so an agent detects change without diffing payloads.
 *
 * A device that is PENDING, REJECTED or BLOCKED appears with a deliberately generic
 * `reason`: whatever the agent reports to the client must be client-safe, because a
 * rejected device can read it. The real operator note stays in the console.
 */
export const GET = withErrorHandling(async (request: Request) => {
  const { node } = await authenticateAgent(request);

  const [devices, policies, dnsEnabled, rejectMessage] = await Promise.all([
    prisma.device.findMany({
      where: { assignedNodeId: node.id },
      select: {
        id: true,
        deviceId: true,
        approvalState: true,
        connectionStatus: true,
        quotaExceededAt: true,
        blockedAt: true,
        optimizationProfileId: true,
        assignedConfig: { select: { status: true, expiresAt: true } },
        optimizationProfile: {
          select: {
            key: true,
            dnsFilteringLevel: true,
            compressionEnabled: true,
            mediaOptimization: true,
            latencyPriority: true,
            udpStability: true,
            lowQueueing: true,
            aggressiveFiltering: true,
            routingPolicy: true,
          },
        },
        quotas: {
          where: { scope: "DEVICE", enabled: true },
          select: { limitBytes: true, usedBytes: true },
        },
      },
      take: 5_000,
    }),
    prisma.gatewayPolicyState.findMany({
      where: { OR: [{ nodeId: node.id }, { nodeId: null, device: { assignedNodeId: node.id } }] },
      orderBy: { revision: "desc" },
      select: { deviceId: true, state: true, reason: true, revision: true },
    }),
    getSetting<boolean>("dns.filteringEnabled").catch(() => false),
    getSetting<string>("auth.rejectMessage").catch(
      () => "This device is not authorised to connect.",
    ),
  ]);

  const latestPolicy = new Map<string, (typeof policies)[number]>();
  for (const policy of policies) {
    if (!latestPolicy.has(policy.deviceId)) latestPolicy.set(policy.deviceId, policy);
  }

  const peers = devices.map((device) => {
    const policy = latestPolicy.get(device.id);
    const quota = device.quotas[0];
    const configExpired =
      device.assignedConfig?.expiresAt != null &&
      device.assignedConfig.expiresAt.getTime() < Date.now();

    return {
      deviceId: device.deviceId,
      internalId: device.id,
      ...resolvePolicy(device, policy, configExpired, rejectMessage),
      revision: policy?.revision ?? 0,
      quotaBytes: quota ? quota.limitBytes.toString() : null,
      usedBytes: quota ? quota.usedBytes.toString() : null,
      profile: device.optimizationProfile
        ? {
            key: device.optimizationProfile.key,
            dnsFilteringLevel: device.optimizationProfile.dnsFilteringLevel,
            compressionEnabled: device.optimizationProfile.compressionEnabled,
            mediaOptimization: device.optimizationProfile.mediaOptimization,
            latencyPriority: device.optimizationProfile.latencyPriority,
            udpStability: device.optimizationProfile.udpStability,
            lowQueueing: device.optimizationProfile.lowQueueing,
            aggressiveFiltering: device.optimizationProfile.aggressiveFiltering,
            routingPolicy: device.optimizationProfile.routingPolicy,
          }
        : null,
    };
  });

  const maxRevision = policies.reduce((max, policy) => Math.max(max, policy.revision), 0);

  return jsonOk({
    nodeId: node.nodeId,
    generatedAt: new Date().toISOString(),
    policyRevision: maxRevision,
    peers,
    dns: { enabled: dnsEnabled },
    summary: {
      total: peers.length,
      blocked: peers.filter((peer) => peer.state === "BLOCKED").length,
      quotaExceeded: peers.filter((peer) => peer.state === "QUOTA_EXCEEDED").length,
      revoked: peers.filter((peer) => peer.state === "REVOKED").length,
      active: peers.filter((peer) => peer.state === "ACTIVE").length,
    },
  });
});
