import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { prisma } from "@/server/db/client";
import {
  assertDetectUrl,
  buildSnapshot,
  classifyAddress,
  detectOutboundIp,
  queryProvider,
  resetDiscoveryState,
  resolveControlPlane,
} from "@/server/network/discovery";
import { resetDatabase } from "./helpers/db";

/**
 * Network discovery behaviour.
 *
 * All HTTP is injected: no suite here touches a real echo provider. Success,
 * timeout, garbage payloads and provider disagreement are each simulated so the
 * contract — "publish an agreed address, otherwise UNKNOWN with a reason" — is
 * proven, not assumed.
 */

function fakeFetch(responses: Record<string, { ok: boolean; status?: number; body?: string; hang?: boolean }>) {
  return (async (url: string) => {
    const entry = responses[url];
    if (!entry) throw new Error("network unreachable");
    if (entry.hang) {
      await new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), 50);
        timer.unref?.();
      });
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    return {
      ok: entry.ok,
      status: entry.status ?? 200,
      headers: new Headers(),
      text: async () => entry.body ?? "",
    } as unknown as Response;
  }) as typeof fetch;
}

beforeEach(async () => {
  resetDiscoveryState();
  await resetDatabase();
});

describe("classifyAddress", () => {
  it("accepts strict public IPv4", () => {
    expect(classifyAddress("203.0.113.42")).toEqual({ address: "203.0.113.42", family: "ipv4" });
  });

  it("rejects out-of-range octets, private ranges and junk", () => {
    expect(classifyAddress("999.1.1.1")).toBeNull();
    expect(classifyAddress("10.0.0.5")).toBeNull();
    expect(classifyAddress("192.168.1.1")).toBeNull();
    expect(classifyAddress("127.0.0.1")).toBeNull();
    expect(classifyAddress("not-an-ip")).toBeNull();
    expect(classifyAddress("")).toBeNull();
    expect(classifyAddress("<html>nope</html>")).toBeNull();
  });

  it("accepts plausible public IPv6 and rejects special ranges", () => {
    expect(classifyAddress("2001:db8::1")).toEqual({ address: "2001:db8::1", family: "ipv6" });
    expect(classifyAddress("::1")).toBeNull();
    expect(classifyAddress("fe80::1")).toBeNull();
  });
});

describe("assertDetectUrl", () => {
  it("accepts well-formed https echo endpoints", () => {
    expect(assertDetectUrl("https://api.ipify.org")).toBe("https://api.ipify.org/");
  });

  it("rejects http, credentials, custom ports and internal hosts", () => {
    expect(() => assertDetectUrl("http://api.ipify.org")).toThrow();
    expect(() => assertDetectUrl("https://user:pass@api.ipify.org")).toThrow();
    expect(() => assertDetectUrl("https://api.ipify.org:8443")).toThrow();
    expect(() => assertDetectUrl("https://169.254.169.254/latest")).toThrow();
    expect(() => assertDetectUrl("https://10.0.0.9/")).toThrow();
    expect(() => assertDetectUrl("https://metadata.internal/")).toThrow();
  });
});

