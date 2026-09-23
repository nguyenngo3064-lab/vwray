import "server-only";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { record } from "@/server/audit";
import { getSetting } from "@/server/settings/service";
import { getAdapter } from "@/server/vpn/registry";
import { notify } from "@/server/notifications/service";

export interface ProfileView {
  id: string;
  key: string;
  name: string;
  description: string;
  builtin: boolean;
  enabled: boolean;
  dnsFilteringLevel: string;
  dnsBlocklistCategories: string[];
  compressionEnabled: boolean;
  mediaOptimization: boolean;
  latencyPriority: boolean;
  udpStability: boolean;
  lowQueueing: boolean;
  aggressiveFiltering: boolean;
  routingPolicy: string;
  targetSavingMinPct: number;
  targetSavingMaxPct: number;
  requiredCapabilities: string[];
  deviceCount: number;
  updatedAt: string;
}

export async function listProfiles(): Promise<{
  profiles: ProfileView[];
  defaultProfileKey: string;
  targetRange: { min: number; max: number };
  minSampleBytesForActualSavings: string;
  capabilityMatrix: Array<{
    adapterKey: string;
    displayName: string;
    capabilities: Record<string, boolean | string>;
    supportedProfiles: string[];
    unsupportedProfileReasons: Record<string, string>;
  }>;
  assignedCounts: Record<string, number>;
}> {
  const [rows, counts, targetMin, targetMax, minSample, defaultKey, nodes] = await Promise.all([
    prisma.optimizationProfile.findMany({ orderBy: { key: "asc" } }),
    prisma.device.groupBy({ by: ["optimizationProfileId"], _count: { _all: true } }),
    getSetting<number>("optimization.targetSavingMinPct"),
    getSetting<number>("optimization.targetSavingMaxPct"),
    getSetting<string>("optimization.minSampleBytesForActualSavings"),
    getSetting<string>("optimization.defaultProfileKey"),
    prisma.vpnNode.findMany({ select: { adapterKey: true } }),
  ]);

  const byProfile = new Map<string, number>();
  for (const row of counts) {
    if (row.optimizationProfileId) byProfile.set(row.optimizationProfileId, row._count._all);
  }

  const adapterKeys = [...new Set(nodes.map((node) => node.adapterKey))];
  const capabilityMatrix = adapterKeys.map((adapterKey) => {
    const adapter = getAdapter(adapterKey);
    const caps = adapter.capabilities();
    const supportedProfiles: string[] = [];
    const unsupportedProfileReasons: Record<string, string> = {};
    for (const profile of rows) {
      const missing: string[] = [];
      if (profile.dnsFilteringLevel !== "off" && !caps.supportsDnsFiltering) {
        missing.push("DNS filtering (the gateway reports no DNS filtering support)");
      }
      if (profile.compressionEnabled && !caps.supportsSafeCompression) {
        missing.push("safe compression (the gateway reports no safe compression support)");
      }
      if (profile.udpStability && !caps.supportsUdpStability) {
        missing.push("UDP stability (the gateway reports no UDP stability support)");
      }
      if (profile.latencyPriority && !caps.supportsLatencyControl) {
        missing.push("latency priority (the gateway reports no latency control support)");
      }
      if (missing.length === 0) supportedProfiles.push(profile.key);
      else unsupportedProfileReasons[profile.key] = `Inactive on this gateway: ${missing.join("; ")}.`;
    }
    return {
      adapterKey,
      displayName: adapter.displayName,
      capabilities: {
        supportsDnsFiltering: caps.supportsDnsFiltering,
        supportsSafeCompression: caps.supportsSafeCompression,
        supportsUdpStability: caps.supportsUdpStability,
        supportsLatencyControl: caps.supportsLatencyControl,
        byteAccounting: caps.byteAccounting,
        connectionQuality: caps.connectionQuality,
        isDevelopmentOnly: caps.isDevelopmentOnly,
      },
      supportedProfiles,
      unsupportedProfileReasons,
    };
  });

  return {
    profiles: rows.map((profile) => ({
      ...profile,
      updatedAt: profile.updatedAt.toISOString(),
      deviceCount: byProfile.get(profile.id) ?? 0,
    })),
    defaultProfileKey: defaultKey,
    targetRange: { min: targetMin, max: targetMax },
    minSampleBytesForActualSavings: String(minSample),
    capabilityMatrix,
    assignedCounts: Object.fromEntries(byProfile),
  };
}

const PROFILE_KEYS = ["BALANCED", "DATA_SAVER", "GAMING", "VIDEO_SAVER", "MAXIMUM_SAVING"] as const;

export function assertProfileKey(key: string): void {
  if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
    throw errors.validation(`"${key}" is not one of the five supported optimization profiles.`);
  }
}

export async function updateProfile(input: {
  id: string;
  patch: Record<string, unknown>;
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ id: string }> {
  const profile = await prisma.optimizationProfile.findUnique({ where: { id: input.id } });
  if (!profile) throw errors.notFound("Optimization profile");

  const allowed: Record<string, (value: unknown) => unknown> = {
    name: (value) => String(value).slice(0, 80),
    description: (value) => String(value).slice(0, 500),
    enabled: (value) => Boolean(value),
    dnsFilteringLevel: (value) => String(value).slice(0, 20),
    dnsBlocklistCategories: (value) =>
      Array.isArray(value) ? value.map((entry) => String(entry).slice(0, 60)).slice(0, 40) : [],
    compressionEnabled: (value) => Boolean(value),
    mediaOptimization: (value) => Boolean(value),
    latencyPriority: (value) => Boolean(value),
    udpStability: (value) => Boolean(value),
    lowQueueing: (value) => Boolean(value),
    aggressiveFiltering: (value) => Boolean(value),
    routingPolicy: (value) => String(value).slice(0, 60),
    targetSavingMinPct: (value) => Math.max(0, Math.min(100, Number(value) || 0)),
    targetSavingMaxPct: (value) => Math.max(0, Math.min(100, Number(value) || 0)),
  };

  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input.patch)) {
    const coerce = allowed[key];
    if (coerce) data[key] = coerce(value);
  }
  if (Object.keys(data).length === 0) throw errors.validation("No updatable profile field was provided.");

  await prisma.optimizationProfile.update({ where: { id: profile.id }, data });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "optimization.profile_updated",
    resource: "optimization_profile",
    resourceId: profile.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { key: profile.key, changed: Object.keys(data) },
  });

  await notify({
    type: "optimization.changed",
    severity: "INFO",
    title: "Optimization profile updated",
    body: `${profile.name} was updated by ${input.actorLabel}.`,
    resource: "optimization_profile",
    resourceId: profile.id,
  });

  return { id: profile.id };
}

export async function assignProfile(input: {
  profileId: string;
  deviceIds: string[];
  actorId: string;
  actorLabel: string;
  sourceIp?: string | null;
}): Promise<{ assigned: number }> {
  const profile = await prisma.optimizationProfile.findUnique({ where: { id: input.profileId } });
  if (!profile) throw errors.notFound("Optimization profile");

  const result = await prisma.device.updateMany({
    where: { id: { in: input.deviceIds } },
    data: { optimizationProfileId: profile.id },
  });

  await record({
    actor: { type: "USER", id: input.actorId, label: input.actorLabel },
    action: "optimization.assigned",
    resource: "optimization_profile",
    resourceId: profile.id,
    result: "SUCCESS",
    sourceIp: input.sourceIp,
    metadata: { key: profile.key, requested: input.deviceIds.length, assigned: result.count },
  });

  return { assigned: result.count };
}
