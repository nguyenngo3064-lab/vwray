/**
 * VPN adapter contract.
 *
 * Each adapter drives one gateway technology (WireGuard, Xray, ...). The interface is
 * identical whether the adapter runs:
 *   1. inside the gateway agent process on the data-plane host (real enforcement), or
 *   2. against a mock that only pretends to have peers (development only).
 *
 * This is the correct seam for the control-plane/data-plane split: the console never
 * calls `wg` or touches an Xray socket; it stores policy (GatewayPolicyState) that an
 * agent applies through one of these implementations.
 *
 * Capability reporting is honest by contract: an adapter that cannot measure
 * per-peer bytes MUST report `byteAccounting: "none"`, and everything downstream
 * (optimization analytics, savings claims) keys off that to say "Unavailable"
 * instead of inventing numbers.
 */

export type ByteAccounting = "none" | "counters" | "byte-exact";

export interface AdapterCapabilities {
  createClient: boolean;
  revokeClient: boolean;
  disconnectClient: boolean;
  getStatus: boolean;
  getTraffic: boolean;
  applyQuota: boolean;
  generateConfig: boolean;
  /** Whether the gateway can count per-peer bytes truthfully. */
  byteAccounting: ByteAccounting;
  /** Whether latency/jitter/loss can be measured without lying. */
  connectionQuality: "none" | "basic" | "full";
  supportsUdpStability: boolean;
  supportsLatencyControl: boolean;
  supportsSafeCompression: boolean;
  supportsDnsFiltering: boolean;
  /** True only for the development-only mock. */
  isDevelopmentOnly: boolean;
}

export interface VpnClientSpec {
  deviceId: string;
  displayName: string;
  nodeId: string;
  /** Public halves collected at registration, if the device presented them. */
  presentedPublicKey?: string | null;
  /** Bytes, null means "no quota enforced by this adapter". */
  quotaBytes?: bigint | null;
  expiresAt?: Date | null;
  /** Profile key forwarded so the gateway can apply what it is capable of. */
  profileKey?: string | null;
}

export interface VpnClientHandle {
  /** Identifier the gateway itself uses (peer key, email, UUID, ...). */
  gatewayIdentifier: string;
  /** Public half of what was created, safe to store and display. */
  publicCredential: string;
  fingerprint: string;
  createdAt: Date;
}

/** A client configuration the operator can hand to a device owner. */
export interface ClientConfig {
  format: "wireguard" | "xray-json" | "vless-uri" | "vmess-uri" | "trojan-uri";
  /** Full configuration text (or JSON/URI). Contains secrets: handle accordingly. */
  payload: string;
  /** Compact text embedded in the QR code (usually `payload` itself). */
  qrPayload: string;
  fingerprint: string;
  expiresAt: Date | null;
  /** Non-secret summary safe for tables and audit metadata. */
  summary: string;
}

export interface AdapterStatus {
  online: boolean;
  version?: string | null;
  activePeers: number;
  uptimeSeconds?: number | null;
  checkedAt: Date;
  error?: string | null;
}

export interface PeerTraffic {
  gatewayIdentifier: string;
  bytesUp: number;
  bytesDown: number;
  lastHandshakeAt?: Date | null;
  latencyMs?: number | null;
  jitterMs?: number | null;
  packetLossPct?: number | null;
  reconnectCount?: number | null;
}

export interface ApplyQuotaRequest {
  handle: VpnClientHandle | { gatewayIdentifier: string };
  /** Null removes the limit. */
  quotaBytes: bigint | null;
  /** Bytes already used, so the adapter can act on total usage, not just the cap. */
  usedBytes?: bigint | null;
}

export interface VpnAdapter {
  readonly key: string;
  readonly displayName: string;
  readonly protocol: "WIREGUARD" | "XRAY_VLESS" | "XRAY_VMESS" | "XRAY_TROJAN" | "MOCK";
  capabilities(): AdapterCapabilities;
  createClient(spec: VpnClientSpec): Promise<VpnClientHandle>;
  revokeClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void>;
  disconnectClient(handle: VpnClientHandle | { gatewayIdentifier: string }): Promise<void>;
  getStatus(): Promise<AdapterStatus>;
  getTraffic(): Promise<PeerTraffic[]>;
  applyQuota(request: ApplyQuotaRequest): Promise<void>;
}

/** Failures raised by adapters. Carries whether retrying could help. */
export class AdapterError extends Error {
  readonly retryable: boolean;
  override cause: unknown;

  constructor(message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message);
    this.name = "AdapterError";
    this.retryable = options?.retryable ?? false;
    this.cause = options?.cause;
  }
}
