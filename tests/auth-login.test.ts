import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Password & access-code authentication behaviour.
 *
 * `next/headers` is mocked here because the session service writes cookies
 * through it, and there is no request scope inside Vitest. The mock is a plain
 * in-memory jar: setting a cookie makes it readable afterwards, exactly like a
 * browser round trip for the purposes of this suite.
 */

const jar = new Map<string, string>();

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

import { prisma } from "@/server/db/client";
import { getEnv } from "@/server/config/env";
import { proxy } from "@/proxy";
import { GET as getAuthStatus } from "@/app/api/auth/route";
import { hashSecret, verifySecret } from "@/server/lib/crypto";
import {
  changeOwnPassword,
  ensureBootstrapOwner,
  getSession,
  loginWithAccessCode,
  loginWithPassword,
  logout,
} from "@/server/auth/service";
import { resetDatabase } from "./helpers/db";

const PASSWORD = randomBytes(24).toString("base64url");

async function createOwner(password: string | null): Promise<{ userId: string }> {
  const user = await prisma.adminUser.create({
    data: {
      username: "owner",
      displayName: "Owner",
      role: "OWNER",
      status: "ACTIVE",
      ...(password ? { passwordHash: hashSecret(password) } : {}),
    },
  });
  return { userId: user.id };
}

beforeEach(async () => {
  jar.clear();
  await resetDatabase();
});

describe("password hashing", () => {
  it("hashes with scrypt and never returns the plaintext", () => {
    const hash = hashSecret(PASSWORD);
    expect(hash).not.toContain(PASSWORD);
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(verifySecret(PASSWORD, hash)).toBe(true);
    expect(verifySecret("wrong-password", hash)).toBe(false);
    expect(verifySecret(PASSWORD, null)).toBe(false);
    expect(verifySecret(PASSWORD, "not-a-hash")).toBe(false);
  });
});

