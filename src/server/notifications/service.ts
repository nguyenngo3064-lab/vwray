import "server-only";
import { prisma } from "@/server/db/client";
import { publish } from "@/server/realtime/bus";
import { logger } from "@/server/lib/logger";
import { getSetting } from "@/server/settings/service";
import type { NotificationSeverity } from "@prisma/client";

/**
 * Notification service.
 *
 * Notifications are derived from real events (a node actually went stale, a quota
 * actually crossed a threshold, a gateway actually rejected a credential). Nothing
 * here generates "informational" notifications to make the bell icon look busy.
 *
 * Delivery path today: persist the row, then fan out on the realtime bus so an
 * operator with the console open sees it immediately. Webhook fan-out is gated by
 * the `notifications.webhookEnabled` setting and the endpoints managed under
 * Security; see `dispatchWebhooks` below.
 */

export type NotificationType =
  | "node.offline"
  | "node.recovered"
  | "quota.warning"
  | "quota.exceeded"
  | "anomaly.detected"
  | "config.revoked"
  | "device.approved"
  | "device.rejected"
  | "auth.failures"
  | "optimization.changed";

/** Which setting key gates a given notification type. */
const EVENT_SETTING: Partial<Record<NotificationType, keyof EventsSetting>> = {
  "node.offline": "nodeOffline",
  "quota.warning": "quotaWarning",
  "quota.exceeded": "quotaExceeded",
  "anomaly.detected": "anomalyDetected",
  "auth.failures": "authFailures",
  "device.approved": "deviceApproval",
  "device.rejected": "deviceApproval",
  "config.revoked": "configRevoked",
  "optimization.changed": "optimizationChanged",
};

interface EventsSetting {
  nodeOffline: boolean;
  quotaWarning: boolean;
  quotaExceeded: boolean;
  anomalyDetected: boolean;
  authFailures: boolean;
  deviceApproval: boolean;
  configRevoked: boolean;
  optimizationChanged: boolean;
}

export interface NotifyInput {
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  resource?: string;
  resourceId?: string;
}

/**
 * Creates a notification if the operator has not disabled this event type.
 * Returns the persisted row, or null when the event is muted.
 */
export async function notify(input: NotifyInput) {
  try {
    const enabled = await getSetting<EventsSetting>("notifications.events");
    const gate = EVENT_SETTING[input.type];
    if (gate && enabled[gate] === false) return null;

    const created = await prisma.notification.create({
      data: {
        severity: input.severity,
        type: input.type,
        title: input.title,
        body: input.body,
        resource: input.resource ?? null,
        resourceId: input.resourceId ?? null,
      },
    });

    publish("notification", {
      ts: created.createdAt.getTime(),
      id: created.id,
      severity: created.severity,
      type: created.type,
      title: created.title,
      body: created.body,
    });

    void dispatchWebhooks(created.id, input);
    return created;
  } catch (error) {
    // A notification is never worth failing the operation that triggered it.
    logger.error("notification create failed", { type: input.type, error });
    return null;
  }
}

/**
 * Optional webhook fan-out.
 *
 * The delivery implementation lives next to the rest of the outbound-integration
 * code; it is imported lazily so an installation without webhook destinations pays
 * nothing, and a delivery failure never bubbles into the caller.
 */
async function dispatchWebhooks(id: string, input: NotifyInput): Promise<void> {
  try {
    const enabled = await getSetting<boolean>("notifications.webhookEnabled");
    if (!enabled) return;

    const { deliverNotifications } = await import("@/server/security/webhooks");
    await deliverNotifications(id, {
      type: input.type,
      severity: input.severity,
      title: input.title,
      body: input.body,
      resource: input.resource ?? null,
      resourceId: input.resourceId ?? null,
    });

    await prisma.notification.update({ where: { id }, data: { webhookDeliveredAt: new Date() } });
  } catch (error) {
    // Not fatal: the in-dashboard notification already exists.
    logger.warn("webhook delivery skipped", { notificationId: id, error });
  }
}

export async function listNotifications(options?: {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
}) {
  const where = options?.unreadOnly ? { readAt: null } : {};
  const [items, total, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(options?.limit ?? 30, 100),
      skip: options?.offset ?? 0,
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { readAt: null } }),
  ]);

  return { items, total, unread };
}

export async function markRead(ids: string[]): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}

export async function markAllRead(): Promise<number> {
  const result = await prisma.notification.updateMany({
    where: { readAt: null },
    data: { readAt: new Date() },
  });
  return result.count;
}
