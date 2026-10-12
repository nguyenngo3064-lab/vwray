-- Additive, backwards compatible: existing rows keep NULL (no allocated tunnel
-- address was tracked before), and PostgreSQL treats NULLs as distinct in unique
-- indexes, so existing data cannot break this migration.

-- AlterTable
ALTER TABLE "device_credential" ADD COLUMN "tunnelAddress" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "device_credential_tunnelAddress_key" ON "device_credential"("tunnelAddress");
