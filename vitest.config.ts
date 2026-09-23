import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Test configuration.
 *
 * Test suites run against a real PostgreSQL database (TEST_DATABASE_URL) because the
 * behaviours under test - quota hard-limit enforcement, aggregate upserts with unique
 * constraints, transactional audit writes - are database behaviours. The global setup
 * applies migrations to that database before any suite runs.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    setupFiles: ["tests/setup-env.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Each file gets its own process so database truncation between files is safe.
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
