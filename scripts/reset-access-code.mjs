import { randomBytes, scryptSync } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("Access-code reset failed: DATABASE_URL is not set.");
  process.exit(1);
}

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const alphabetSize = alphabet.length;
const maxAcceptedByte = 256 - (256 % alphabetSize);
const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function generateAccessCode() {
  const characters = [];
  while (characters.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte >= maxAcceptedByte) continue;
      characters.push(alphabet[byte % alphabetSize]);
      if (characters.length === 16) break;
    }
  }

  let code = "";
  for (const character of characters) code += character;
  return code.match(/.{1,4}/g).join("-");
}

function hashSecret(value) {
  const salt = randomBytes(16);
  const derived = scryptSync(value.normalize("NFKC"), salt, 32, scryptOptions);
  return [
    "scrypt",
    scryptOptions.N,
    scryptOptions.r,
    scryptOptions.p,
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

function codeHint(value) {
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

let prisma;
try {
  prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });

  const accessCode = generateAccessCode();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('vwray:admin:reset-access-code'))`;

    const owner = await tx.adminUser.findFirst({
      where: { role: "OWNER" },
      orderBy: { createdAt: "asc" },
      select: { id: true, username: true, status: true },
    });
    if (!owner) throw new Error("No owner account exists. Run bootstrap first.");
    if (owner.status !== "ACTIVE") throw new Error("The owner account is not active.");

    const now = new Date();
    await tx.accessCode.updateMany({
      where: { createdById: owner.id, revokedAt: null },
      data: { revokedAt: now, revokedById: owner.id },
    });

    const created = await tx.accessCode.create({
      data: {
        label: "Production access code reset",
        codeHint: codeHint(accessCode),
        codeHash: hashSecret(accessCode),
        role: "OWNER",
        createdById: owner.id,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    const revokedSessions = await tx.adminSession.updateMany({
      where: { userId: owner.id, revokedAt: null },
      data: { revokedAt: now, reason: "access_code_reset", revokedById: owner.id },
    });

    return { username: owner.username, accessCode, codeId: created.id, revokedSessions: revokedSessions.count };
  });

  console.log(`Access code for ${result.username}: ${result.accessCode}`);
} catch (error) {
  const message = error instanceof Error && /^No owner account exists|^The owner account is not active/.test(error.message)
    ? error.message
    : "The database operation could not be completed.";
  console.error(`Access-code reset failed: ${message}`);
  process.exitCode = 1;
} finally {
  if (prisma) await prisma.$disconnect();
}