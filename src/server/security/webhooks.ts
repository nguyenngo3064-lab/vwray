import "server-only";
import { prisma } from "@/server/db/client";
import { logger } from "@/server/lib/logger";
import { hmacHex, unsealSecret } from "@/server/lib/crypto";
import { assertSafeOutboundUrl } from "@/server/security/ssrf";

/**
 * Outbound webhook delivery.
 *
 * This module is what `notifications/service.ts` lazily imports, so an installation
 * with no webhook endpoints pays nothing but still has working alert fan-out the
 * moment an operator configures one.
 *
 * Delivery rules:
 *   * The URL is re-validated through the SSRF guard on EVERY send, so an endpoint
 *     whose DNS later starts pointing at `127.0.0.1` is refused rather than followed.
 *   * The body is signed with `X-VWRAY-Signature: sha256=<hex hmac>` over
 *     `<timestamp>.<body>`, with the timestamp in `X-VWRAY-Timestamp`. A receiver
 *     therefore cannot be tricked into accepting a different body under the same
 *     signature.
 *   * A slow or broken receiver can never block the operation that raised the
 *     notification: sends run under an AbortController with a hard timeout, and each
 *     failure is recorded on the endpoint row.
 *   * Delivery is deliberately NOT retried in-process. A real retry needs durable
 *     storage and a worker; an in-memory `setTimeout` retry would be lost on restart
 *     and pretending otherwise would be dishonest. Failures are visible on the
 *     Security page instead.
 */

const DELIVERY_TIMEOUT_MS = 6_000;

/** Matches the notification payload published on the realtime bus. */
export interface WebhookDeliveryPayload {
  type: string;
  severity: string;
  title: string;
  body: string;
  resource: string | null;
  resourceId: string | null;
}

export interface DeliveryOutcome {
  endpointId: string;
  ok: boolean;
  status: number | null;
  error: string | null;
}

function buildBody(notificationId: string, payload: WebhookDeliveryPayload): string {
  return JSON.stringify({
    event: payload.type,
    severity: payload.severity,
    title: payload.title,
    body: payload.body,
    resource: payload.resource,
    resourceId: payload.resourceId,
    notificationId,
    deliveredAt: new Date().toISOString(),
    source: "vwray-control-plane",
    /** Reminds a receiver that this is telemetry, not a blind instruction to act. */
    notice: "Operational alert from a self-hosted console. The payload is informational.",
  });
}

async function deliverOne(
  endpoint: { id: string; url: string; secretSealed: string | null },
  notificationId: string,
  payload: WebhookDeliveryPayload,
): Promise<DeliveryOutcome> {
  try {
    const safe = await assertSafeOutboundUrl(endpoint.url);
    const body = buildBody(notificationId, payload);
    const timestamp = String(Math.floor(Date.now() / 1000));

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "vwray-control-plane/1.0 (+webhook)",
      "X-VWRAY-Event": payload.type,
      "X-VWRAY-Timestamp": timestamp,
      "X-VWRAY-Delivery": notificationId,
    };

    if (endpoint.secretSealed) {
      // Sealed at rest with the same AES-256-GCM key as VPN credentials, so a
      // database dump alone cannot be used to forge a delivery.
      const secret = unsealSecret(endpoint.secretSealed);
      headers["X-VWRAY-Signature"] = `sha256=${hmacHex(secret, `${timestamp}.${body}`)}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
    try {
      const response = await fetch(safe.url.toString(), {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
        // A redirect is how an allowed URL would reach a blocked one.
        redirect: "error",
      });
      return { endpointId: endpoint.id, ok: response.ok, status: response.status, error: null };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      endpointId: endpoint.id,
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : "delivery failed",
    };
  }
}

/**
 * Fans one notification out to every enabled endpoint subscribed to its event type.
 * Never throws: a delivery problem must not roll back the action that raised it.
 */
export async function deliverNotifications(
  notificationId: string,
  payload: WebhookDeliveryPayload,
): Promise<DeliveryOutcome[]> {
  try {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { enabled: true } });
    const subscribed = endpoints.filter(
      (endpoint) =>
        endpoint.events.length === 0 ||
        endpoint.events.includes(payload.type) ||
        endpoint.events.includes("*"),
    );
    if (subscribed.length === 0) return [];

    // Sequential rather than parallel: a handful of endpoints, and serial delivery
    // keeps the per-endpoint failure accounting unambiguous.
    const outcomes: DeliveryOutcome[] = [];
    for (const endpoint of subscribed) {
      const outcome = await deliverOne(endpoint, notificationId, payload);
      outcomes.push(outcome);

      await prisma.webhookEndpoint
        .update({
          where: { id: endpoint.id },
          data: {
            lastDeliveryAt: new Date(),
            lastStatus: outcome.ok ? `HTTP ${outcome.status}` : (outcome.error ?? "failed"),
            failureCount: outcome.ok ? 0 : { increment: 1 },
          },
        })
        .catch((error) => logger.warn("webhook status update failed", { endpointId: endpoint.id, error }));

      if (!outcome.ok) {
        logger.warn("webhook delivery failed", {
          endpointId: endpoint.id,
          event: payload.type,
          status: outcome.status,
          error: outcome.error,
        });
      }
    }

    return outcomes;
  } catch (error) {
    logger.error("webhook dispatch failed", { notificationId, error });
    return [];
  }
}

/** Sends a synthetic test event, used by the Security page to verify an endpoint. */
export async function sendTestDelivery(endpointId: string): Promise<DeliveryOutcome> {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id: endpointId } });
  if (!endpoint) return { endpointId, ok: false, status: null, error: "Endpoint not found." };

  const outcome = await deliverOne(endpoint, `test-${endpointId}`, {
    type: "webhook.test",
    severity: "INFO",
    title: "Webhook test delivery",
    body: "Test event sent from the VWRAY console. No action is required.",
    resource: "webhook_endpoint",
    resourceId: endpointId,
  });

  await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: {
      lastDeliveryAt: new Date(),
      lastStatus: outcome.ok ? `HTTP ${outcome.status}` : (outcome.error ?? "failed"),
      failureCount: outcome.ok ? 0 : { increment: 1 },
    },
  });

  return outcome;
}
