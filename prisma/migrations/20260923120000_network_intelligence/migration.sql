-- CreateEnum
CREATE TYPE "PolicyStatus" AS ENUM ('ENABLED', 'DISABLED');

-- CreateEnum
CREATE TYPE "PolicyMetric" AS ENUM ('QUOTA_PERCENT', 'QUOTA_USED_BYTES', 'DEVICE_UPLOAD_BYTES_PER_HOUR', 'DEVICE_DOWNLOAD_BYTES_PER_HOUR', 'TRAFFIC_SPIKE_FACTOR', 'DEVICE_CONNECTIONS', 'DEVICE_RECONNECTS', 'AUTH_FAILURES', 'NODE_CPU_PERCENT', 'NODE_RAM_PERCENT', 'NODE_PACKET_LOSS_PCT', 'NODE_LATENCY_MS', 'NODE_ACTIVE_SESSIONS', 'NODE_SESSION_HEADROOM_PERCENT', 'NODE_ONLINE', 'BUDGET_PERCENT', 'DEVICE_QUOTA_EXCEEDED', 'DEVICE_BLOCKED');

-- CreateEnum
CREATE TYPE "PolicyOperator" AS ENUM ('GTE', 'GT', 'LTE', 'LT', 'EQ', 'NEQ');

-- CreateEnum
CREATE TYPE "PolicyActionKey" AS ENUM ('NOTIFY', 'QUOTA_WARNING', 'DISCONNECT_SESSION', 'BLOCK_DEVICE_RECONNECT', 'MARK_NODE_DEGRADED', 'LOWER_NODE_ROUTING_PRIORITY', 'STOP_NEW_ASSIGNMENTS', 'CREATE_ANOMALY_EVENT', 'APPLY_OPTIMIZATION_PROFILE', 'DRAIN_NODE', 'SET_DEVICE_SECURITY_REVIEW', 'REQUEST_REPORT');

