/**
 * Error taxonomy for the control plane.
 *
 * Every API failure maps to one of these codes, so the HTTP layer never has to
 * guess a status code and the client always receives the same envelope. Messages on
 * `AppError` are safe to show an operator; anything that could leak internals (SQL
 * text, upstream URLs, stack frames) stays in the server logs via `cause`.
 */

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NODE_REVOKED"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PRECONDITION_FAILED"
  | "DEPENDENCY_UNAVAILABLE"
  | "GATEWAY_UNAVAILABLE"
  | "GATEWAY_REJECTED"
  | "QUOTA_EXCEEDED"
  | "DEVICE_BLOCKED"
  | "INVALID_STATE"
  | "UNSUPPORTED"
  | "INTERNAL_ERROR";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NODE_REVOKED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  PRECONDITION_FAILED: 412,
  DEPENDENCY_UNAVAILABLE: 503,
  GATEWAY_UNAVAILABLE: 503,
  GATEWAY_REJECTED: 502,
  QUOTA_EXCEEDED: 409,
  DEVICE_BLOCKED: 403,
  INVALID_STATE: 409,
  UNSUPPORTED: 501,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Extra machine-readable context, e.g. which quota was exceeded. */
  readonly details?: Record<string, unknown>;
  /** True when retrying the same request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown; retryable?: boolean },
  ) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = options?.details;
    this.retryable = options?.retryable ?? (code === "DEPENDENCY_UNAVAILABLE" || code === "GATEWAY_UNAVAILABLE");
    if (options?.cause !== undefined) this.cause = options.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      details: this.details ?? null,
      retryable: this.retryable,
    };
  }
}

export const errors = {
  validation: (message: string, details?: Record<string, unknown>) =>
    new AppError("VALIDATION_ERROR", message, { details }),
  unauthenticated: (message = "Authentication required.") => new AppError("UNAUTHENTICATED", message),
  forbidden: (message = "You do not have permission to perform this action.") =>
    new AppError("FORBIDDEN", message),
  nodeRevoked: () => new AppError("NODE_REVOKED", "Node has been revoked by the Control Plane."),
  notFound: (resource: string) => new AppError("NOT_FOUND", `${resource} was not found.`),
  conflict: (message: string, details?: Record<string, unknown>) => new AppError("CONFLICT", message, { details }),
  rateLimited: (message = "Too many attempts. Try again later.", retryAfterSeconds?: number) =>
    new AppError("RATE_LIMITED", message, {
      details: retryAfterSeconds ? { retryAfterSeconds } : undefined,
    }),
  precondition: (message: string, details?: Record<string, unknown>) =>
    new AppError("PRECONDITION_FAILED", message, { details }),
  dependency: (message: string, cause?: unknown) => new AppError("DEPENDENCY_UNAVAILABLE", message, { cause }),
  gatewayUnavailable: (message: string, cause?: unknown) =>
    new AppError("GATEWAY_UNAVAILABLE", message, { cause }),
  gatewayRejected: (message: string, details?: Record<string, unknown>) =>
    new AppError("GATEWAY_REJECTED", message, { details }),
  quotaExceeded: (message: string, details?: Record<string, unknown>) =>
    new AppError("QUOTA_EXCEEDED", message, { details }),
  deviceBlocked: (message = "This device is blocked.") => new AppError("DEVICE_BLOCKED", message),
  invalidState: (message: string, details?: Record<string, unknown>) =>
    new AppError("INVALID_STATE", message, { details }),
  unsupported: (message: string) => new AppError("UNSUPPORTED", message),
  internal: (message = "An unexpected error occurred.", cause?: unknown) =>
    new AppError("INTERNAL_ERROR", message, { cause }),
};

/** Narrows unknown thrown values into an AppError without losing the original cause. */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return errors.internal("An unexpected error occurred.", error);
  return errors.internal("An unexpected error occurred.", new Error(String(error)));
}

/** Human-readable message that never includes stack or SQL detail. */
export function publicMessage(error: unknown): string {
  if (error instanceof AppError) return error.message;
  return "An unexpected error occurred.";
}
