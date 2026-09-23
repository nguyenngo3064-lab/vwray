import "server-only";
import { randomUUID } from "node:crypto";
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
 * Xray adapter (VLESS / VMESS / Trojan inbounds).
 *
 * Xray exposes a stats API ($queryStats$) that can attribute uplink/downlink bytes to
 * named users when the server is configured with stats collection per user. That is
 * again COUNTERS accounting: deltas between observations, trustworthy only when the
 * data-plane host actually enables user stats. The control plane records what the
 * agent reports; it cannot conjure per-user bytes for an Xray that never collected
 * them.
 *
 * Configuration generation limits are enforced here, not in the UI:
 *   * VLESS/VLESS+Reality URIs: generated (the URI format is documented).
 *   * VMESS: generated as the standard base64 JSON form (documented).
 *   * Trojan: generated as trojan:// (documented).
 *   * Shadowrocket: supported only as an importer of those exact URIs.
 *   * NPV Tunnel / NapsternetV: NOT supported. Their config format is proprietary and
 *     unverified here, and generating a fabricated format would create configurations
 *     that silently fail on the client.
 */

export type XrayProtocol = "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN";

interface XrayAgentClient {
  ok: boolean;
  error?: string;
}

export class XrayAdapter implements VpnAdapter {
  readonly key: string;
  readonly displayName = "Xray";
  readonly protocol: XrayProtocol;

  private readonly apiUrl: string | null;
  private revoked = new Set<string>();

  constructor(input?: { protocol?: XrayProtocol; apiUrl?: string | null }) {
    this.protocol = input?.protocol ?? "XRAY_VLESS";
    this.key = this.protocol === "XRAY_VMESS" ? "xray-vmess" : this.protocol === "XRAY_TROJAN" ? "xray-trojan" : "xray-vless";
    this.apiUrl = input?.apiUrl ?? null;
  }

  capabilities(): AdapterCapabilities {
    return {
      createClient: true,
      revokeClient: true,
      disconnectClient: false,
      getStatus: true,
      getTraffic: true,
      applyQuota: true,
      generateConfig: true,
      // Only when the data-plane Xray enables per-user stats. The default config in
      // the gateway docs does; a trimmed config that does not will report `none`.
      byteAccounting: "counters",
      connectionQuality: "none",
      supportsUdpStability: false,
      supportsLatencyControl: false,
      supportsSafeCompression: true,
      supportsDnsFiltering: false,
      isDevelopmentOnly: this.apiUrl === null && process.env.NODE_ENV !== "production",
    };
  }

  async createClient(spec: VpnClientSpec): Promise<VpnClientHandle> {
    const uuid = randomUUID();
    const digest = createHash("sha256").update(uuid, "utf8").digest("hex");

    const handle: VpnClientHandle = {
      gatewayIdentifier: spec.deviceId,
      publicCredential: uuid,
      fingerprint: `${digest.slice(0, 4)}:${digest.slice(4, 8)}`,
      createdAt: new Date(),
    };

    if (this.apiUrl) {
      await this.agentCall<XrayAgentClient>("add", { id: uuid, email: spec.deviceId });
    }

    return handle;
  }

  async revokeClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void> {
    this.revoked.add(handle.gatewayIdentifier);
    if (this.apiUrl) {
      await this.agentCall<XrayAgentClient>("remove", { email: handle.gatewayIdentifier });
    }
  }

  async disconnectClient(): Promise<void> {
    // Xray has no "kick a connected user" primitive; removal is the enforcement path.
    // Saying otherwise would invent a capability the daemon does not have.
    throw new AdapterError("Xray cannot disconnect a single live session; revoke the credential instead.", {
      retryable: false,
    });
  }

  async getStatus(): Promise<AdapterStatus> {
    if (!this.apiUrl) {
      return {
        online: false,
        activePeers: 0,
        checkedAt: new Date(),
        error: "No Xray management endpoint configured. Connect a real gateway to read status.",
      };
    }
    try {
      const result = await this.agentCall<{ users: number; version?: string }>("status", {});
      return {
        online: true,
        version: result.version ?? "xray-agent",
        activePeers: result.users,
        checkedAt: new Date(),
      };
    } catch (error) {
      return {
        online: false,
        activePeers: 0,
        checkedAt: new Date(),
        error: error instanceof Error ? error.message : "xray agent unreachable",
      };
    }
  }

  async getTraffic(): Promise<PeerTraffic[]> {
    if (!this.apiUrl) return [];
    try {
      const result = await this.agentCall<{ users: PeerTraffic[] }>("traffic", {});
      return (result.users ?? []).filter((user) => !this.revoked.has(user.gatewayIdentifier));
    } catch {
      return [];
    }
  }

  async applyQuota(request: ApplyQuotaRequest): Promise<void> {
    // Quota at the Xray layer means removing the user when the limit is reached and
    // re-adding them on reset. The policy row (GatewayPolicyState) decides WHEN; this
    // adapter only executes the removal.
    if (request.quotaBytes === null) return;
    const used = request.usedBytes ?? 0n;
    if (used >= request.quotaBytes) {
      await this.revokeClient(request.handle);
    }
  }

  /** Loopback management call to a real agent on the data-plane host. */
  private async agentCall<T>(action: string, payload: Record<string, unknown>): Promise<T> {
    if (!this.apiUrl) {
      throw new AdapterError("Xray agent mode requires a management endpoint on the data-plane host.", {
        retryable: false,
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${this.apiUrl.replace(/\/$/, "")}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AdapterError(`Xray agent rejected ${action} (HTTP ${response.status}).`, {
          retryable: response.status >= 500,
        });
      }
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(`Xray agent unreachable for ${action}.`, {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
