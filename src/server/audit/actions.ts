import type { ActorType } from "@prisma/client";

/**
 * Canonical audit action names.
 *
 * Namespaced `resource.verb` so the audit UI can filter by resource and group by
 * verb without string surgery. Adding an action here is the only way to record one.
 */
export type AuditAction =
  | "auth.bootstrap"
  | "auth.login"
  | "auth.login_failed"
  | "auth.logout"
  | "auth.session_revoked"
  | "auth.session_rotated"
  | "auth.access_code_created"
  | "auth.access_code_revoked"
  | "auth.access_code_rotated"
  | "auth.rate_limited"
  | "device.created"
  | "device.approved"
  | "device.rejected"
  | "device.blocked"
  | "device.unblocked"
  | "device.updated"
  | "device.quota_reset"
  | "device.disconnected"
  | "device.session_revoked"
  | "device.bulk_action"
  | "credential.created"
  | "credential.revoked"
  | "credential.rotated"
  | "config.created"
  | "config.updated"
  | "config.revoked"
  | "config.rolled_back"
  | "config.generated"
  | "config.expired"
  | "node.created"
  | "node.updated"
  | "node.removed"
  | "node.token_rotated"
  | "node.draining"
  | "node.heartbeat"
  | "node.offline"
  | "node.recovered"
  | "quota.created"
  | "quota.updated"
  | "quota.reset"
  | "quota.exceeded"
  | "quota.grace_applied"
  | "optimization.profile_created"
  | "optimization.profile_updated"
  | "optimization.assigned"
  | "dns.list_created"
  | "dns.list_updated"
  | "dns.rule_changed"
  | "billing.config_updated"
  | "billing.cost_computed"
  | "receipt.created"
  | "receipt.voided"
  | "receipt.regenerated"
  | "security.api_key_created"
  | "security.api_key_revoked"
  | "security.webhook_created"
  | "security.webhook_updated"
  | "security.anomaly_reviewed"
  | "settings.updated"
  | "settings.maintenance_mode"
  | "traffic.ingested"
  | "traffic.mock_ingested"
  | "maintenance.retention_run"
  | "notification.read";

export interface AuditActor {
  type: ActorType;
  /** AdminUser id when the actor is a person; null for SYSTEM/GATEWAY. */
  id: string | null;
  /** Human-readable label, e.g. username or node name. Never a secret. */
  label: string;
}

export const systemActor: AuditActor = { type: "SYSTEM", id: null, label: "system" };

export function nodeActor(nodeId: string, label: string): AuditActor {
  return { type: "GATEWAY", id: nodeId, label };
}

export function userActor(id: string, username: string): AuditActor {
  return { type: "USER", id, label: username };
}
