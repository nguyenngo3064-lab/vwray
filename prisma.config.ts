import { existsSync } from "node:fs";
import { defineConfig } from "prisma/config";

/**
 * Prisma 7 configuration.
 *
 * Prisma 7 moved the connection URL out of `schema.prisma`. The CLI (migrate,
 * introspect, studio) reads it from here, while the application passes a driver
 * adapter to `new PrismaClient(...)` - see `src/server/db/client.ts`.
 *
 * `.env` is loaded explicitly with Node's built-in loader (available since Node
 * 20.12) so the CLI does not need the `dotenv` package. In containers the variables
 * are injected by the platform and no `.env` file exists, which is why the load is
 * guarded by an existence check.
 *
 * We read `process.env.DATABASE_URL` directly instead of using the `env()` helper
 * from `prisma/config`: that helper throws a hard `PrismaConfigEnvError` if the
 * variable is missing at the instant the config module is evaluated, which broke
 * `prisma generate` during Docker builds even though `DATABASE_URL` was set via
 * `ENV` in the Dockerfile. A direct read with a build-time fallback never throws,
 * so `prisma generate` (which only needs a syntactically valid URL, not a live
 * connection) always succeeds.
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://vwray:build-only@localhost:5432/vwray?schema=public";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: DATABASE_URL,
  },
  migrations: {
    path: "prisma/migrations",
  },
});
