import "server-only";

/**
 * Policy resolution for one device (CONTROL PLANE -> DATA PLANE contract).
 *
 * The snapshot type is declared structurally instead of being derived from the Prisma
 * model: the route selects only the columns it needs, and a type derived from
 * `device.findMany()` would demand every column back, which silently pushes callers
 * toward over-fetching just to satisfy the compiler.
 *
 * Precedence mirrors `isDeviceBlocked()` in the devices service: an operator decision
 * and an enforcement decision are both blocking, and the reason is taken from the
 * strongest one, so the agent reports the state that actually applies.
 *
 * Every reason returned here is either fixed text or a value from the settings
 * registry. Operator notes and internal rationale never leave this process, because a
 * rejected device can read whatever the agent tells it.
 */
export interface DevicePolicySnapshot {
  id: string;
  deviceId: string;
  approvalState: "PENDING" | "APPROVED" | "REJECTED" | "BLOCKED";
  connectionStatus: string;
  quotaExceededAt: Date | null;
  blockedAt: Date | null;
  assignedConfig: { status: string; expiresAt: Date | null } | null;
}

export interface PolicyDecision {
  state: "ACTIVE" | "BLOCKED" | "QUOTA_EXCEEDED" | "REVOKED";
  reason: string;
}

export function resolvePolicy(
  device: DevicePolicySnapshot,
  policy: { state: string } | undefined,
  configExpired: boolean,
  rejectMessage: string,
): PolicyDecision {
  if (device.approvalState === "PENDING" || device.approvalState === "REJECTED") {
    return { state: "BLOCKED", reason: rejectMessage };
  }
  if (device.approvalState === "BLOCKED") return { state: "BLOCKED", reason: rejectMessage };
  if (device.blockedAt) return { state: "BLOCKED", reason: rejectMessage };
  if (device.connectionStatus === "QUOTA_EXCEEDED" || device.quotaExceededAt) {
    return { state: "QUOTA_EXCEEDED", reason: "Data limit reached for this device." };
  }
  if (device.assignedConfig?.status === "REVOKED") {
    return { state: "REVOKED", reason: "This configuration is no longer valid." };
  }
  if (configExpired) return { state: "REVOKED", reason: "This configuration has expired." };
  if (policy?.state === "BLOCKED") return { state: "BLOCKED", reason: rejectMessage };
  if (policy?.state === "QUOTA_EXCEEDED") {
    return { state: "QUOTA_EXCEEDED", reason: "Data limit reached for this device." };
  }
  if (policy?.state === "REVOKED") {
    return { state: "REVOKED", reason: "This configuration is no longer valid." };
  }
  if (policy?.state === "WARNED_80" || policy?.state === "WARNED_90") {
    return { state: "ACTIVE", reason: "Allowed by control plane" };
  }
  return { state: "ACTIVE", reason: "Allowed by control plane" };
}
