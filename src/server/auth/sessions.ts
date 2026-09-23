import "server-only";
import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { deriveCsrfToken, sha256Hex } from "@/server/lib/crypto";
import { randomToken } from "@/server/lib/ids";
import { logger } from "@/server/lib/logger";
import { record, userActor } from "@/server/audit";
import { writeSessionCookies } from "@/server/auth/cookies";
import type { SessionContext } from "@/server/auth/service";

/**
 * Session administration: listing, revocation and rotation.
 *
 * Revocation is always a server-side state change. Clearing a cookie on the client is
 * a convenience, never the security boundary: a captured token stops working the
 * moment its row is marked revoked.
 */

export async function listSessions(userId?: string) {
  return prisma.adminSession.findMany({
    where: { ...(userId ? { userId } : {}), revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastSeenAt: "desc" },
    select: {
      id: true,
      userId: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      user: { select: { username: true, displayName: true, role: true } },
    },
  });
}

/** Recent sessions including revoked ones, for the security page. */
export async function listSessionHistory(limit = 50) {
  return prisma.adminSession.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      ip: true,
      userAgent: true,
      createdAt: true,
      lastSeenAt: true,
      expiresAt: true,
      revokedAt: true,
      reason: true,
      user: { select: { username: true } },
    },
  });
}

/** Revokes every live session of an operator. Used on rotation and emergency logout. */
export async function revokeUserSessions(
  userId: string,
  reason: string,
  actorId?: string | null,
): Promise<number> {
  const result = await prisma.adminSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), reason, revokedById: actorId ?? null },
  });
  if (result.count > 0) {
    logger.warn("sessions revoked", { userId, reason, count: result.count });
  }
  return result.count;
}

export async function revokeSessionById(input: {
  sessionId: string;
  reason: string;
  actorId: string | null;
  actorLabel: string;
}): Promise<void> {
  const updated = await prisma.adminSession.update({
    where: { id: input.sessionId },
    data: { revokedAt: new Date(), reason: input.reason, revokedById: input.actorId },
    select: { id: true, userId: true },
  });

  await record({
    actor: input.actorId ? userActor(input.actorId, input.actorLabel) : { type: "SYSTEM", id: null, label: "system" },
    action: "auth.session_revoked",
    resource: "admin_session",
    resourceId: updated.id,
    result: "SUCCESS",
    metadata: { reason: input.reason, subjectUserId: updated.userId },
  });
}

/**
 * Rotates the session token in place: the row survives, the cookie token changes.
 * Used after a privilege change so a previously captured token becomes useless while
 * the operator keeps working.
 */
export async function rotateSession(session: SessionContext): Promise<SessionContext> {
  const env = getEnv();
  const token = randomToken(32);
  const csrfSecret = randomToken(24);

  const updated = await prisma.adminSession.update({
    where: { id: session.sessionId },
    data: { tokenHash: sha256Hex(token), csrfSecret, lastSeenAt: new Date() },
  });

  const remainingSeconds = Math.floor((updated.expiresAt.getTime() - Date.now()) / 1000);

  await writeSessionCookies({
    token,
    csrfToken: deriveCsrfToken(token, csrfSecret),
    maxAgeSeconds:
      remainingSeconds > 60 ? remainingSeconds : env.SESSION_ABSOLUTE_TTL_MINUTES * 60,
  });

  await record({
    actor: userActor(session.user.id, session.user.username),
    action: "auth.session_rotated",
    resource: "admin_session",
    resourceId: session.sessionId,
    result: "SUCCESS",
  });

  return { ...session, token, csrfToken: deriveCsrfToken(token, csrfSecret) };
}
