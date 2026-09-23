import "server-only";
import { z } from "zod";
import { jsonOk, withErrorHandling } from "@/server/http/respond";
import { errors } from "@/server/lib/errors";
import { authenticateAgent } from "@/server/gateway/auth";
import { ingest, resolveIngestSource } from "@/server/traffic/collector";
import { checkHotBucket } from "@/server/auth/rate-limit";
import { generateRequestId } from "@/server/lib/ids";
import { logger } from "@/server/lib/logger";

/**
 * Traffic ingest from a gateway agent (DATA PLANE -> CONTROL PLANE).
 *
 * This endpoint is machine-authenticated with the per-node agent token, never with an
 * operator session, and it is deliberately NOT wrapped in `withConsole`: there is no
 * cookie, no CSRF token and no role involved. The security boundary is:
 *   1. `authenticateAgent` verifies the bearer token in constant time against the
 *      node's stored SHA-256 and rejects timestamps outside the skew window,
 *   2. the payload is schema-validated and bounded (a compromised agent must not be
 *      able to submit a million samples in one call),
 *   3. `ingest` resolves identity from credentials rather than source IP, feeds the
 *      realtime aggregator first, then persists in batches, then runs quota
 *      enforcement - the order that guarantees a byte is counted before the limit is
 *      evaluated against it.
 */

const sampleSchema = z.object({
  credentialPublicKey: z.string().min(1).max(200).optional(),
  deviceId: z.string().min(1).max(64).optional(),
  direction: z.enum(["UPLOAD", "DOWNLOAD"]),
  bytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  bytesOptimized: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  packets: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  connections: z.number().int().min(0).max(1_000_000).optional(),
  hostname: z.string().max(255).optional(),
  ip: z.string().max(45).optional(),
  category: z.string().max(60).optional(),
  ts: z.number().int().optional(),
});

const bodySchema = z.object({
  /** Bounded: one call carries one reporting interval, not an unbounded backlog. */
  samples: z.array(sampleSchema).min(1).max(5_000),
  timestamp: z.number().int().optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const requestId = request.headers.get("x-request-id") ?? generateRequestId();

  const { node } = await authenticateAgent(request);

  // Ingest is high frequency by nature, so the budget is generous - it exists to stop
  // a single compromised token from becoming an unbounded write amplifier.
  const bucket = checkHotBucket(`gateway:traffic:${node.nodeId}`, 600, 60);
  if (!bucket.allowed) {
    throw errors.rateLimited("Traffic ingest is being throttled for this node.", bucket.retryAfterSeconds);
  }

  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success) {
    throw errors.validation("The traffic payload is invalid.", {
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }

  const source = await resolveIngestSource(node);

  const result = await ingest(node, {
    samples: parsed.data.samples.map((sample) => ({
      ...sample,
      bytesOptimized: sample.bytesOptimized ?? null,
      packets: sample.packets ?? null,
      connections: sample.connections ?? null,
      hostname: sample.hostname ?? null,
      ip: sample.ip ?? null,
      category: sample.category ?? null,
      ts: sample.ts ?? null,
    })),
    timestamp: parsed.data.timestamp ?? null,
  });

  logger.debug("traffic ingested", {
    nodeId: node.nodeId,
    accepted: result.accepted,
    source,
    requestId,
  });

  return jsonOk({ ...result, nodeId: node.nodeId }, { requestId });
});

/** Reads and parses the JSON body, rejecting empties explicitly. */
async function readBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim().length === 0) throw errors.validation("A JSON request body is required.");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw errors.validation("The request body is not valid JSON.");
  }
}
