import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export type SupportedNodeProtocol =
  | "WIREGUARD"
  | "XRAY_VLESS"
  | "XRAY_VMESS"
  | "XRAY_TROJAN"
  | "MOCK";

export function readEnv(env: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  return env;
}

export function detectPort(env: Record<string, string | undefined> = process.env): number {
  const candidates = [env.PORT, env.NODE_PORT];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) {
      return value;
    }
  }
  return 3001;
}

export function detectPublicEndpoint(
  env: Record<string, string | undefined> = process.env,
  fallbackPort = detectPort(env),
): string | null {
  const explicit = env.PUBLIC_ENDPOINT?.trim();
  if (explicit) return normalizePublicEndpoint(explicit);

  const railwayDomain = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain.replace(/^https?:\/\//, "")}`;

  const localHost = env.NODE_ENV === "development" ? `http://localhost:${fallbackPort}` : null;
  if (localHost) return localHost;

  return null;
}

export function normalizePublicEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

export function resolveNodeProtocol(
  env: Record<string, string | undefined> = process.env,
  supportsWireGuard = false,
): SupportedNodeProtocol {
  const raw = (env.NODE_PROTOCOL ?? "").trim().toUpperCase();
  const allowed: SupportedNodeProtocol[] = ["WIREGUARD", "XRAY_VLESS", "XRAY_VMESS", "XRAY_TROJAN", "MOCK"];
  if (raw && allowed.includes(raw as SupportedNodeProtocol)) {
    if (raw === "WIREGUARD" && !supportsWireGuard) return "MOCK";
    return raw as SupportedNodeProtocol;
  }

  return supportsWireGuard ? "WIREGUARD" : "MOCK";
}

export function detectCapabilities(supportsWireGuard: boolean): string[] {
  const capabilities = ["heartbeat", "control-plane"];
  if (supportsWireGuard) capabilities.push("wireguard");
  return capabilities;
}

export function createNodeName(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.NODE_NAME?.trim();
  if (explicit) return explicit;
  return `vwray-node-${randomUUID().slice(0, 8)}`;
}

export interface WireGuardReport {
  state: "READY" | "DOWN" | "UNKNOWN";
  reason: string;
}

export interface HostProbe {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: "utf8"): string;
}

/**
 * Observes the local WireGuard interface WITHOUT root and WITHOUT running `wg`.
 *
 * Evidence ladder (nothing is ever claimed beyond what can be seen):
 *   * interface absent from /sys/class/net  -> DOWN (it does not exist here);
 *   * interface present, carrier = 1        -> READY (link is up);
 *   * interface present, carrier unreadable -> UNKNOWN (need privileges; do not guess).
 *
 * The control plane timestamps this report and only surfaces WIREGUARD_READY while
 * it is fresh; a running agent process alone never proves the tunnel works.
 */
export function detectWireGuardState(
  iface = "wg0",
  probe: HostProbe = { existsSync, readFileSync },
): WireGuardReport {
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(iface)) {
    return { state: "UNKNOWN", reason: "interface name is not a valid Linux interface name" };
  }
  const sysPath = `/sys/class/net/${iface}`;
  if (!probe.existsSync(sysPath)) {
    return { state: "DOWN", reason: `interface ${iface} does not exist on this host` };
  }
  try {
    const carrier = probe.readFileSync(`${sysPath}/carrier`, "utf8").trim();
    if (carrier === "1") return { state: "READY", reason: `interface ${iface} is up (carrier detected)` };
    return { state: "DOWN", reason: `interface ${iface} exists but reports no carrier` };
  } catch {
    return {
      state: "UNKNOWN",
      reason: `interface ${iface} exists; carrier state unreadable without elevated privileges`,
    };
  }
}
