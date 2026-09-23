import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AppError, toAppError } from "@/server/lib/errors";
import { logger } from "@/server/lib/logger";
import { generateRequestId } from "@/server/lib/ids";

/**
 * Single response envelope for every API route.
 *
 * Success:
 *   { data: T, meta?: {...}, requestId }
 * Failure:
 *   { error: { code, message, details, retryable }, requestId }
 *
 * Having exactly one shape means the browser client can have one parser, and the
 * `requestId` lets an operator correlate a user-visible failure with the structured
 * logs and the audit trail.
 */

export interface ResponseMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  hasMore?: boolean;
  [key: string]: unknown;
}

export function jsonOk<T>(data: T, init?: { status?: number; meta?: ResponseMeta; requestId?: string }) {
  return NextResponse.json(
    {
      data,
      ...(init?.meta ? { meta: init.meta } : {}),
      requestId: init?.requestId ?? generateRequestId(),
    },
    { status: init?.status ?? 200 },
  );
}

export function jsonError(error: unknown, init?: { requestId?: string; headers?: HeadersInit }) {
  const appError: AppError = toAppError(error);
  const requestId = init?.requestId ?? generateRequestId();

  // Validation issues are the caller's problem, so they are logged at debug level.
  // Anything else is ours, and gets an error-level line with the cause attached.
  if (appError.code === "VALIDATION_ERROR" || appError.code === "UNAUTHENTICATED" || appError.code === "FORBIDDEN") {
    logger.debug("request rejected", {
      requestId,
      code: appError.code,
      message: appError.message,
    });
  } else {
    logger.error("request failed", {
      requestId,
      code: appError.code,
      message: appError.message,
      cause: appError.cause,
      details: appError.details,
    });
  }

  const headers = new Headers(init?.headers);
  if (appError.code === "RATE_LIMITED") {
    const retryAfter = appError.details?.retryAfterSeconds;
    if (typeof retryAfter === "number") headers.set("Retry-After", String(Math.ceil(retryAfter)));
  }

  return NextResponse.json(
    { error: appError.toJSON(), requestId },
    { status: appError.status, headers },
  );
}

/**
 * Wraps a route handler so that thrown AppErrors, Zod errors and unexpected
 * exceptions all become the envelope above. Never leaks a stack trace to a client.
 */
export function withErrorHandling<Args extends unknown[]>(
  handler: (request: Request, ...args: Args) => Promise<Response>,
) {
  return async (request: Request, ...args: Args): Promise<Response> => {
    const requestId = request.headers.get("x-request-id") ?? generateRequestId();
    try {
      const response = await handler(request, ...args);
      if (!response.headers.has("x-request-id")) response.headers.set("x-request-id", requestId);
      return response;
    } catch (error) {
      if (error instanceof ZodError) {
        return jsonError(
          new AppError("VALIDATION_ERROR", "The request payload is invalid.", {
            details: {
              issues: error.issues.map((issue) => ({
                path: issue.path.join("."),
                message: issue.message,
              })),
            },
          }),
          { requestId },
        );
      }
      return jsonError(error, { requestId });
    }
  };
}

/** `Content-Disposition` helper for CSV/PDF/JSON downloads. */
export function attachmentHeaders(filename: string, contentType: string): HeadersInit {
  const safeName = filename.replace(/[^A-Za-z0-9._-]/g, "_");
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${safeName}"`,
    "Cache-Control": "no-store",
  };
}

/** CSV serialisation with RFC 4180 quoting and formula-injection neutralisation. */
export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escapeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const raw = typeof value === "bigint" ? value.toString() : String(value);
    // A leading =, +, - or @ makes spreadsheet software treat the cell as a formula.
    // Prefixing with an apostrophe keeps the value readable and inert.
    const neutralised = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return `"${neutralised.replace(/"/g, '""')}"`;
  };

  const header = columns.map(escapeCell).join(",");
  const body = rows.map((row) => columns.map((column) => escapeCell(row[column])).join(","));
  return [header, ...body].join("\r\n");
}
