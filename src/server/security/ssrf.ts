import "server-only";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { errors } from "@/server/lib/errors";

/**
 * SSRF guard for operator-supplied outbound URLs.
 *
 * Webhook endpoints and any future "call this URL" feature are the classic way an
 * authenticated-but-hostile user pivots into the internal network (cloud metadata
 * endpoints, `localhost` admin panels, the PostgreSQL host). The rule enforced here
 * is deny-by-default:
 *
 *   1. Only `https` is accepted (an alert payload can contain hostnames and device
 *      names, so plaintext delivery is refused even on a trusted network).
 *   2. A literal IP in a private, loopback, link-local, multicast or reserved range
 *      is refused.
 *   3. A hostname is resolved and EVERY returned address is checked with the same
 *      rule, which closes the DNS-rebinding gap where a name resolves to a public
 *      address during validation and a private one during delivery.
 *
 * Validation runs twice by design: once when the operator saves the endpoint (so a
 * mistake is a form error) and once immediately before each delivery (so a hostname
 * that later starts pointing at 127.0.0.1 is caught).
 */

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/** RFC1918 / RFC4193 / loopback / link-local / CGNAT / multicast / reserved. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const octets = address.split(".").map((part) => Number(part));
    const [a = -1, b = -1] = octets;
    if (a === 10) return true; // 10/8
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
    if (a === 192 && b === 168) return true; // 192.168/16
    if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
    if (a >= 224) return true; // multicast + reserved + broadcast
    if (a === 0) return true; // "this network"
    return false;
  }

  if (version === 6) {
    const normalised = address.toLowerCase();
    if (normalised === "::" || normalised === "::1") return true;
    // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible forms.
    const mapped = normalised.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped?.[1]) return isPrivateAddress(mapped[1]);
    if (normalised.startsWith("fe80")) return true; // link-local
    if (normalised.startsWith("fc") || normalised.startsWith("fd")) return true; // unique local
    if (normalised.startsWith("ff")) return true; // multicast
    return false;
  }

  return true;
}

export interface SafeUrl {
  url: URL;
  /** Addresses the hostname resolved to, kept for the audit metadata. */
  resolved: string[];
}

/**
 * Validates an operator-supplied outbound URL. Throws a validation error the form can
 * display; never returns a partially-trusted URL.
 */
export async function assertSafeOutboundUrl(raw: string, options?: { allowHttp?: boolean }): Promise<SafeUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw errors.validation("The URL is not a valid absolute URL.");
  }

  const allowedProtocols = options?.allowHttp ? ["https:", "http:"] : ["https:"];
  if (!allowedProtocols.includes(url.protocol)) {
    throw errors.validation(
      options?.allowHttp
        ? "The URL must use http or https."
        : "The URL must use https. Plaintext http is refused because payloads can contain device and operator names.",
    );
  }

  if (url.username || url.password) {
    throw errors.validation("Credentials must not be embedded in the URL. Use a signing secret instead.");
  }

  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) {
    throw errors.validation("The URL uses a port that is not allowed for outbound delivery.");
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw errors.validation("The URL points at a local or metadata hostname, which is refused.");
  }

  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw errors.validation("The URL points at a private or reserved address, which is refused.");
    }
    return { url, resolved: [hostname] };
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw errors.validation("The URL hostname could not be resolved.");
  }

  if (addresses.length === 0) {
    throw errors.validation("The URL hostname resolved to no addresses.");
  }

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      throw errors.validation(
        "The URL hostname resolves to a private or reserved address, which is refused.",
      );
    }
  }

  return { url, resolved: addresses.map((entry) => entry.address) };
}
