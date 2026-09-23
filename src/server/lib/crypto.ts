import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { getEnv } from "@/server/config/env";

/**
 * Cryptographic primitives used across the control plane.
 *
 * Design rules enforced here:
 *   * Passwords and access codes are hashed with scrypt (memory-hard) and compared
 *     in constant time.
 *   * Session tokens and API keys are stored as SHA-256 digests. They are already
 *     high-entropy, so a slow KDF would only add latency.
 *   * VPN credential material is sealed with AES-256-GCM: confidentiality plus
 *     integrity, with a fresh IV per operation.
 *   * Nothing in this file logs or returns a secret it was given.
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** `scrypt$N$r$p$salt$hash`, all base64url. */
export function hashSecret(plaintext: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plaintext.normalize("NFKC"), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

/** Constant-time verification of a value against a stored scrypt hash. */
export function verifySecret(plaintext: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length === 0 || expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = scryptSync(plaintext.normalize("NFKC"), salt, expected.length, {
      N: n,
      r,
      p,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    return false;
  }

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** SHA-256 hex digest. Used for session tokens, fingerprints and integrity hashes. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Short fingerprint for operator display, e.g. `a91f:c3d2`. */
export function fingerprintOf(value: string): string {
  const digest = sha256Hex(value);
  const bytes = Buffer.from(digest, "hex");
  return `${bytes.subarray(0, 2).toString("hex")}:${bytes.subarray(2, 4).toString("hex")}`;
}

function encryptionKey(): Buffer {
  const raw = getEnv().ENCRYPTION_KEY;
  // Accept a base64/hex 32-byte key. Anything else is folded to 32 bytes with
  // SHA-256 so a short-but-present key cannot silently weaken AES.
  const candidates = [Buffer.from(raw, "base64"), Buffer.from(raw, "hex")];
  for (const candidate of candidates) {
    if (candidate.length === 32) return candidate;
  }
  return createHash("sha256").update(raw, "utf8").digest();
}

/**
 * Seals a secret with AES-256-GCM.
 * Format: `v1:<iv base64url>:<auth tag base64url>:<ciphertext base64url>`.
 */
export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ":",
  );
}

/** Opens a value produced by `sealSecret`. Throws on tampering, never returns partial data. */
export function unsealSecret(sealed: string): string {
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported sealed payload version.");
  }
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** HMAC-SHA256 used for webhook signatures and CSRF token derivation. */
export function hmacHex(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** Derived CSRF token: bound to the session token, so it cannot be replayed cross-session. */
export function deriveCsrfToken(sessionToken: string, csrfSecret: string): string {
  return hmacHex(getEnv().AUTH_SECRET, `${sessionToken}.${csrfSecret}`);
}

/** Canonical, deterministic JSON: sorted keys, stable numbers. For hashing payloads. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalise = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      if (typeof input === "number" && !Number.isFinite(input)) return String(input);
      return input;
    }
    if (Array.isArray(input)) return input.map(normalise);
    if (seen.has(input as object)) throw new Error("Cannot canonicalise a circular structure.");
    seen.add(input as object);
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of entries) result[key] = normalise(entryValue);
    return result;
  };
  return JSON.stringify(normalise(value));
}
