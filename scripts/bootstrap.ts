import { existsSync } from "node:fs";

if (typeof process.loadEnvFile === "function" && existsSync(".env")) {
  process.loadEnvFile(".env");
}

const SENSITIVE_ENV_NAME = /(?:DATABASE_URL|PASSWORD|SECRET|TOKEN|ACCESS_CODE|API_KEY|ENCRYPTION_KEY|PRIVATE_KEY)/i;

function safeErrorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : "Unknown error.";

  for (const [name, value] of Object.entries(process.env)) {
    if (value && SENSITIVE_ENV_NAME.test(name)) {
      message = message.replaceAll(value, `[redacted ${name}]`);
    }
  }

  return message.replace(/\bpostgres(?:ql)?:\/\/[^\s"'`]+/gi, "[redacted database URL]");
}

async function main(): Promise<void> {
  let prisma: (typeof import("@/server/db/client"))["prisma"] | undefined;

  try {
    const { getEnv } = await import("@/server/config/env");
    const env = getEnv();
    const db = await import("@/server/db/client");
    prisma = db.prisma;

    const existingUsers = await prisma.adminUser.count();
    if (existingUsers === 0 && !env.OWNER_PASSWORD) {
      throw new Error(
        "OWNER_PASSWORD must be configured (12+ characters) before bootstrapping a new installation.",
      );
    }

    const { ensureBootstrapOwner } = await import("@/server/auth/service");
    const result = await ensureBootstrapOwner();
    const seededSettings = await (await import("@/server/settings/service")).ensureSettingsSeeded();

    if (!result.created) {
      console.log(
        `Bootstrap skipped: an operator account already exists. Credentials were not changed; seeded ${seededSettings} missing settings.`,
      );
      return;
    }

    console.log(
      `Bootstrap complete for ${result.username}. Sign in with the configured OWNER_PASSWORD; seeded ${seededSettings} settings.`,
    );
  } finally {
    await prisma?.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error("Bootstrap failed:", safeErrorMessage(error));
  process.exitCode = 1;
});