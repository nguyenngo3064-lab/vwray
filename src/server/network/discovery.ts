import "server-only";
import { getEnv } from "@/server/config/env";
import { prisma } from "@/server/db/client";
import { deriveHealth } from "@/server/nodes/service";
import { getSetting } from "@/server/settings/service";

/**
 * Network & deployment discovery.
 *
 * What this module claims, and what it deliberately does NOT claim:
 *
 *   1. Public hostname/URL of the Control Plane — resolved from configuration
 *      (`PUBLIC_HOSTNAME`, Railway's `RAILWAY_PUBLIC_DOMAIN`) or `APP_URL`.
 *   2. Public OUTBOUND IP of the container — discovered over HTTPS from several
 *      independent providers with timeouts, retries, response validation and
 *      caching. It says nothing about inbound reachability.
 *   3. Inbound reachability from the Internet — reported as UNVERIFIED. A container
 *      cannot prove that arbitrary inbound UDP reaches it, and an outbound IP is not
 *      an inbound address (platforms NAT aggressively).
 *   4. Public endpoint of each VPN NODE — taken from operator-configured node rows,
 *      never synthesised.
 *   5. Private/tunnel addresses — belong to the data-plane host; the control plane
 *      has no tunnel interface and reports none.
 *
 * On Railway specifically: the public HTTPS domain proves TCP 443 works. It does
 * NOT prove WireGuard UDP ingress, and Railway does not document general-purpose
 * UDP ingress for services. Until an external probe says otherwise the system
 * reports `UNVERIFIED` and points the operator at a VPS with a public IP for the
 * data plane.
 *
 * Caching is per process (Railway replicas each detect independently); the result
 * carries `checkedAt`, the previously seen address and whether it changed.
 */

const DEFAULT_DETECT_ENDPOINTS = [
  "https://api.ipify.org",
  "https://icanhazip.com",
  "https://checkip.amazonaws.com",
];

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

export type AddressFamily = "ipv4" | "ipv6";

export interface DetectedProviderResult {
  /** Host only — never a full URL with query parameters. */
  host: string;
  ok: boolean;
  address: string | null;
  family: AddressFamily | null;
  reason: string | null;
}

export interface OutboundIpReport {
  status: "OK" | "UNKNOWN";
  /** The agreed public outbound address, or null when detection failed. */
  address: string | null;
  family: AddressFamily | null;
  /** Host that supplied the accepted address. */
  provider: string | null;
  /** True when every successful provider returned the same address. */
  consistent: boolean | null;
  /** Distinct addresses seen, when providers disagreed. */
  candidates: string[];
  checkedAt: string | null;
  previousAddress: string | null;
  changed: boolean | null;
  changedAt: string | null;
  reason: string | null;
}

export interface ControlPlaneReport {
  url: string;
  hostname: string;
  hostnameSource: "PUBLIC_HOSTNAME" | "RAILWAY_PUBLIC_DOMAIN" | "APP_URL" | "UNRESOLVED";
  isLoopback: boolean;
  port: number | null;
  portSource: "PORT" | "NONE";
}

export interface VpnNodeEndpointReport {
  nodeId: string;
  name: string;
  publicEndpoint: string;
  port: number;
  protocol: string;
  approvalState: string;
  /** Fresh heartbeat inside the staleness window — agent process is alive. */
  agentOnline: boolean;
  /** Agent-reported WireGuard interface state. UNKNOWN means never reported. */
  wireguardState: string;
  /** Never true without an external probe; the control plane cannot self-probe UDP. */
  vpnReachable: "UNVERIFIED";
}

export interface NetworkSnapshot {
  platform: {
    provider: "RAILWAY" | "UNKNOWN";
    isProduction: boolean;
    notes: string[];
  };
  controlPlane: ControlPlaneReport;
  outboundIp: OutboundIpReport;
  inbound: {
    /** No inbound probe exists; saying "open" without one would be a lie. */
    status: "UNVERIFIED";
    tcp: { note: string };
    udp: { status: "UNVERIFIED"; note: string };
  };
  vpnNodes: VpnNodeEndpointReport[];
  tunnel: {
    controlPlaneInterface: null;
    note: string;
  };
  generatedAt: string;
}

