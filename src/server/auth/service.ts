import "server-only";
import type { AdminRole, AdminUser } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { errors } from "@/server/lib/errors";
import {
  deriveCsrfToken,
  fingerprintOf,
  hashSecret,
  sha256Hex,
  verifySecret,
} from "@/server/lib/crypto";
import { generateAccessCode, hintFor, randomToken, safeEqual } from "@/server/lib/ids";
import { recordAuthAttempt, checkAuthRateLimit } from "@/server/auth/rate-limit";
import { record, userActor } from "@/server/audit";
import {
  clearSessionCookies,
  readCsrfCookie,
  readSessionToken,
  writeSessionCookies,
} from "@/server/auth/cookies";

/**
 * Authentication service.
 *
 * Threat model summary:
 *   * Credentials are never stored in plaintext. Access codes and passwords are
 *     scrypt hashes; session tokens are SHA-256 digests.
 *   * The first-boot access code is returned only by the explicitly enabled
 *     development retrieval route and is never written to logs.
 *   * Sessions live server-side and are revoked, not merely expired client-side.
 *   * Failed attempts are recorded and rate limited per credential and per IP.
 */

export interface SessionContext {
  sessionId: string;
  user: Pick<AdminUser, "id" | "username" | "displayName" | "email" | "role" | "status">;
  /** Raw cookie token, needed to derive the CSRF token for this session. */
  token: string;
  csrfToken: string;
  expiresAt: Date;
  lastSeenAt: Date;
}

const ROLE_RANK: Record<AdminRole, number> = { VIEWER: 0, ANALYST: 1, ADMIN: 2, OWNER: 3 };

/** True when `role` is at least as privileged as `required`. */
export function roleAtLeast(role: AdminRole, required: AdminRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

/**
 * First-boot bootstrap.
 *
 * Creates the owner account and one high-entropy access code when the installation
 * has no users at all. The plaintext code is returned only to the gated retrieval
 * route; production bootstrap authenticates with OWNER_PASSWORD.
 *
 * Hardening:
 *   * No weak default. Without `DEFAULT_ACCESS_CODE` a 20-character CSPRNG code is
 *     generated instead of falling back to anything guessable.
 *   * Optional `OWNER_PASSWORD` is hashed (scrypt) into the owner account so the
 *     dashboard can be entered with a password on the first login.
 *   * The plaintext code is returned only to the explicitly enabled development
 *     retrieval route; production bootstrap uses OWNER_PASSWORD and never logs it.
 */
export async function ensureBootstrapOwner(): Promise<
  { created: true; accessCode: string; username: string; passwordSet: boolean } | { created: false }
> {
  const existing = await prisma.adminUser.count();
  if (existing > 0) return { created: false };

  const username = "owner";
  const env = getEnv();
  const accessCode = (env.DEFAULT_ACCESS_CODE ?? generateAccessCode()).toUpperCase();
  const ownerPassword = env.OWNER_PASSWORD;
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.adminUser.create({
      data: {
        username,
        displayName: "Installation owner",
        role: "OWNER",
        status: "ACTIVE",
        ...(ownerPassword ? { passwordHash: hashSecret(ownerPassword) } : {}),
      },
    });
    await tx.accessCode.create({
      data: {
        label: "First-boot access code",
        codeHint: hintFor(accessCode),
        codeHash: hashSecret(accessCode),
        role: "OWNER",
        createdById: created.id,
        expiresAt,
      },
    });
    return created;
  });

  await record({
    actor: { type: "SYSTEM", id: null, label: "bootstrap" },
    action: "auth.bootstrap",
    resource: "admin_user",
    resourceId: user.id,
    result: "SUCCESS",
    metadata: {
      username,
      accessCodeHint: hintFor(accessCode),
      expiresAt: expiresAt.toISOString(),
      passwordSet: Boolean(ownerPassword),
    },
  });

  return { created: true, accessCode, username, passwordSet: Boolean(ownerPassword) };
}

