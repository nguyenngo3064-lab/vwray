import { describe, expect, it } from "vitest";
import { detectPort, detectPublicEndpoint, resolveNodeProtocol, createNodeName } from "../vwray-node/src/config";

describe("vwray-node configuration", () => {
  it("prefers explicit port settings and falls back safely", () => {
    expect(detectPort({ PORT: "9090", NODE_PORT: "8000" })).toBe(9090);
    expect(detectPort({ NODE_PORT: "8000" })).toBe(8000);
    expect(detectPort({})).toBe(3001);
  });

  it("detects public endpoint from the platform or env", () => {
    expect(detectPublicEndpoint({ PUBLIC_ENDPOINT: "https://node.example.com" })).toBe("https://node.example.com");
    expect(detectPublicEndpoint({ RAILWAY_PUBLIC_DOMAIN: "node.railway.app" })).toBe("https://node.railway.app");
    expect(detectPublicEndpoint({})).toBeNull();
  });

  it("keeps node protocol conservative unless the platform supports it", () => {
    expect(resolveNodeProtocol({ NODE_PROTOCOL: "WIREGUARD" }, true)).toBe("WIREGUARD");
    expect(resolveNodeProtocol({ NODE_PROTOCOL: "WIREGUARD" }, false)).toBe("MOCK");
    expect(resolveNodeProtocol({}, false)).toBe("MOCK");
  });

  it("derives stable names without generating a fresh random value each run", () => {
    expect(createNodeName({ NODE_NAME: "custom-node" })).toBe("custom-node");
    expect(createNodeName({})).toMatch(/^vwray-node-[a-z0-9-]+$/);
  });
});