// ---------------------------------------------------------------- helpers ---

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_RE = /^[0-9a-fA-F:]+$/;

/** Strict IPv4 (octet range checked) or plausible IPv6. Anything else is rejected. */
export function classifyAddress(raw: string): { address: string; family: AddressFamily } | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 45) return null;

  const v4 = IPV4_RE.exec(value);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
      // Loopback, RFC1918 and link-local answers mean the provider mirrored a
      // private address back; that is not a public outbound IP.
      const [a, b] = octets;
      if (
        a === 10 ||
        a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)
      ) {
        return null;
      }
      return { address: value, family: "ipv4" };
    }
    return null;
  }

  if (value.includes(":") && IPV6_RE.test(value) && !value.toLowerCase().startsWith("::ffff:")) {
    if (/^(fe80|fc|fd|::1)/i.test(value)) return null;
    return { address: value, family: "ipv6" };
  }
  return null;
}

/**
 * Validates an operator-configured detection endpoint. HTTPS only, no credentials,
 * no non-default port, no private or internal host — the classic SSRF pivot (point
 * the detector at 169.254.169.254 or an internal admin port) must be impossible
 * even when the variable is misconfigured.
 */
export function assertDetectUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`IP detection endpoint is not a valid URL: ${raw.slice(0, 60)}`);
  }
  if (url.protocol !== "https:") throw new Error("IP detection endpoints must use https://");
  if (url.username || url.password) throw new Error("IP detection endpoints must not embed credentials.");
  if (url.port && url.port !== "443") {
    throw new Error("IP detection endpoints may only use the default HTTPS port.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("IP detection endpoints must be public hosts.");
  }
  if (IPV4_RE.test(host) && !classifyAddress(host)) {
    throw new Error("IP detection endpoints must not point at private addresses.");
  }
  return url.toString();
}

function detectionEndpoints(): string[] {
  const env = getEnv();
  const custom = env.IP_DETECT_URLS;
  if (custom && custom.length > 0) {
    const parsed = custom
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map(assertDetectUrl);
    if (parsed.length > 0) return parsed;
  }
  return DEFAULT_DETECT_ENDPOINTS;
}

// ------------------------------------------------------------- detection ---

export interface DetectOptions {
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  endpoints?: string[];
  timeoutMs?: number;
  /** Attempts per endpoint (first try + retries). */
  attempts?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** One provider probe: bounded time, bounded body, validated payload. */
export async function queryProvider(url: string, options: DetectOptions = {}): Promise<DetectedProviderResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 4000;
  const host = new URL(url).host;

  let lastReason = "unknown error";
  const attempts = Math.max(1, options.attempts ?? 2);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      await (options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(
        250 * attempt,
      );
    }
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "text/plain" },
        redirect: "error",
      });
      if (!response.ok) {
        lastReason = `HTTP ${response.status}`;
        continue;
      }
      const declared = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        lastReason = "response too large";
        continue;
      }
      const text = (await response.text()).slice(0, MAX_BODY_BYTES).trim();
      const classified = classifyAddress(text);
      if (!classified) {
        lastReason = text.length === 0 ? "empty response" : "response was not a public IP address";
        continue;
      }
      return { host, ok: true, address: classified.address, family: classified.family, reason: null };
    } catch (error) {
      const name = error instanceof Error ? error.name : "Error";
      lastReason = name === "TimeoutError" || name === "AbortError" ? "timed out" : "request failed";
    }
  }
  return { host, ok: false, address: null, family: null, reason: lastReason };
}

/** Module-level memory of the last confirmed address, used for change detection. */
let lastKnown: { address: string; checkedAt: string; changedAt: string | null } | null = null;

/**
 * Detects the container's public outbound IP.
 *
 * Multiple independent providers are queried; a result is only published when the
 * successful providers AGREE. Disagreement or total failure produces
 * `status: "UNKNOWN"` with a reason — a stale or guessed address is never kept as
 * if it were current.
 */