export interface LoginInput {
  accessCode: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface PasswordLoginInput {
  username: string;
  password: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * A structurally valid but unusable scrypt hash, built once and cached. When no
 * account matches a login attempt we still run a full scrypt verification against
 * it, so the response time of "unknown user" matches "wrong password" and the
 * endpoint cannot be used to enumerate accounts by timing.
 */
let decoyHash: string | null = null;
function decoy(): string {
  decoyHash ??= hashSecret(randomToken(24));
  return decoyHash;
}

/** Generic message used for every password failure mode. Never says which part failed. */
const PASSWORD_FAILURE = "Username or password is invalid.";

/**
 * Password login.
 *
 * Threat model summary:
 *   * Every failure mode (unknown user, no password set, wrong password) returns
 *     the SAME message and performs a scrypt verification, so the response reveals
 *     nothing about which usernames exist.
 *   * Rate limiting is enforced from the durable `AuthAttempt` ledger before any
 *     hash work happens, keyed on the fingerprinted username.
 *   * The password is compared in constant time against a server-side scrypt hash;
 *     it is never logged, echoed or stored in plaintext.
 *   * The account's own `failedLogins` counter is kept for operator visibility and
 *     reset on success; the windowed lockout itself is the ledger's job, so a
 *     restart cannot clear it.
 */
export async function loginWithPassword(input: PasswordLoginInput): Promise<SessionContext> {
  const username = input.username.trim();
  const identifier = fingerprintOf(`password:${username.toLowerCase()}`);

  const limit = await checkAuthRateLimit("auth.login", identifier);
  if (!limit.allowed) {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: "rate_limited",
    });
    await record({
      actor: { type: "SYSTEM", id: null, label: "unauthenticated" },
      action: "auth.rate_limited",
      resource: "admin_user",
      result: "DENIED",
      sourceIp: input.ip,
      metadata: { scope: "auth.login" },
    });
    throw errors.rateLimited("Too many failed attempts. Try again later.", limit.retryAfterSeconds);
  }

  const user = await prisma.adminUser.findFirst({
    where: { username: { equals: username, mode: "insensitive" } },
  });

  const passwordMatches = verifySecret(input.password, user?.passwordHash ?? decoy());
  const credentialsValid = Boolean(user) && Boolean(user?.passwordHash) && passwordMatches;

  if (!user || !credentialsValid) {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: user ? "bad_password" : "no_match",
    });
    await record({
      actor: { type: "SYSTEM", id: null, label: "unauthenticated" },
      action: "auth.login_failed",
      resource: "admin_user",
      resourceId: user?.id ?? null,
      result: "FAILURE",
      sourceIp: input.ip,
      metadata: { identifierHint: identifier, remaining: Math.max(0, limit.remaining - 1) },
    });
    if (user) {
      await prisma.adminUser.update({
        where: { id: user.id },
        data: { failedLogins: { increment: 1 } },
      });
    }
    throw errors.unauthenticated(PASSWORD_FAILURE);
  }

  if (user.status !== "ACTIVE" || (user.lockedUntil && user.lockedUntil.getTime() > Date.now())) {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: user.status !== "ACTIVE" ? "account_disabled" : "account_locked",
    });
    // A disabled account gets its own message (the operator needs to know to
    // re-enable it); a lockout is reported through the generic rate-limit path so
    // it cannot be used to confirm a username is real.
    if (user.status !== "ACTIVE") throw errors.forbidden("This account is not active.");
    throw errors.rateLimited("Too many failed attempts. Try again later.");
  }

  const now = new Date();
  const session = await createSession({ userId: user.id, ip: input.ip, userAgent: input.userAgent });

  await prisma.adminUser.update({
    where: { id: user.id },
    data: { lastLoginAt: now, failedLogins: 0, lockedUntil: null },
  });

  await recordAuthAttempt({ kind: "auth.login", identifier, ip: input.ip, success: true });
  await record({
    actor: userActor(user.id, user.username),
    action: "auth.login",
    resource: "admin_session",
    resourceId: session.sessionId,
    result: "SUCCESS",
    sourceIp: input.ip,
    metadata: { method: "password" },
  });

  return session;
}

/**
 * Access-code login.
 *
 * The code is verified with a constant-time scrypt comparison against every usable
 * code rather than by looking up a prefix, so the response time does not reveal how
 * much of a guessed code was correct.
 */
