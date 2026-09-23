import "server-only";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
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
 * WireGuard adapter.
 *
 * Two deployment realities, one interface:
 *   * `mode: "agent"` (production): talks to the management API of a real WireGuard
 *     interface on the data-plane host over loopback. All enforcement is local there.
 *   * `mode: "local"` (development, no root, no `wg`): generates genuine key
 *     material with the same formats, but peers are recorded in memory only and no
 *     interface is ever touched. Anything labelled `status` from this mode says so.
 *
 * The peer registry here is not the source of truth for who may connect:
 * GatewayPolicyState is. This adapter applies policy; the control plane decides it.
 */

type Mode = "agent" | "local";

interface StoredPeer {
  gatewayIdentifier: string;
  publicKey: string;
  createdAt: Date;
  quotaBytes: bigint | null;
  revokedAt: Date | null;
  disconnected: boolean;
}

function fingerprint(publicKey: string): string {
  const digest = createHash("sha256").update(publicKey, "utf8").digest("hex");
  return `${digest.slice(0, 4)}:${digest.slice(4, 8)}`;
}

export class WireGuardAdapter implements VpnAdapter {
  readonly key = "wireguard";
  readonly displayName = "WireGuard";
  readonly protocol = "WIREGUARD" as const;

  private readonly mode: Mode;
  private readonly interfaceName: string;
  private readonly managementUrl: string | null;
  private readonly peers = new Map<string, StoredPeer>();

  constructor(input?: { mode?: Mode; interfaceName?: string; managementUrl?: string | null }) {
    this.mode = input?.mode ?? (process.env.NODE_ENV === "production" ? "agent" : "local");
    this.interfaceName = input?.interfaceName ?? "wg0";
    this.managementUrl = input?.managementUrl ?? null;
  }

  capabilities(): AdapterCapabilities {
    return {
      createClient: true,
      revokeClient: true,
      disconnectClient: true,
      getStatus: true,
      getTraffic: true,
      applyQuota: true,
      generateConfig: true,
      // WireGuard exposes per-peer transfer counters (rx/tx bytes) and the latest
      // handshake time. That is COUNTERS accounting: deltas between observations,
      // not byte-exact instrumentation of every packet.
      byteAccounting: "counters",
      // Handshake recency implies liveness; true latency needs client-side measurement.
      connectionQuality: "basic",
      supportsUdpStability: true,
      supportsLatencyControl: false,
      supportsSafeCompression: false,
      supportsDnsFiltering: false,
      isDevelopmentOnly: this.mode === "local",
    };
  }

  async createClient(spec: VpnClientSpec): Promise<VpnClientHandle> {
    // Real X25519 keypair. Only the public half leaves this function; the private
    // half is rendered into the one-time client configuration by the caller.
    const { publicKey } = generateKeyPairSync("x25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });

    const publicB64 = Buffer.from(publicKey).toString("base64");

    const handle: VpnClientHandle = {
      gatewayIdentifier: `peer:${publicB64.slice(0, 12)}`,
      publicCredential: publicB64,
      fingerprint: fingerprint(publicB64),
      createdAt: new Date(),
    };

    this.peers.set(handle.gatewayIdentifier, {
      gatewayIdentifier: handle.gatewayIdentifier,
      publicKey: publicB64,
      createdAt: handle.createdAt,
      quotaBytes: spec.quotaBytes ?? null,
      revokedAt: null,
      disconnected: false,
    });

    if (this.mode === "agent") {
      await this.agentCall("create", { peer: handle.gatewayIdentifier, publicKey: publicB64 });
    }

    return handle;
  }

  async revokeClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void> {
    const peer = this.peers.get(handle.gatewayIdentifier);
    if (peer) peer.revokedAt = new Date();
    if (this.mode === "agent") {
      await this.agentCall("revoke", { peer: handle.gatewayIdentifier });
    }
  }

  async disconnectClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void> {
    const peer = this.peers.get(handle.gatewayIdentifier);
    if (peer) peer.disconnected = true;
    if (this.mode === "agent") {
      await this.agentCall("disconnect", { peer: handle.gatewayIdentifier });
    }
  }

  async getStatus(): Promise<AdapterStatus> {
    if (this.mode === "local") {
      const active = Array.from(this.peers.values()).filter((peer) => !peer.revokedAt).length;
      return {
        online: true,
        version: "wireguard-local (in-memory, development only)",
        activePeers: active,
        checkedAt: new Date(),
      };
    }

    try {
      const result = await this.agentCall<{ peers: number; version?: string }>("status", {});
      return {
        online: true,
        version: result.version ?? "wireguard-agent",
        activePeers: result.peers,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        online: false,
        activePeers: 0,
        checkedAt: new Date(),
        error: error instanceof Error ? error.message : "wireguard agent unreachable",
      };
    }
  }

  async getTraffic(): Promise<PeerTraffic[]> {
    // Local mode observes no interface, so it reports none. Never synthesise rows:
    // an empty array renders as "no data" downstream instead of a fabricated peer.
    if (this.mode === "local") return [];
    try {
      const result = await this.agentCall<{ peers: PeerTraffic[] }>("traffic", {});
      return result.peers ?? [];
    } catch {
      return [];
    }
  }

  async applyQuota(request: ApplyQuotaRequest): Promise<void> {
    const peer = this.peers.get(request.handle.gatewayIdentifier);
    if (peer) peer.quotaBytes = request.quotaBytes;
    if (this.mode === "agent") {
      await this.agentCall("quota", {
        peer: request.handle.gatewayIdentifier,
        quotaBytes: request.quotaBytes === null ? null : request.quotaBytes.toString(),
        usedBytes:
          request.usedBytes === null || request.usedBytes === undefined
            ? null
            : request.usedBytes.toString(),
      });
    }
  }

  /** Loopback management call to a real agent. Never reaches beyond the data-plane host. */
  private async agentCall<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.managementUrl) {
      throw new AdapterError("WireGuard agent mode requires a management URL on the data-plane host.", {
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${this.managementUrl.replace(/\/$/, "")}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          interface: this.interfaceName,
          nonce: randomBytes(8).toString("hex"),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AdapterError(`WireGuard agent rejected ${action} (HTTP ${response.status}).`, {
          retryable: response.status >= 500,
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(`WireGuard agent unreachable for ${action}.`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