export async function detectOutboundIp(options: DetectOptions = {}): Promise<OutboundIpReport> {
  const endpoints = options.endpoints ?? detectionEndpoints();
  const results = await Promise.all(endpoints.map((endpoint) => queryProvider(endpoint, options)));
  const now = new Date().toISOString();

  const successes = results.filter((entry) => entry.ok && entry.address);
  const addresses = [...new Set(successes.map((entry) => entry.address as string))];

  const failureSummary = results
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.host}: ${entry.reason ?? "failed"}`)
    .join("; ");

  const previousAddress = lastKnown?.address ?? null;

  if (successes.length === 0) {
    return {
      status: "UNKNOWN",
      address: null,
      family: null,
      provider: null,
      consistent: null,
      candidates: [],
      checkedAt: now,
      previousAddress,
      changed: null,
      changedAt: lastKnown?.changedAt ?? null,
      reason: `No provider returned a usable address (${failureSummary || "no endpoints configured"}).`,
    };
  }

  if (addresses.length > 1) {
    // Never pick a winner among disagreeing providers: publish neither as "the" IP.
    return {
      status: "UNKNOWN",
      address: null,
      family: null,
      provider: null,
      consistent: false,
      candidates: addresses,
      checkedAt: now,
      previousAddress,
      changed: null,
      changedAt: lastKnown?.changedAt ?? null,
      reason: `Providers disagreed (${successes.map((entry) => `${entry.host}=${entry.address}`).join(", ")}).`,
    };
  }

  const address = addresses[0] as string;
  const family = successes[0]?.family ?? null;
  const changed = previousAddress === null ? null : previousAddress !== address;
  const changedAt = changed ? now : (lastKnown?.changedAt ?? null);
  lastKnown = { address, checkedAt: now, changedAt };

  const failedCount = results.length - successes.length;
  return {
    status: "OK",
    address,
    family,
    provider: successes[0]?.host ?? null,
    consistent: successes.length >= 2 ? true : null,
    candidates: [],
    checkedAt: now,
    previousAddress,
    changed,
    changedAt,
    reason:
      failedCount === 0
        ? null
        : `${failedCount} of ${results.length} provider(s) failed; result accepted from ${successes.length}.`,
  };
}

// -------------------------------------------------------------- assembly ---

/**
 * Public identity of the control plane itself.
 *
 * Precedence: explicit `PUBLIC_HOSTNAME` (operator override) >
 * `RAILWAY_PUBLIC_DOMAIN` (platform-provided) > `APP_URL`'s host. The listening
 * port comes from the platform-assigned `PORT` environment variable — it is
 * REPORTED here, never hardcoded, and never appended to a public https URL,
 * because Railway's proxy terminates TLS on 443 while the container listens on
 * whatever `PORT` says.
 */
export function resolveControlPlane(): ControlPlaneReport {
  const env = getEnv();

  const strip = (value: string) => value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // Read straight from process.env (not the memoised env) so a late-injected
  // platform variable is still honoured and tests can vary it per case.
  const explicitRaw = (process.env.PUBLIC_HOSTNAME ?? "").trim();
  const explicit = explicitRaw ? strip(explicitRaw) : undefined;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN
    ? strip(process.env.RAILWAY_PUBLIC_DOMAIN)
    : undefined;

  let hostname: string;
  let source: ControlPlaneReport["hostnameSource"];
  let scheme: "http" | "https";
  let url = "";

  if (explicit) {
    hostname = explicit;
    source = "PUBLIC_HOSTNAME";
    scheme = explicit.startsWith("localhost") || explicit.startsWith("127.") ? "http" : "https";
    url = `${scheme}://${explicit}`;
  } else if (railwayDomain) {
    hostname = railwayDomain;
    source = "RAILWAY_PUBLIC_DOMAIN";
    scheme = "https";
    url = `https://${railwayDomain}`;
  } else {
    try {
      const appUrl = new URL(env.APP_URL);
      hostname = appUrl.hostname;
      source = "APP_URL";
      scheme = appUrl.protocol === "https:" ? "https" : "http";
      url = appUrl.toString().replace(/\/$/, "");
    } catch {
      return {
        url: "",
        hostname: "",
        hostnameSource: "UNRESOLVED",
        isLoopback: false,
        port: null,
        portSource: "NONE",
      };
    }
  }

  const portRaw = process.env.PORT?.trim();
  const port = portRaw && /^\d{1,5}$/.test(portRaw) ? Number(portRaw) : null;
  const isLoopback = hostname === "localhost" || hostname.startsWith("127.") || hostname === "0.0.0.0";

  return {
    url,
    hostname,
    hostnameSource: source,
    isLoopback,
    port,
    portSource: port ? "PORT" : "NONE",
  };
}

