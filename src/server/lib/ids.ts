import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

/**
 * Identifier and token generation.
 *
 * Everything an attacker could otherwise guess (device ids, receipt numbers, agent
 * tokens, session tokens) is generated from a CSPRNG. Nothing here is derived from
 * time or sequence numbers.
 */

/** URL-safe random string with `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Lowercase hex random string with `bytes` of entropy. */
export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Public device identifier. Not a credential: the device still has to present a
 * credential to the gateway. It only needs to be unguessable and stable, since the
 * brief forbids treating a source IP as identity.
 */
export function generateDeviceId(): string {
  return `dev_${randomHex(16)}`;
}

/** Node identifier, e.g. `node_71f0c3a9`. */
export function generateNodeId(prefix = "node"): string {
  return `${prefix}_${randomHex(6)}`;
}

/**
 * Human-facing access code. Base32-ish alphabet without confusable characters
 * (no I, O, 0, 1) so it can be read off a terminal and typed without mistakes.
 */
export function generateAccessCode(groups = 4, groupLength = 5): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(groups * groupLength);
  const parts: string[] = [];
  for (let group = 0; group < groups; group += 1) {
    let part = "";
    for (let index = 0; index < groupLength; index += 1) {
      const byte = bytes[group * groupLength + index] ?? 0;
      part += alphabet[byte % alphabet.length];
    }
    parts.push(part);
  }
  return parts.join("-");
}

/** Display hint for a secret that must not be echoed again, e.g. `VWRA-...-7F2Q`. */
export function hintFor(value: string, visible = 4): string {
  const clean = value.replace(/[^A-Za-z0-9-_]/g, "");
  if (clean.length <= visible * 2) return "****";
  return `${clean.slice(0, visible)}...${clean.slice(-visible)}`;
}

/** Receipt number: `VW-20260922-4F8C1A`, stable, sortable by date, not guessable. */
export function generateReceiptNumber(date = new Date()): string {
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("");
  return `VW-${stamp}-${randomHex(3).toUpperCase()}`;
}

/** Correlation id used by both structured logs and the audit trail. */
export function generateRequestId(): string {
  return randomUUID();
}

/** Constant-time comparison that tolerates length differences without leaking. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still perform a comparison so the timing profile does not reveal length.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

/** Deterministic key for aggregate upserts (never contains secret material). */
export function buildDedupeKey(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((part) => (part === null || part === undefined ? "_" : String(part)))
    .join("|");
}
