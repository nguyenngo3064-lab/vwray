import "server-only";
import { randomBytes } from "node:crypto";
import {
  AdapterError,
  type AdapterCapabilities,
  type AdapterStatus,
  type ApplyQuotaRequest,
  type PeerTraffic,
  type VpnAdapter,
  type VpnClientHandle,
  type VpnClientSpec,
} from "@/server/vpn/types";

/**
 * Development-only mock gateway.
 *
 * This adapter pretends to be a data plane so the rest of the system (ingest,
 * realtime, quota, analytics) can be exercised locally. It is the ONLY adapter that
 * may be attached to a node with `isRealGateway = false`, it always reports its
 * traffic as `source = MOCK`, and it refuses to operate in production.
 *
 * The guard is enforced in the constructor so that even a code path that forgets to
 * check the environment cannot accidentally use it where real traffic is measured.
 */

export class MockGatewayAdapter implements VpnAdapter {
  readonly key = "mock";
  readonly displayName = "Mock gateway (development only)";
  readonly protocol = "MOCK" as const;

  private readonly peers = new Map<string, { createdAt: Date; quotaBytes: bigint | null; revokedAt: Date | null }>();

  constructor() {
    if (process.env.NODE_ENV === "production") {
      throw new AdapterError("The mock gateway adapter is refused in production.", { retryable: false });
    }
  }

  capabilities(): AdapterCapabilities {
    return {
      createClient: true,
      revokeClient: true,
      disconnectClient: true,
      getStatus: true,
      getTraffic: false,
      applyQuota: true,
      generateConfig: false,
      byteAccounting: "none",
      connectionQuality: "none",
      supportsUdpStability: false,
      supportsLatencyControl: false,
      supportsSafeCompression: false,
      supportsDnsFiltering: false,
      isDevelopmentOnly: true,
    };
  }

  async createClient(spec: VpnClientSpec): Promise<VpnClientHandle> {
    const credential = randomBytes(16).toString("hex");
    const handle: VpnClientHandle = {
      gatewayIdentifier: `mock:${spec.deviceId}`,
      publicCredential: credential,
      fingerprint: `mock:${credential.slice(0, 8)}`,
      createdAt: new Date(),
    };
    this.peers.set(handle.gatewayIdentifier, {
      createdAt: handle.createdAt,
      quotaBytes: spec.quotaBytes ?? null,
      revokedAt: null,
    });
    return handle;
  }

  async revokeClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void> {
    const peer = this.peers.get(handle.gatewayIdentifier);
    if (peer) peer.revokedAt = new Date();
  }

  async disconnectClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void> {
    const peer = this.peers.get(handle.gatewayIdentifier);
    if (peer && !peer.revokedAt) {
      // No-op in memory; present so the disconnect path is exercised end to end.
    }
  }

  async getStatus(): Promise<AdapterStatus> {
    return {
      online: true,
      version: "mock-gateway (development only, no real peers)",
      activePeers: Array.from(this.peers.values()).filter((peer) => !peer.revokedAt).length,
      checkedAt: new Date(),
    };
  }

  async getTraffic(): Promise<PeerTraffic[]> {
    return [];
  }

  async applyQuota(request: ApplyQuotaRequest): Promise<void> {
    const peer = this.peers.get(request.handle.gatewayIdentifier);
    if (peer) peer.quotaBytes = request.quotaBytes;
  }
}