export async function loginWithAccessCode(input: LoginInput): Promise<SessionContext> {
  const normalized = input.accessCode.trim().toUpperCase();
  // Fingerprint (not the code) identifies the attempt in the rate-limit ledger.
  const identifier = fingerprintOf(normalized);

  const limit = await checkAuthRateLimit("auth.login", identifier);
  if (!limit.allowed) {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: "rate_limited",
    });
    await record({
      actor: { type: "SYSTEM", id: null, label: "unauthenticated" },
      action: "auth.rate_limited",
      resource: "access_code",
      result: "DENIED",
      sourceIp: input.ip,
      metadata: { scope: "auth.login" },
    });
    throw errors.rateLimited("Too many failed attempts. Try again later.", limit.retryAfterSeconds);
  }

  const now = new Date();
  const codes = await prisma.accessCode.findMany({
    where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    include: { createdBy: { select: { id: true, username: true, role: true, status: true } } },
  });

  const matched = codes.find(
    (code) => verifySecret(normalized, code.codeHash) || verifySecret(input.accessCode.trim(), code.codeHash),
  );

  if (!matched) {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: "no_match",
    });
    await record({
      actor: { type: "SYSTEM", id: null, label: "unauthenticated" },
      action: "auth.login_failed",
      resource: "access_code",
      result: "FAILURE",
      sourceIp: input.ip,
      metadata: { identifierHint: identifier, remaining: Math.max(0, limit.remaining - 1) },
    });
    // One message for every failure mode: never confirm whether a code exists.
    throw errors.unauthenticated("Access code is invalid.");
  }

  const owner = matched.createdBy;
  if (owner && owner.status !== "ACTIVE") {
    await recordAuthAttempt({
      kind: "auth.login",
      identifier,
      ip: input.ip,
      success: false,
      reason: "account_disabled",
    });
    throw errors.forbidden("This account is not active.");
  }

  let userId = owner?.id ?? null;
  if (!userId) {
    const fallback = await prisma.adminUser.findFirst({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "asc" },
    });
    userId = fallback?.id ?? null;
  }
  if (!userId) throw errors.unauthenticated("No active operator account exists.");

  const session = await createSession({
    userId,
    ip: input.ip,
    userAgent: input.userAgent,
  });

  await prisma.$transaction([
    prisma.accessCode.update({
      where: { id: matched.id },
      data: { lastUsedAt: now, useCount: { increment: 1 } },
    }),
    prisma.adminUser.update({
      where: { id: userId },
      data: { lastLoginAt: now, failedLogins: 0, lockedUntil: null },
    }),
  ]);

  await recordAuthAttempt({ kind: "auth.login", identifier, ip: input.ip, success: true });

  const user = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
  await record({
    actor: userActor(user.id, user.username),
    action: "auth.login",
    resource: "admin_session",
    resourceId: session.sessionId,
    result: "SUCCESS",
    sourceIp: input.ip,
    metadata: { method: "access_code", codeHint: matched.codeHint },
  });

  return session;
}

/**
 * Changes the signed-in operator's password.
 *
 * Proving the current credential is mandatory whenever one exists. An account that
 * was created access-code-only (the default first-boot owner before a password is
 * set) may set its first password by presenting a valid access code instead, which
 * is the credential that account actually holds.
 *
 * On success every live session of the user is revoked so a stolen cookie does not
 * survive a password change; the caller logs in again with the new password.
 */
export async function changeOwnPassword(input: {
  userId: string;
  currentPassword?: string | null;
  currentAccessCode?: string | null;
  newPassword: string;
  ip?: string | null;
}): Promise<void> {
  const user = await prisma.adminUser.findUnique({ where: { id: input.userId } });
  if (!user) throw errors.notFound("Account");
  if (user.status !== "ACTIVE") throw errors.forbidden("This account is not active.");

  const newPassword = input.newPassword.normalize("NFKC");
  if (newPassword.length < 12 || newPassword.length > 200) {
    throw errors.validation("The new password must be between 12 and 200 characters.");
  }

  if (user.passwordHash) {
    if (!input.currentPassword || !verifySecret(input.currentPassword, user.passwordHash)) {
      await record({
        actor: userActor(user.id, user.username),
        action: "auth.login_failed",
        resource: "admin_user",
        resourceId: user.id,
        result: "FAILURE",
        sourceIp: input.ip,
        metadata: { reason: "password_change_current_password_invalid" },
      });
      throw errors.unauthenticated("The current password is incorrect.");
    }
  } else {
    const code = input.currentAccessCode?.trim();
    if (!code) {
      throw errors.validation(
        "This account has no password yet. Provide the installation access code to set one.",
      );
    }
    const normalized = code.toUpperCase();
    const codes = await prisma.accessCode.findMany({
      where: { revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    });
    const matched = codes.some(
      (entry) => verifySecret(normalized, entry.codeHash) || verifySecret(code, entry.codeHash),
    );
    if (!matched) {
      await record({
        actor: userActor(user.id, user.username),
        action: "auth.login_failed",
        resource: "admin_user",
        resourceId: user.id,
        result: "FAILURE",
        sourceIp: input.ip,
        metadata: { reason: "password_change_access_code_invalid" },
      });
      throw errors.unauthenticated("The access code is incorrect.");
    }
  }

  await prisma.$transaction([
    prisma.adminUser.update({
      where: { id: user.id },
      data: { passwordHash: hashSecret(newPassword), failedLogins: 0, lockedUntil: null },
    }),
    prisma.adminSession.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date(), reason: "password_changed" },
    }),
  ]);

  await record({
    actor: userActor(user.id, user.username),
    action: "auth.password_changed",
    resource: "admin_user",
    resourceId: user.id,
    result: "SUCCESS",
    sourceIp: input.ip,
    metadata: { scope: "self", otherSessionsRevoked: true },
  });
}

