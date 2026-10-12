import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { allowedIpsFor, generateConfig } from "@/server/configs/service";
import { resetEnvCache } from "@/server/config/env";
import { detectWireGuardState } from "../vwray-node/src/config";
import { resetDatabase, seedFixture } from "./helpers/db";
/**
 * WireGuard config lifecycle and agent interface observation.
 *
 * Configs are rendered from real database rows (approved device + approved,
 * heartbeat-fresh node) with a stubbed server public key. Tunnel addresses must
 * be unique per device, and mode (FULL/SPLIT) decides AllowedIPs.
 */

async function readyNodeAndDevice() {
  const fixture = await seedFixture({ approvalState: "APPROVED" });
  const { prisma } = await import("@/server/db/client");
  await prisma.vpnNode.update({
    where: { id: fixture.nodeId },
    data: { approvalState: "APPROVED", approvedAt: new Date(), lastHeartbeatAt: new Date() },
  });
  return fixture;
}

beforeEach(async () => {
  // The env module memoises on first use; module import order sets the value
  // before this file can assign the test key, so clear it here.
  process.env.WIREGUARD_SERVER_PUBLIC_KEY = "dGVzdC1zZXJ2ZXItcHVibGljLWtleS0zMmJ5dGVzLWE=";
  resetEnvCache();
  await resetDatabase();
});

describe("allowedIpsFor", () => {
  it("renders full-tunnel and split-tunnel policies", () => {
    expect(allowedIpsFor("FULL")).toBe("0.0.0.0/0, ::/0");
    const split = allowedIpsFor("SPLIT");
    expect(split).toContain("10.200.0.0/24");
    expect(split).not.toContain("0.0.0.0/0");
  });
});

describe("generateConfig (WireGuard)", () => {
  it("renders a real .conf with a unique tunnel address per device", async () => {
    const fixture = await readyNodeAndDevice();
    const { prisma } = await import("@/server/db/client");
    const actor = { actorId: fixture.userId, actorLabel: "owner" };

    const first = await generateConfig({
      name: "laptop-profile",
      deviceId: fixture.deviceId,
      nodeId: fixture.nodeId,
      protocol: "WIREGUARD",
      ...actor,
    });
    expect(first.format).toBe("wireguard");
    expect(first.payload).toContain("[Interface]");
    expect(first.payload).toContain("Address = 10.200.0.2/32");
    expect(first.payload).toContain("AllowedIPs = 0.0.0.0/0, ::/0");
    expect(first.payload).toContain("Endpoint = 127.0.0.1:51820");

    // Private key material leaves the function only inside the payload.
    const credentials = await prisma.deviceCredential.findMany({ where: { deviceId: fixture.deviceId } });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]?.tunnelAddress).toBe("10.200.0.2");
    expect(credentials[0]?.publicKey).not.toContain("PrivateKey");

    const secondDevice = await prisma.device.create({
      data: {
        deviceId: "dev_test0002",
        displayName: "Second",
        client: "wireguard",
        platform: "android",
        approvalState: "APPROVED",
        connectionStatus: "OFFLINE",
        assignedNodeId: fixture.nodeId,
        ownerUserId: fixture.userId,
        observedSourceIps: [],
        approvedById: fixture.userId,
        approvedAt: new Date(),
      },
    });
    const second = await generateConfig({
      name: "phone-profile",
      deviceId: secondDevice.id,
      nodeId: fixture.nodeId,
      protocol: "WIREGUARD",
      ...actor,
    });
    expect(second.payload).toContain("Address = 10.200.0.3/32");
  });

  it("refuses unapproved devices and stale nodes", async () => {
    const fixture = await readyNodeAndDevice();
    const { prisma } = await import("@/server/db/client");
    const actor = { actorId: fixture.userId, actorLabel: "owner" };

    const pendingDevice = await prisma.device.create({
      data: {
        deviceId: "dev_pending01",
        displayName: "Pending",
        client: "wireguard",
        platform: "linux",
        approvalState: "PENDING",
        connectionStatus: "OFFLINE",
        assignedNodeId: fixture.nodeId,
        ownerUserId: fixture.userId,
        observedSourceIps: [],
      },
    });
    await expect(
      generateConfig({ name: "x", deviceId: pendingDevice.id, nodeId: fixture.nodeId, protocol: "WIREGUARD", ...actor }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await prisma.vpnNode.update({
      where: { id: fixture.nodeId },
      data: { lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    await expect(
      generateConfig({ name: "y", deviceId: fixture.deviceId, nodeId: fixture.nodeId, protocol: "WIREGUARD", ...actor }),
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });
});

describe("detectWireGuardState (agent)", () => {
  const nothing = {
    existsSync: () => false,
    readFileSync: () => "",
  };
  const up = {
    existsSync: () => true,
    readFileSync: () => "1\n",
  };
  const noCarrier = {
    existsSync: () => true,
    readFileSync: () => "0\n",
  };
  const unreadable = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("EACCES");
    },
  };

  it("maps interface presence to DOWN / READY / UNKNOWN honestly", () => {
    expect(detectWireGuardState("wg0", nothing).state).toBe("DOWN");
    expect(detectWireGuardState("wg0", up)).toMatchObject({ state: "READY" });
    expect(detectWireGuardState("wg0", noCarrier).state).toBe("DOWN");
    expect(detectWireGuardState("wg0", unreadable).state).toBe("UNKNOWN");
  });

  it("rejects hostile interface names (no path traversal)", () => {
    expect(detectWireGuardState("../../etc/shadow", up).state).toBe("UNKNOWN");
    expect(detectWireGuardState("wg0; rm -rf /", up).state).toBe("UNKNOWN");
  });
});
