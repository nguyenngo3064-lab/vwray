-- CreateEnum
CREATE TYPE "NodeApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "WireGuardState" AS ENUM ('UNKNOWN', 'READY', 'DOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AutomationJobKind" ADD VALUE 'RETENTION_CONNECTION_EVENTS';
ALTER TYPE "AutomationJobKind" ADD VALUE 'RETENTION_POLICY_EXECUTIONS';
ALTER TYPE "AutomationJobKind" ADD VALUE 'RETENTION_AUTOMATION_RUNS';

-- AlterTable
ALTER TABLE "vpn_node" ADD COLUMN     "approvalState" "NodeApprovalState" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "wireguardState" "WireGuardState" NOT NULL DEFAULT 'UNKNOWN',
ADD COLUMN     "wireguardStateAt" TIMESTAMP(3),
ADD COLUMN     "wireguardStateReason" TEXT;

-- Compatibility backfill: every node that already exists was operational before
-- this migration, so it keeps working. ONLY new registrations start as PENDING.
-- Rollback note: dropping these columns reverts the schema; this UPDATE is a
-- no-op on rollback because the column disappears with it.
UPDATE "vpn_node" SET "approvalState" = 'APPROVED';

-- CreateIndex
CREATE INDEX "vpn_node_approvalState_idx" ON "vpn_node"("approvalState");
