/**
 * Ambient shims for modules owned by parallel workstreams.
 *
 * These exist ONLY so `tsc --noEmit` stays green while those modules are being
 * written elsewhere. Normal file resolution shadows an ambient declaration as soon
 * as the real file lands, so each entry must be deleted when its workstream
 * delivers. No runtime behaviour depends on anything here.
 */

declare module "@/server/security/webhooks" {
  export interface WebhookDeliveryPayload {
    type: string;
    severity: string;
    title: string;
    body: string;
    resource: string | null;
    resourceId: string | null;
  }
  export function deliverNotifications(id: string, payload: WebhookDeliveryPayload): Promise<void>;
}
