import "server-only";
import type { AdminRole } from "@prisma/client";
import { prisma } from "@/server/db/client";
import { errors } from "@/server/lib/errors";
import { hashSecret } from "@/server/lib/crypto";
import { generateAccessCode, hintFor } from "@/server/lib/ids";
import { record, userActor } from "@/server/audit";

/**
 * Access-code administration.
 *
 * Codes are the primary credential for a fresh installation, so they are handled
 * like passwords: shown once, stored as a scrypt hash, revocable, rotatable and
 * expirable. Only a display hint is ever queryable afterwards.
 */

export interface AccessCodeSummary {
  id: string;
  label: string;
  codeHint: string;
  role: AdminRole;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  useCount: number;
  maxUses: number | null;
  /** True when the code can still be used to log in. */
  usable: boolean;
}

export async function listAccessCodes(): Promise<AccessCodeSummary[]> {
  const now = Date.now();
  const codes = await prisma.accessCode.findMany({ orderBy: { createdAt: "desc" } });
  return codes.map((code) => ({
    id: code.id,
    label: code.label,
    codeHint: code.codeHint,
    role: code.role,
    createdAt: code.createdAt,
    expiresAt: code.expiresAt,
    revokedAt: code.revokedAt,
    lastUsedAt: code.lastUsedAt,
    useCount: code.useCount,
    maxUses: code.maxUses,
    usable:
      code.revokedAt === null &&
      (code.expiresAt === null || code.expiresAt.getTime() > now) &&
      (code.maxUses === null || code.useCount < code.maxUses),
  }));
}

/** Creates a code and returns the plaintext exactly once. */
export async function createAccessCode(input: {
  label: string;
  role: AdminRole;
  expiresInDays: number | null;
  maxUses: number | null;
  actorId: string;
  actorLabel: string;
}): Promise<{ code: string; id: string; hint: string; expiresAt: Date | null }> {
  const code = generateAccessCode();
  const expiresAt =
    input.expiresInDays === null
      ? null
      : new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);

  const created = await prisma.accessCode.create({
    data: {
      label: input.label,
      codeHint: hintFor(code),
      codeHash: hashSecret(code),
      role: input.role,
      createdById: input.actorId,
      expiresAt,
      maxUses: input.maxUses,
    },
  });

  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: "auth.access_code_created",
    resource: "access_code",
    resourceId: created.id,
    result: "SUCCESS",
    metadata: {
      label: input.label,
      role: input.role,
      expiresAt: expiresAt?.toISOString() ?? null,
      maxUses: input.maxUses,
    },
  });

  return { code, id: created.id, hint: created.codeHint, expiresAt };
}

export async function revokeAccessCode(input: {
  codeId: string;
  reason: string;
  actorId: string;
  actorLabel: string;
}): Promise<void> {
  const existing = await prisma.accessCode.findUnique({ where: { id: input.codeId } });
  if (!existing) throw errors.notFound("Access code");

  await prisma.accessCode.update({
    where: { id: input.codeId },
    data: { revokedAt: new Date(), revokedById: input.actorId },
  });

  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: "auth.access_code_revoked",
    resource: "access_code",
    resourceId: input.codeId,
    result: "SUCCESS",
    metadata: { reason: input.reason, codeHint: existing.codeHint },
  });
}

/**
 * Rotates a code: the previous one is revoked and a new one issued in one
 * transaction, so there is never a window where two codes share a label.
 */
export async function rotateAccessCode(input: {
  codeId: string;
  actorId: string;
  actorLabel: string;
}): Promise<{ code: string; id: string }> {
  const existing = await prisma.accessCode.findUnique({ where: { id: input.codeId } });
  if (!existing) throw errors.notFound("Access code");

  const code = generateAccessCode();

  const created = await prisma.$transaction(async (tx) => {
    await tx.accessCode.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), revokedById: input.actorId },
    });
    return tx.accessCode.create({
      data: {
        label: `${existing.label} (rotated)`,
        codeHint: hintFor(code),
        codeHash: hashSecret(code),
        role: existing.role,
        createdById: input.actorId,
        expiresAt: existing.expiresAt,
        maxUses: existing.maxUses,
      },
    });
  });

  await record({
    actor: userActor(input.actorId, input.actorLabel),
    action: "auth.access_code_rotated",
    resource: "access_code",
    resourceId: created.id,
    result: "SUCCESS",
    metadata: { replacedCodeId: existing.id },
  });

  return { code, id: created.id };
}
