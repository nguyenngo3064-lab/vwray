import "server-only";
import type { NodeProtocol } from "@prisma/client";
import { getEnv } from "@/server/config/env";
import { WireGuardAdapter } from "@/server/vpn/adapters/wireguard";
import { XrayAdapter, type XrayProtocol } from "@/server/vpn/adapters/xray";
import { MockGatewayAdapter } from "@/server/vpn/adapters/mock";
import type { VpnAdapter } from "@/server/vpn/types";

/**
 * Adapter registry.
 *
 * Maps a node's stored protocol to a working VpnAdapter. The wiring rule is simple:
 *   * WIREGUARD                        -> WireGuardAdapter
 *   * XRAY_VLESS / XRAY_VMESS / XRAY_TROJAN -> XrayAdapter (matching protocol)
 *   * MOCK (only ever on a non-production, non-real node) -> MockGatewayAdapter
 *
 * Adding a new protocol means adding a class here and a Prisma enum value; the
 * collector, the policy pull and the config generator never change because they all
 * program against VpnAdapter.
 */

export function adapterKeyFor(node: {
  protocol: NodeProtocol;
  adapterKey: string;
  isRealGateway: boolean;
}): string {
  if (node.adapterKey === "mock" || !node.isRealGateway) return "mock";
  switch (node.protocol) {
    case "WIREGUARD":
      return "wireguard";
    case "XRAY_VMESS":
      return "xray-vmess";
    case "XRAY_TROJAN":
      return "xray-trojan";
    case "XRAY_VLESS":
    default:
      return "xray-vless";
  }
}

export function getAdapter(key: string, options?: { protocol?: XrayProtocol }): VpnAdapter {
  switch (key) {
    case "wireguard":
      return new WireGuardAdapter({
        mode: getEnv().isProduction ? "agent" : "local",
        interfaceName: getEnv().WG_INTERFACE,
        managementUrl: getEnv().VPN_API_URL,
      });
    case "xray-vless":
    case "xray-vmess":
    case "xray-trojan":
      return new XrayAdapter({
        protocol: options?.protocol ?? protocolForKey(key),
        apiUrl: getEnv().XRAY_API_URL,
      });
    case "mock":
      return new MockGatewayAdapter();
    default:
      throw new Error(`Unknown VPN adapter "${key}".`);
  }
}

function protocolForKey(key: string): XrayProtocol {
  if (key === "xray-vmess") return "XRAY_VMESS";
  if (key === "xray-trojan") return "XRAY_TROJAN";
  return "XRAY_VLESS";
}

export { WireGuardAdapter, XrayAdapter, MockGatewayAdapter };
