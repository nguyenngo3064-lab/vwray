import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Vitest global setup.
 *
 * Brings the test database to the exact schema the committed migrations describe.
 * Using `migrate reset` rather than `db push` means the tests exercise the SAME
 * migrations that production applies, so a broken migration fails the suite instead
 * of hiding behind schema introspection.
 */
export default async function globalSetup(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const testUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL must be set to run the test suite.");
  }

  // NOTE: Prisma 7 removed `--skip-seed` from `migrate reset` (seeding is configured
  // in prisma.config.ts, which declares no seed command here), so the flag is gone.
  execFileSync("npx", ["prisma", "migrate", "reset", "--force"], {
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      NODE_ENV: "development",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  });
}