describe("queryProvider", () => {
  it("returns the address from a clean provider", async () => {
    const result = await queryProvider("https://a.example", {
      fetchImpl: fakeFetch({ "https://a.example": { ok: true, body: "203.0.113.7\n" } }),
    });
    expect(result).toMatchObject({ host: "a.example", ok: true, address: "203.0.113.7", family: "ipv4" });
  });

  it("retries then reports timeouts with a reason", async () => {
    const result = await queryProvider("https://slow.example", {
      fetchImpl: fakeFetch({ "https://slow.example": { ok: true, hang: true } }),
      timeoutMs: 10,
      attempts: 2,
      sleep: () => Promise.resolve(),
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("timed out");
  });

  it("rejects garbage payloads and records HTTP failures", async () => {
    const junk = await queryProvider("https://junk.example", {
      fetchImpl: fakeFetch({ "https://junk.example": { ok: true, body: "Hello, world!" } }),
      attempts: 1,
    });
    expect(junk.ok).toBe(false);
    expect(junk.reason).toContain("not a public IP");

    const down = await queryProvider("https://down.example", {
      fetchImpl: fakeFetch({ "https://down.example": { ok: false, status: 503 } }),
      attempts: 1,
    });
    expect(down.ok).toBe(false);
    expect(down.reason).toBe("HTTP 503");
  });
});

describe("detectOutboundIp", () => {
  const endpoints = ["https://a.example", "https://b.example", "https://c.example"];

  it("publishes the agreed address when providers agree", async () => {
    const fetchImpl = fakeFetch({
      "https://a.example": { ok: true, body: "203.0.113.9" },
      "https://b.example": { ok: true, body: "203.0.113.9" },
      "https://c.example": { ok: false, status: 500 },
    });
    const report = await detectOutboundIp({ endpoints, fetchImpl, attempts: 1 });
    expect(report.status).toBe("OK");
    expect(report.address).toBe("203.0.113.9");
    expect(report.consistent).toBe(true);
    expect(report.reason).toContain("1 of 3");
  });

  it("returns UNKNOWN when every provider fails", async () => {
    const fetchImpl = fakeFetch({
      "https://a.example": { ok: false, status: 500 },
      "https://b.example": { ok: true, hang: true },
    });
    const report = await detectOutboundIp({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl,
      attempts: 1,
      timeoutMs: 10,
    });
    expect(report.status).toBe("UNKNOWN");
    expect(report.address).toBeNull();
    expect(report.reason).toContain("No provider returned a usable address");
  });

  it("returns UNKNOWN with candidates when providers disagree", async () => {
    const fetchImpl = fakeFetch({
      "https://a.example": { ok: true, body: "203.0.113.9" },
      "https://b.example": { ok: true, body: "198.51.100.44" },
    });
    const report = await detectOutboundIp({
      endpoints: ["https://a.example", "https://b.example"],
      fetchImpl,
      attempts: 1,
    });
    expect(report.status).toBe("UNKNOWN");
    expect(report.address).toBeNull();
    expect(report.candidates.sort()).toEqual(["198.51.100.44", "203.0.113.9"]);
    expect(report.reason).toContain("disagreed");
  });

  it("detects address changes between detections", async () => {
    const first = fakeFetch({ "https://a.example": { ok: true, body: "203.0.113.9" } });
    const second = fakeFetch({ "https://a.example": { ok: true, body: "198.51.100.44" } });
    const once = await detectOutboundIp({ endpoints: ["https://a.example"], fetchImpl: first, attempts: 1 });
    expect(once.changed).toBeNull();
    const twice = await detectOutboundIp({ endpoints: ["https://a.example"], fetchImpl: second, attempts: 1 });
    expect(twice.changed).toBe(true);
    expect(twice.previousAddress).toBe("203.0.113.9");
    expect(twice.changedAt).not.toBeNull();
  });
});

describe("resolveControlPlane", () => {
  it("reads the platform-assigned PORT without hardcoding", () => {
    process.env.PORT = "18080";
    const report = resolveControlPlane();
    expect(report.port).toBe(18080);
    expect(report.portSource).toBe("PORT");
    delete process.env.PORT;
    expect(resolveControlPlane().portSource).toBe("NONE");
  });

  it("prefers PUBLIC_HOSTNAME over the platform domain", () => {
    process.env.PUBLIC_HOSTNAME = "vpn.example.com";
    process.env.RAILWAY_PUBLIC_DOMAIN = "x.up.railway.app";
    const report = resolveControlPlane();
    expect(report.hostname).toBe("vpn.example.com");
    expect(report.hostnameSource).toBe("PUBLIC_HOSTNAME");
    delete process.env.PUBLIC_HOSTNAME;
    expect(resolveControlPlane().hostnameSource).toBe("RAILWAY_PUBLIC_DOMAIN");
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
  });
});

describe("buildSnapshot", () => {
  it("separates the five address classes and never claims inbound UDP", async () => {
    await prisma.vpnNode.create({
      data: {
        nodeId: "node_snap01",
        name: "Snapshot node",
        location: "local",
        publicEndpoint: "203.0.113.10",
        port: 51820,
        protocol: "WIREGUARD",
        approvalState: "APPROVED",
        agentTokenHash: "x",
        agentTokenHint: "x",
        adapterKey: "wireguard",
        isRealGateway: true,
        lastHeartbeatAt: new Date(),
        tags: [],
      },
    });
    const snapshot = await buildSnapshot({
      endpoints: ["https://a.example"],
      fetchImpl: fakeFetch({ "https://a.example": { ok: true, body: "203.0.113.9" } }),
      attempts: 1,
    });
    expect(snapshot.controlPlane.hostname.length).toBeGreaterThan(0);
    expect(snapshot.outboundIp.status).toBe("OK");
    expect(snapshot.outboundIp.address).toBe("203.0.113.9");
    expect(snapshot.inbound.status).toBe("UNVERIFIED");
    expect(snapshot.inbound.udp.status).toBe("UNVERIFIED");
    expect(snapshot.vpnNodes).toHaveLength(1);
    expect(snapshot.vpnNodes[0]?.publicEndpoint).toBe("203.0.113.10");
    expect(snapshot.vpnNodes[0]?.vpnReachable).toBe("UNVERIFIED");
    expect(snapshot.tunnel.controlPlaneInterface).toBeNull();
  });
});

