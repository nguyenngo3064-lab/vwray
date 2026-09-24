import { randomUUID } from "node:crypto";

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