describe("password login", () => {
  it("signs in with the correct password and resolves the session", async () => {
    await createOwner(PASSWORD);
    const session = await loginWithPassword({ username: "owner", password: PASSWORD });
    expect(session.user.username).toBe("owner");
    expect(session.csrfToken.length).toBeGreaterThan(16);
    const resolved = await getSession();
    expect(resolved?.sessionId).toBe(session.sessionId);
  });

  it("rejects a wrong password with the generic message", async () => {
    await createOwner(PASSWORD);
    await expect(loginWithPassword({ username: "owner", password: "nope-nope-nope-nope" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Username or password is invalid.",
    });
  });

  it("rejects an unknown user with the SAME message (no enumeration)", async () => {
    const failure = (await loginWithPassword({ username: "ghost-operator", password: PASSWORD }).catch(
      (error: unknown) => error,
    )) as Error & { code?: string };
    expect(failure).toBeInstanceOf(Error);
    expect(failure.code).toBe("UNAUTHENTICATED");
    expect(failure.message).toBe("Username or password is invalid.");
  });

  it("rejects an account with no password set, with the same message", async () => {
    await createOwner(null);
    await expect(loginWithPassword({ username: "owner", password: PASSWORD })).rejects.toMatchObject({
      message: "Username or password is invalid.",
    });
  });

  it("increments failedLogins and resets them on success", async () => {
    const { userId } = await createOwner(PASSWORD);
    await loginWithPassword({ username: "owner", password: "wrong-password-here" }).catch(() => undefined);
    const afterFail = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
    expect(afterFail.failedLogins).toBe(1);
    await loginWithPassword({ username: "owner", password: PASSWORD });
    const afterSuccess = await prisma.adminUser.findUniqueOrThrow({ where: { id: userId } });
    expect(afterSuccess.failedLogins).toBe(0);
    expect(afterSuccess.lastLoginAt).not.toBeNull();
  });

  it("locks out after the configured attempt budget (durable, restart-proof)", async () => {
    await createOwner(PASSWORD);
    const budget = getEnv().AUTH_MAX_ATTEMPTS_PER_WINDOW;
    for (let attempt = 0; attempt < budget; attempt += 1) {
      await loginWithPassword({ username: "owner", password: "wrong-password-here" }).catch(() => undefined);
    }
    await expect(loginWithPassword({ username: "owner", password: PASSWORD })).rejects.toMatchObject({
      code: "RATE_LIMITED",
    });
  });

  it("logout revokes the session server-side", async () => {
    await createOwner(PASSWORD);
    const session = await loginWithPassword({ username: "owner", password: PASSWORD });
    expect(await getSession()).not.toBeNull();
    await logout();
    expect(await getSession()).toBeNull();
    const row = await prisma.adminSession.findUnique({ where: { id: session.sessionId } });
    expect(row?.revokedAt).not.toBeNull();
  });
});

describe("console authentication boundary", () => {
  it("redirects anonymous dashboard requests to login", () => {
    const response = proxy(new NextRequest("https://vwray.example/devices"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/login");
  });

  it("does not accept a forged session cookie", async () => {
    jar.set("vwray_session", "forged-session-token");
    expect(await getSession()).toBeNull();
  });
});

describe("password change", () => {
  it("requires the current password and revokes every session", async () => {
    const { userId } = await createOwner(PASSWORD);
    await loginWithPassword({ username: "owner", password: PASSWORD });
    await expect(
      changeOwnPassword({ userId, currentPassword: "wrong-password-here", newPassword: "a-brand-new-password-1" }),
    ).rejects.toMatchObject({ message: "The current password is incorrect." });

    await changeOwnPassword({ userId, currentPassword: PASSWORD, newPassword: "a-brand-new-password-1" });
    expect(await getSession()).toBeNull();
    await loginWithPassword({ username: "owner", password: "a-brand-new-password-1" });
    expect((await getSession())?.user.id).toBe(userId);
  });

  it("refuses short new passwords", async () => {
    const { userId } = await createOwner(PASSWORD);
    await expect(
      changeOwnPassword({ userId, currentPassword: PASSWORD, newPassword: "short" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("lets an access-code-only account set its first password with a valid code", async () => {
    const { userId } = await createOwner(null);
    const code = "TEST-CODE-0001-ABCD";
    await prisma.accessCode.create({
      data: {
        label: "test",
        codeHint: "TEST-...-ABCD",
        codeHash: hashSecret(code.toUpperCase()),
        role: "OWNER",
        createdById: userId,
      },
    });
    await changeOwnPassword({ userId, currentAccessCode: code, newPassword: "first-password-set-ok-1" });
    await loginWithPassword({ username: "owner", password: "first-password-set-ok-1" });
    expect((await getSession())?.user.id).toBe(userId);
  });
});

describe("access codes (preserved bootstrap path)", () => {
  it("still signs in with a valid access code", async () => {
    await createOwner(null);
    const { createAccessCode } = await import("@/server/auth/access-codes");
    const { code } = await createAccessCode({
      label: "operator",
      role: "OWNER",
      expiresInDays: 30,
      maxUses: null,
      actorId: (await prisma.adminUser.findFirstOrThrow()).id,
      actorLabel: "owner",
    });
    const session = await loginWithAccessCode({ accessCode: code });
    expect(session.user.role).toBe("OWNER");
  });
});

describe("bootstrap", () => {
  it("generates a strong code when no DEFAULT_ACCESS_CODE is configured", async () => {
    const outcome = await ensureBootstrapOwner();
    expect(outcome.created).toBe(true);
    if (outcome.created) {
      expect(outcome.accessCode.length).toBeGreaterThanOrEqual(20);
      expect(outcome.accessCode).not.toBe("ADMIN9785");
    }
  });

  it("is idempotent and does not create a duplicate owner or access code", async () => {
    const first = await ensureBootstrapOwner();
    expect(first.created).toBe(true);

    const second = await ensureBootstrapOwner();
    expect(second.created).toBe(false);
    expect(await prisma.adminUser.count()).toBe(1);
    expect(await prisma.accessCode.count()).toBe(1);
  });

  it("bootstraps through the production CLI, preserves credentials on rerun, and supports password login", async () => {
    const runBootstrap = () =>
      execFileSync(
        "npm",
        ["run", "bootstrap"],
        {
          encoding: "utf8",
          env: { ...process.env, OWNER_PASSWORD: PASSWORD },
        },
      );

    const missingPassword = spawnSync("npm", ["run", "bootstrap"], {
      encoding: "utf8",
      env: { ...process.env, OWNER_PASSWORD: "" },
    });
    expect(missingPassword.status).toBe(1);
    expect(missingPassword.stderr).toContain("OWNER_PASSWORD must be configured");
    expect(await prisma.adminUser.count()).toBe(0);

    const firstOutput = runBootstrap();
    expect(firstOutput).toContain("Bootstrap complete for owner.");
    expect(firstOutput).not.toContain(PASSWORD);

    const secondOutput = runBootstrap();
    expect(secondOutput).toContain("Bootstrap skipped: an operator account already exists.");
    expect(secondOutput).not.toContain(PASSWORD);
    expect(await prisma.adminUser.count()).toBe(1);
    expect(await prisma.accessCode.count()).toBe(1);
    const statusResponse = await getAuthStatus(new Request("https://vwray.example/api/auth"));
    const statusPayload = await statusResponse.json();
    expect(statusPayload.data.needsBootstrap).toBe(false);

    await loginWithPassword({ username: "owner", password: PASSWORD });
    await expect(loginWithPassword({ username: "owner", password: "definitely-wrong-password" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });
});
