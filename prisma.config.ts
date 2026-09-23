import { existsSync } from "node:fs";
import { defineConfig, env } from "prisma/config";

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
 */
if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: env("DATABASE_URL"),
  },
  migrations: {
    path: "prisma/migrations",
  },
});