/** Creates a session row, sets the cookies and returns the context. */
export async function createSession(input: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SessionContext> {
  const env = getEnv();
  const token = randomToken(32);
  const csrfSecret = randomToken(24);
  const expiresAt = new Date(Date.now() + env.SESSION_ABSOLUTE_TTL_MINUTES * 60 * 1000);

  const created = await prisma.adminSession.create({
    data: {
      userId: input.userId,
      tokenHash: sha256Hex(token),
      csrfSecret,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
    include: { user: true },
  });

  const csrfToken = deriveCsrfToken(token, csrfSecret);
  await writeSessionCookies({
    token,
    csrfToken,
    maxAgeSeconds: env.SESSION_ABSOLUTE_TTL_MINUTES * 60,
  });

  return {
    sessionId: created.id,
    user: {
      id: created.user.id,
      username: created.user.username,
      displayName: created.user.displayName,
      email: created.user.email,
      role: created.user.role,
      status: created.user.status,
    },
    token,
    csrfToken,
    expiresAt: created.expiresAt,
    lastSeenAt: created.lastSeenAt,
  };
}

/**
 * Resolves the current session from cookies.
 *
 * Enforces absolute expiry AND an idle timeout, and re-checks that the account is
 * still active on every call, so disabling an operator takes effect immediately
 * instead of at their next login.
 */
export async function getSession(): Promise<SessionContext | null> {
  const env = getEnv();
  const token = await readSessionToken();
  if (!token) return null;

  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { user: true },
  });

  if (!session || session.revokedAt) return null;

  const now = Date.now();
  if (session.expiresAt.getTime() <= now) return null;

  if (now - session.lastSeenAt.getTime() > env.SESSION_IDLE_TTL_MINUTES * 60 * 1000) {
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date(), reason: "idle_timeout" },
    });
    return null;
  }

  if (session.user.status !== "ACTIVE") return null;

  // Touch at most once a minute: several endpoints are polled per console page.
  if (now - session.lastSeenAt.getTime() > 60_000) {
    await prisma.adminSession.update({
      where: { id: session.id },
      data: { lastSeenAt: new Date() },
    });
  }

  return {
    sessionId: session.id,
    user: {
      id: session.user.id,
      username: session.user.username,
      displayName: session.user.displayName,
      email: session.user.email,
      role: session.user.role,
      status: session.user.status,
    },
    token,
    csrfToken: deriveCsrfToken(token, session.csrfSecret),
    expiresAt: session.expiresAt,
    lastSeenAt: session.lastSeenAt,
  };
}

/** Throws `UNAUTHENTICATED` when there is no valid session. */
export async function requireSession(): Promise<SessionContext> {
  const session = await getSession();
  if (!session) throw errors.unauthenticated();
  return session;
}

/**
 * CSRF verification for state-changing requests.
 *
 * The header and the readable cookie must both equal the token derived from THIS
 * session, so a stale cookie left over from a previous session cannot be replayed
 * and a cross-site form post cannot forge the header.
 */
export async function assertCsrf(request: Request, session: SessionContext): Promise<void> {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;

  const header = request.headers.get("x-vwray-csrf");
  const cookieToken = await readCsrfCookie();
  const expected = session.csrfToken;

  const headerOk = Boolean(header) && safeEqual(header as string, expected);
  const cookieOk = Boolean(cookieToken) && safeEqual(cookieToken as string, expected);

  if (!headerOk || !cookieOk) {
    await record({
      actor: userActor(session.user.id, session.user.username),
      action: "auth.login_failed",
      resource: "csrf",
      result: "DENIED",
      metadata: { reason: "csrf_mismatch", path: new URL(request.url).pathname },
    });
    throw errors.forbidden("The request could not be verified. Reload the console and try again.");
  }
}

export async function logout(reason = "logout"): Promise<void> {
  const token = await readSessionToken();
  if (token) {
    const session = await prisma.adminSession.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: { select: { id: true, username: true } } },
    });
    if (session && !session.revokedAt) {
      await prisma.adminSession.update({
        where: { id: session.id },
        data: { revokedAt: new Date(), reason },
      });
      await record({
        actor: userActor(session.user.id, session.user.username),
        action: "auth.logout",
        resource: "admin_session",
        resourceId: session.id,
        result: "SUCCESS",
      });
    }
  }
  await clearSessionCookies();
}

/** Sets or replaces an operator password. Never returns or logs the value. */
export async function setPassword(input: {
  userId: string;
  password: string;
  actorId: string;
  actorLabel: string;
}): Promise<void> {
  await prisma.adminUser.update({
    where: { id: input.userId },
    data: { passwordHash: hashSecret(input.password), failedLogins: 0, lockedUntil: null },
  });
  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: "settings.updated",
    resource: "admin_user",
    resourceId: input.userId,
    result: "SUCCESS",
    metadata: { field: "password" },
  });
}