-- CreateEnum
CREATE TYPE "PolicyTargetKind" AS ENUM ('DEVICE', 'USER', 'NODE', 'CONFIG', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PolicyExecutionResult" AS ENUM ('APPLIED', 'NO_OP', 'COOLDOWN', 'SUPPRESSED', 'UNMEASURABLE', 'NO_MATCH', 'FAILED');

-- CreateEnum
CREATE TYPE "AutomationJobKind" AS ENUM ('QUOTA_PERIOD_RESET', 'TRAFFIC_AGGREGATE_ROLLUP', 'NODE_HEALTH_CHECK', 'ANOMALY_SWEEP', 'POLICY_EVALUATION', 'EXPIRED_CREDENTIAL_CLEANUP', 'EXPIRED_CONFIG_CLEANUP', 'RETENTION_TRAFFIC_SAMPLES', 'RETENTION_AUDIT_LOGS', 'RETENTION_NODE_HEALTH', 'RETENTION_DNS_STATS', 'BILLING_PERIOD_ROLLOVER', 'REPORT_GENERATION', 'RECEIPT_ISSUE');

-- CreateEnum
CREATE TYPE "AutomationRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ConnectionEventType" AS ENUM ('DEVICE_REGISTERED', 'DEVICE_APPROVED', 'DEVICE_REJECTED', 'DEVICE_BLOCKED', 'DEVICE_UNBLOCKED', 'DEVICE_CONNECTED', 'DEVICE_DISCONNECTED', 'DEVICE_UPDATED', 'NODE_CHANGED', 'NODE_HEALTH_CHANGED', 'NODE_DRAIN_STARTED', 'NODE_DRAIN_COMPLETED', 'NODE_MAINTENANCE_STARTED', 'NODE_MAINTENANCE_ENDED', 'CONFIG_CREATED', 'CONFIG_REVOKED', 'CONFIG_ROLLED_BACK', 'CREDENTIAL_CREATED', 'CREDENTIAL_ROTATED', 'CREDENTIAL_REVOKED', 'SESSION_STARTED', 'SESSION_ENDED', 'SESSION_REVOKED', 'QUOTA_WARNING', 'QUOTA_EXCEEDED', 'QUOTA_RESET', 'QUOTA_CHANGED', 'OPTIMIZATION_ENABLED', 'OPTIMIZATION_CHANGED', 'POLICY_TRIGGERED', 'AUTOMATION_RUN', 'ANOMALY_DETECTED', 'SECURITY_EVENT', 'BUDGET_THRESHOLD', 'RECEIPT_CREATED', 'REPORT_GENERATED');

-- CreateEnum
CREATE TYPE "TimelineActor" AS ENUM ('USER', 'SYSTEM', 'GATEWAY', 'POLICY', 'AUTOMATION');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NodeHealthState" ADD VALUE 'DRAINING';
ALTER TYPE "NodeHealthState" ADD VALUE 'MAINTENANCE';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationSeverity" ADD VALUE 'LOW';
ALTER TYPE "NotificationSeverity" ADD VALUE 'MEDIUM';
ALTER TYPE "NotificationSeverity" ADD VALUE 'HIGH';

-- CreateTable
CREATE TABLE "policy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "PolicyStatus" NOT NULL DEFAULT 'ENABLED',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "targetKind" "PolicyTargetKind" NOT NULL DEFAULT 'DEVICE',
    "condition" JSONB NOT NULL,
    "action" JSONB NOT NULL,
    "cooldownSeconds" INTEGER NOT NULL DEFAULT 600,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "overrideUntil" TIMESTAMP(3),
    "overrideById" TEXT,
    "overrideLabel" TEXT,
    "overrideReason" TEXT,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy_execution" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" "PolicyExecutionResult" NOT NULL,
    "targetKind" "PolicyTargetKind" NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "metric" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "observed" DOUBLE PRECISION,
    "threshold" DOUBLE PRECISION,
    "actionKey" "PolicyActionKey",
    "actionPayload" JSONB,
    "evidence" JSONB,
    "message" TEXT NOT NULL,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "suppressionReason" TEXT,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "dedupeKey" TEXT,

    CONSTRAINT "policy_execution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_job" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "AutomationJobKind" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "intervalSeconds" INTEGER NOT NULL DEFAULT 3600,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "lastRunAt" TIMESTAMP(3),
    "lastStatus" "AutomationRunStatus",
    "lastSummary" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "config" JSONB,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "automation_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_run" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'RUNNING',
    "summary" TEXT,
    "affectedCount" INTEGER NOT NULL DEFAULT 0,
    "detail" JSONB,
    "error" TEXT,

    CONSTRAINT "automation_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "CostScope" NOT NULL DEFAULT 'SYSTEM',
    "scopeRefId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "amountLimit" DECIMAL(18,4) NOT NULL,
    "period" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "periodStartDay" INTEGER NOT NULL DEFAULT 1,
    "periodStart" TIMESTAMP(3),
    "periodEnd" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "warnedAt50" TIMESTAMP(3),
    "warnedAt75" TIMESTAMP(3),
    "warnedAt90" TIMESTAMP(3),
    "warnedAt100" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_event" (
    "id" TEXT NOT NULL,
    "budgetId" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "thresholdPct" INTEGER NOT NULL,
    "observedPct" DOUBLE PRECISION NOT NULL,
    "spentAmount" DECIMAL(18,4) NOT NULL,
    "limitAmount" DECIMAL(18,4) NOT NULL,
    "projectedAmount" DECIMAL(18,4),
    "severity" "NotificationSeverity" NOT NULL,
    "evidence" JSONB,
    "dedupeKey" TEXT,

    CONSTRAINT "budget_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connection_event" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "ConnectionEventType" NOT NULL,
    "deviceId" TEXT,
    "userId" TEXT,
    "nodeId" TEXT,
    "sessionId" TEXT,
    "bytesUp" BIGINT,
    "bytesDown" BIGINT,
    "reason" TEXT,
    "actor" "TimelineActor" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "actorLabel" TEXT,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "metadata" JSONB,
    "dedupeKey" TEXT,
    "repeatCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "connection_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "policy_status_priority_idx" ON "policy"("status", "priority");

-- CreateIndex
CREATE INDEX "policy_targetKind_idx" ON "policy"("targetKind");

-- CreateIndex
CREATE INDEX "policy_execution_policyId_evaluatedAt_idx" ON "policy_execution"("policyId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "policy_execution_targetId_evaluatedAt_idx" ON "policy_execution"("targetId", "evaluatedAt");

-- CreateIndex
CREATE INDEX "policy_execution_evaluatedAt_idx" ON "policy_execution"("evaluatedAt");

-- CreateIndex
CREATE INDEX "policy_execution_result_idx" ON "policy_execution"("result");

-- CreateIndex
CREATE UNIQUE INDEX "policy_execution_dedupeKey_key" ON "policy_execution"("dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "automation_job_name_key" ON "automation_job"("name");

-- CreateIndex
CREATE INDEX "automation_job_enabled_nextRunAt_idx" ON "automation_job"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "automation_job_kind_idx" ON "automation_job"("kind");

-- CreateIndex
CREATE INDEX "automation_run_jobId_startedAt_idx" ON "automation_run"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "automation_run_status_startedAt_idx" ON "automation_run"("status", "startedAt");

-- CreateIndex
CREATE INDEX "budget_enabled_idx" ON "budget"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "budget_scope_scopeRefId_name_key" ON "budget"("scope", "scopeRefId", "name");

-- CreateIndex
CREATE INDEX "budget_event_budgetId_raisedAt_idx" ON "budget_event"("budgetId", "raisedAt");

-- CreateIndex
CREATE UNIQUE INDEX "budget_event_dedupeKey_key" ON "budget_event"("dedupeKey");

-- CreateIndex
CREATE INDEX "connection_event_deviceId_ts_idx" ON "connection_event"("deviceId", "ts");

-- CreateIndex
CREATE INDEX "connection_event_nodeId_ts_idx" ON "connection_event"("nodeId", "ts");

-- CreateIndex
CREATE INDEX "connection_event_type_ts_idx" ON "connection_event"("type", "ts");

-- CreateIndex
CREATE INDEX "connection_event_ts_idx" ON "connection_event"("ts");

-- CreateIndex
CREATE INDEX "connection_event_userId_ts_idx" ON "connection_event"("userId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "connection_event_dedupeKey_key" ON "connection_event"("dedupeKey");

-- AddForeignKey
ALTER TABLE "policy_execution" ADD CONSTRAINT "policy_execution_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "policy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_run" ADD CONSTRAINT "automation_run_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "automation_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_event" ADD CONSTRAINT "budget_event_budgetId_fkey" FOREIGN KEY ("budgetId") REFERENCES "budget"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_event" ADD CONSTRAINT "connection_event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connection_event" ADD CONSTRAINT "connection_event_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

