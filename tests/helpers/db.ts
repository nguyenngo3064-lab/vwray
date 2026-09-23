import { Prisma } from "@prisma/client";
import { prisma } from "@/server/db/client";

/**
 * Test database helpers.
 *
 * `resetDatabase` truncates every table (except Prisma's migration ledger) in one
 * statement, which is both fast and order-independent because of `CASCADE`. Suites
 * call it in `beforeEach` so tests never depend on execution order.
 */

// Ordered child-first for readability; CASCADE makes the order non-critical.
const TABLES = [
  "notification",
  "anomaly_event",
  "maintenance_run",
  "webhook_endpoint",
  "system_setting",
  "audit_log",
  "receipt",
  "cost_record",
  "billing_config",
  "optimization_record",
  "optimization_profile",
  "dns_query_stat",
  "dns_list_entry",
  "dns_list",
  "traffic_destination",
  "traffic_aggregate",
  "traffic_sample",
  "gateway_policy_state",
  "quota",
  "vpn_session",
  "config_version",
  "vpn_config",
  "device_credential",
  "device",
  "node_pool_policy",
  "node_health_sample",
  "vpn_node",
  "api_key",
  "auth_attempt",
  "admin_session",
  "access_code",
  "admin_user",
];

export async function resetDatabase(): Promise<void> {
  const list = TABLES.map((table) => `"${table}"`).join(", ");
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE;`);
}

export interface SeededFixture {
  userId: string;
  accessCodeId: string;
  nodeId: string;
  deviceId: string;
  profileId: string;
  billingConfigId: string;
}

/** Minimal fixture used by most suites: one operator, one node, one approved device. */
export async function seedFixture(overrides?: {
  deviceQuotaBytes?: bigint | null;
  approvalState?: "PENDING" | "APPROVED" | "REJECTED" | "BLOCKED";
  nodeIsReal?: boolean;
}): Promise<SeededFixture> {
  const user = await prisma.adminUser.create({
    data: { username: "operator", displayName: "Test operator", role: "OWNER", status: "ACTIVE" },
  });

  const accessCode = await prisma.accessCode.create({
    data: {
      label: "test code",
      codeHint: "TEST-....-CODE",
      // Any well-formed hash works: these tests never verify this value.
      codeHash: "scrypt$16384$8$1$c2FsdA$aGFzaA",
      role: "OWNER",
      createdById: user.id,
    },
  });

  const profile = await prisma.optimizationProfile.create({
    data: {
      key: "DATA_SAVER",
      name: "Data saver",
      description: "Test profile",
      builtin: true,
      targetSavingMinPct: 30,
      targetSavingMaxPct: 60,
      requiredCapabilities: [],
    },
  });

  const node = await prisma.vpnNode.create({
    data: {
      nodeId: "node_test01",
      name: "Test node",
      location: "local",
      publicEndpoint: "127.0.0.1",
      port: 51820,
      protocol: "WIREGUARD",
      health: "ONLINE",
      agentTokenHash: "unused-in-tests",
      agentTokenHint: "test...node",
      adapterKey: "wireguard",
      isRealGateway: overrides?.nodeIsReal ?? true,
      lastHeartbeatAt: new Date(),
      tags: [],
    },
  });

  const device = await prisma.device.create({
    data: {
      deviceId: "dev_test0001",
      displayName: "Test laptop",
      client: "wireguard",
      platform: "linux",
      approvalState: overrides?.approvalState ?? "APPROVED",
      connectionStatus: "OFFLINE",
      assignedNodeId: node.id,
      optimizationProfileId: profile.id,
      ownerUserId: user.id,
      observedSourceIps: [],
      approvedById: user.id,
      approvedAt: new Date(),
    },
  });

  if (overrides?.deviceQuotaBytes) {
    await prisma.quota.create({
      data: {
        scope: "DEVICE",
        scopeRefId: device.id,
        label: "device quota",
        limitBytes: overrides.deviceQuotaBytes,
        period: "MONTHLY",
        resetPolicy: "MANUAL",
        deviceId: device.id,
      },
    });
  }

  const billingConfig = await prisma.billingConfig.create({
    data: {
      name: "test",
      active: true,
      currency: "VND",
      baseFee: new Prisma.Decimal(15000),
      pricePerGb: new Prisma.Decimal(25000),
      freeQuotaGb: new Prisma.Decimal(0),
      billingPeriod: "MONTHLY",
      periodStartDay: 1,
      providerLabel: "VWRAY",
    },
  });

  return {
    userId: user.id,
    accessCodeId: accessCode.id,
    nodeId: node.id,
    deviceId: device.id,
    profileId: profile.id,
    billingConfigId: billingConfig.id,
  };
}

/** Convenience re-export so suites import one module. */
export { prisma };