/** Platform identification from real Railway variables, never assumed. */
function platformNotes(): { provider: "RAILWAY" | "UNKNOWN"; notes: string[] } {
  const isRailway = Boolean(
    process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PUBLIC_DOMAIN,
  );
  if (isRailway) {
    return {
      provider: "RAILWAY",
      notes: [
        "Railway terminates HTTPS on the public domain: TCP ingress on that domain is expected to work.",
        "WireGuard needs INBOUND UDP. Railway does not document general-purpose UDP ingress for services, so inbound UDP is reported as UNVERIFIED until an external probe proves otherwise. Run the VPN Node Agent on a VPS with a public IP and point clients at that node's endpoint.",
        "Railway does not guarantee a static outbound IP; the detected outbound address is a point-in-time observation, not a permanent identity.",
        "The container listens on the platform-assigned PORT (reported below), not a hardcoded port.",
      ],
    };
  }
  return {
    provider: "UNKNOWN",
    notes: [
      "Provider could not be identified from the environment; no platform-specific ingress assumptions are made.",
      "Inbound UDP reachability is UNVERIFIED until probed from outside this host.",
    ],
  };
}

let cache: { at: number; snapshot: NetworkSnapshot } | null = null;

/** Clears module state. Test-only helper. */
export function resetDiscoveryState(): void {
  cache = null;
  lastKnown = null;
}

/** Builds a full snapshot: control-plane identity, outbound IP, nodes, caveats. */
export async function buildSnapshot(options: DetectOptions = {}): Promise<NetworkSnapshot> {
  const [outboundIp, nodes, staleSeconds] = await Promise.all([
    detectOutboundIp(options),
    prisma.vpnNode.findMany({ orderBy: { name: "asc" } }),
    getSetting<number>("nodes.heartbeatStaleSeconds").catch(() => 90),
  ]);

  const platform = platformNotes();

  return {
    platform: { ...platform, isProduction: getEnv().isProduction },
    controlPlane: resolveControlPlane(),
    outboundIp,
    inbound: {
      status: "UNVERIFIED",
      tcp: {
        note: "TCP ingress to the public hostname is implied by the platform proxy (health checks), but no active inbound TCP probe is run from here.",
      },
      udp: {
        status: "UNVERIFIED",
        note: "No inbound UDP probe exists. An outbound IP or an HTTPS domain does NOT prove WireGuard UDP can reach this host.",
      },
    },
    vpnNodes: nodes.map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      publicEndpoint: node.publicEndpoint,
      port: node.port,
      protocol: node.protocol,
      approvalState: node.approvalState,
      agentOnline:
        deriveHealth({
          lastHeartbeatAt: node.lastHeartbeatAt,
          staleSeconds,
          maintenance: node.maintenance,
          draining: node.draining,
        }) === "ONLINE",
      wireguardState: node.wireguardState,
      vpnReachable: "UNVERIFIED" as const,
    })),
    tunnel: {
      controlPlaneInterface: null,
      note: "The control plane runs no WireGuard interface. Tunnel addresses (for example the 10.200.0.0/24 client pool) belong to each VPN node's data plane and are configured there.",
    },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Cached snapshot access. Within the TTL the previous snapshot is served so the
 * diagnostics page can poll freely; `force` re-detects immediately (used by the
 * refresh button, which is admin-only and rate limited at the route).
 */
export async function getNetworkSnapshot(
  options: DetectOptions & { force?: boolean } = {},
): Promise<NetworkSnapshot> {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_TTL_MS) return cache.snapshot;

  const snapshot = await buildSnapshot(options);
  cache = { at: Date.now(), snapshot };
  return snapshot;
}




