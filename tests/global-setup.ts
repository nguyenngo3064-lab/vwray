import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Vitest global setup.
 *
 * Brings the test database to the exact schema the committed migrations describe.
 * The individual tests own their cleanup through resetDatabase(); global setup only
 * applies migrations so running tests never invokes a destructive Prisma command.
 */
export default async function globalSetup(): Promise<void> {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    throw new Error("TEST_DATABASE_URL must be set to run the test suite; refusing to reset DATABASE_URL.");
  }

  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "pipe",
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      NODE_ENV: "development",
      PRISMA_HIDE_UPDATE_MESSAGE: "1",
    },
  });
}
