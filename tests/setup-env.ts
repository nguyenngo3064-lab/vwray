import { existsSync } from "node:fs";

/**
 * Test environment bootstrap.
 *
 * Loads `.env` (if present) and then forces the test database. This file is a
 * Vitest `setupFiles` entry, so it runs BEFORE any test module is imported, which
 * matters because `src/server/config/env.ts` memoises `process.env` on first use.
 *
 * The test database is deliberately a separate database (`TEST_DATABASE_URL`).
 * Suites truncate tables, and pointing them at the development database would delete
 * whatever the developer was looking at in the console.
 */

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const mutableEnv = process.env as unknown as Record<string, string | undefined>;
mutableEnv.NODE_ENV = "test";

const testUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!testUrl) {
  throw new Error(
    "Tests need TEST_DATABASE_URL (preferred) or DATABASE_URL. See .env.example.",
  );
}

if (!/test/i.test(testUrl) && process.env.ALLOW_DESTRUCTIVE_TESTS !== "true") {
  throw new Error(
    "Refusing to run the test suite against a database whose URL does not look like a test database. " +
      "Set TEST_DATABASE_URL, or ALLOW_DESTRUCTIVE_TESTS=true to override deliberately.",
  );
}

process.env.DATABASE_URL = testUrl;

// Deterministic secrets so tests do not depend on a developer's local .env values.
process.env.AUTH_SECRET ??= "test-auth-secret-value-that-is-long-enough-000000";
process.env.ENCRYPTION_KEY ??= "dGVzdC1lbmNyeXB0aW9uLWtleS0zMi1ieXRlcy1va2F5";
process.env.APP_URL ??= "http://localhost:3000";
process.env.DEV_MOCK_GATEWAY_ENABLED ??= "true";
process.env.ALLOW_BOOTSTRAP_CODE_RETRIEVAL ??= "true";
