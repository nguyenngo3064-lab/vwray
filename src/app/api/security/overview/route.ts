import "server-only";
import { jsonOk } from "@/server/http/respond";
import { withConsole } from "@/server/http/guard";
import { prisma } from "@/server/db/client";

/**
 * Security centre read model.
 *
 * Failed logins, session counts, credential status, blocked devices, open anomalies and
 * recent security-relevant audit rows - nothing is computed from anything but stored
 * state, and nothing secret is selected.
 */
export const GET = withConsole(
  async (_request, ctx) => {
    const windowHours = 24;
    const windowFrom = new Date(Date.now() - windowHours * 3_600_000);

    const [
      failedLogins,
      activeSessions,
      lockedAccounts,
      blockedDevices,
      revokedCredentials,
      openAnomalies,
      unread,
      recentSecurity,
      policyActions,
    ] = await Promise.all([
      prisma.authAttempt.count({ where: { success: false, createdAt: { gte: windowFrom } } }),
      prisma.adminSession.count({ where: { revokedAt: null, expiresAt: { gt: new Date() } } }),
      prisma.adminUser.count({ where: { OR: [{ lockedUntil: { gt: new Date() } }, { status: { not: "ACTIVE" } }] } }),
      prisma.device.count({ where: { OR: [{ approvalState: "BLOCKED" }, { blockedAt: { not: null } }] } }),
      prisma.deviceCredential.count({ where: { revokedAt: { not: null } } }),
      prisma.anomalyEvent.count({ where: { status: "OPEN" } }),
      prisma.notification.count({ where: { readAt: null } }),
      prisma.auditLog.findMany({
        where: {
          ts: { gte: windowFrom },
          action: {
            in: [
              "auth.login_failed",
              "auth.rate_limited",
              "device.blocked",
              "device.unblocked",
              "credential.revoked",
              "credential.rotated",
              "auth.session_revoked",
              "security.api_key_revoked",
              "auth.access_code_revoked",
            ],
          },
        },
        orderBy: { ts: "desc" },
        take: 30,
        select: { id: true, ts: true, action: true, result: true, actorLabel: true, resource: true, resourceId: true },
      }),
      prisma.policyExecution.findMany({
        where: { result: "APPLIED" },
        orderBy: { evaluatedAt: "desc" },
        take: 20,
        include: { policy: { select: { name: true } } },
      }),
    ]);

    return jsonOk(
      {
        failedLogins: { count: failedLogins, windowHours },
        activeSessions,
        lockedAccounts,
        blockedDevices,
        revokedCredentials,
        openAnomalies,
        unread,
        recentSecurityEvents: recentSecurity.map((row) => ({
          id: row.id,
          ts: row.ts.toISOString(),
          action: row.action,
          result: row.result,
          actorLabel: row.actorLabel,
          resource: row.resource,
          resourceId: row.resourceId,
        })),
        policyActions: policyActions.map((row) => ({
          ts: row.evaluatedAt.toISOString(),
          policyName: row.policy.name,
          actionKey: row.actionKey,
          targetLabel: row.targetLabel,
          metric: row.metric,
          observed: row.observed,
          threshold: row.threshold,
        })),
      },
      { requestId: ctx.requestId },
    );
  },
  { rateLimit: { limit: 60, windowSeconds: 60 } },
);
