import "server-only";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { getEnv } from "@/server/config/env";
import { logger } from "@/server/lib/logger";

/**
 * Prisma client.
 *
 * Prisma 7 requires a driver adapter instead of a connection URL in the schema, so
 * the client is constructed around `node-postgres`. A single pool is shared across
 * the process: Next.js dev mode re-evaluates modules on every edit, and creating a
 * new pool per reload exhausts PostgreSQL connections within a few minutes.
 */

declare global {
  // eslint-disable-next-line no-var
  var __vwrayPrisma: PrismaClient | undefined;
}

function createClient(): PrismaClient {
  const env = getEnv();

  const adapter = new PrismaPg({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    // A control plane that cannot answer a query in 15s is better off failing the
    // request than queuing behind a stuck connection.
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    application_name: "vwray-control-plane",
  });

  return new PrismaClient({
    adapter,
    log: env.isProduction
      ? [{ emit: "event", level: "error" }]
      : [
          { emit: "event", level: "error" },
          { emit: "event", level: "warn" },
        ],
  });
}

export const prisma: PrismaClient = globalThis.__vwrayPrisma ?? createClient();

if (!globalThis.__vwrayPrisma) {
  globalThis.__vwrayPrisma = prisma;
}

/** Surfaces database-level failures in the structured log without printing SQL. */
prisma.$on("error" as never, (event: unknown) => {
  logger.error("database error", { event });
});

/**
 * Lightweight connectivity probe used by `/api/health` and the dashboard status
 * strip. Returns a discriminated result instead of throwing so a health endpoint
 * can report "database unavailable" rather than returning a 500 with no detail.
 */
export async function checkDatabase(): Promise<
  { ok: true; latencyMs: number } | { ok: false; error: string; latencyMs: number }
> {
  const startedAt = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "unknown database error",
      latencyMs: Date.now() - startedAt,
    };
  }
}

/** Closes the pool. Used by the test harness and graceful shutdown. */
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
