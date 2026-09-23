-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('OWNER', 'ADMIN', 'ANALYST', 'VIEWER');

-- CreateEnum
CREATE TYPE "AdminUserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'GATEWAY', 'API_KEY');

-- CreateEnum
CREATE TYPE "AuditResult" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('REAL', 'MOCK');

-- CreateEnum
CREATE TYPE "MeasurementKind" AS ENUM ('MEASURED', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "NodeHealthState" AS ENUM ('ONLINE', 'DEGRADED', 'OFFLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "NodeProtocol" AS ENUM ('WIREGUARD', 'XRAY_VLESS', 'XRAY_VMESS', 'XRAY_TROJAN', 'MOCK');

-- CreateEnum
CREATE TYPE "DeviceApprovalState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'BLOCKED');

-- CreateEnum
CREATE TYPE "DeviceConnectionStatus" AS ENUM ('ONLINE', 'OFFLINE', 'CONNECTING', 'QUOTA_EXCEEDED', 'REVOKED');

-- CreateEnum
CREATE TYPE "DeviceSecurityState" AS ENUM ('NORMAL', 'REVIEW', 'LOCKED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('WIREGUARD_KEYPAIR', 'WIREGUARD_PSK', 'XRAY_UUID', 'XRAY_SHORT_ID', 'TROJAN_PASSWORD');

-- CreateEnum
CREATE TYPE "ConfigStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TrafficDirection" AS ENUM ('UPLOAD', 'DOWNLOAD');

-- CreateEnum
CREATE TYPE "AggregateGranularity" AS ENUM ('MINUTE', 'HOUR', 'DAY', 'MONTH');

-- CreateEnum
CREATE TYPE "QuotaScope" AS ENUM ('SYSTEM', 'USER', 'DEVICE', 'CONFIG', 'NODE');

-- CreateEnum
CREATE TYPE "QuotaPeriod" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "QuotaResetPolicy" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "EnforcementState" AS ENUM ('ACTIVE', 'WARNED_80', 'WARNED_90', 'QUOTA_EXCEEDED', 'BLOCKED', 'REVOKED');

-- CreateEnum
CREATE TYPE "OptimizationProfileKey" AS ENUM ('BALANCED', 'DATA_SAVER', 'GAMING', 'VIDEO_SAVER', 'MAXIMUM_SAVING');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'WEEKLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "CostScope" AS ENUM ('SYSTEM', 'USER', 'DEVICE', 'NODE', 'CATEGORY');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('DRAFT', 'ISSUED', 'VOID');

-- CreateEnum
CREATE TYPE "SessionEndReason" AS ENUM ('NORMAL', 'REVOKED', 'QUOTA_EXCEEDED', 'GATEWAY_DISCONNECT', 'STALE', 'NODE_DRAINED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "AnomalyType" AS ENUM ('BANDWIDTH_SPIKE', 'UPLOAD_ANOMALY', 'EXCESSIVE_CONNECTIONS', 'AUTH_FAILURES', 'RAPID_QUOTA_CONSUMPTION', 'NODE_BEHAVIOUR', 'RECONNECT_LOOP');

-- CreateEnum
CREATE TYPE "AnomalyStatus" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "SettingCategory" AS ENUM ('GENERAL', 'AUTH', 'SECURITY', 'VPN', 'NODES', 'TRAFFIC', 'QUOTA', 'OPTIMIZATION', 'DNS', 'BILLING', 'RECEIPTS', 'NOTIFICATIONS', 'RETENTION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "RouteSelectionMode" AS ENUM ('MANUAL', 'AUTO');

-- CreateEnum
CREATE TYPE "DnsAction" AS ENUM ('ALLOW', 'BLOCK');

-- CreateEnum
CREATE TYPE "DnsListKind" AS ENUM ('BLOCKLIST', 'ALLOWLIST');

-- CreateTable
CREATE TABLE "admin_user" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "status" "AdminUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "passwordHash" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_code" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "role" "AdminRole" NOT NULL DEFAULT 'ADMIN',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "maxUses" INTEGER,

    CONSTRAINT "access_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfSecret" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "reason" TEXT,

    CONSTRAINT "admin_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_attempt" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "ip" TEXT,
    "success" BOOLEAN NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_node" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "provider" TEXT,
    "publicEndpoint" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "protocol" "NodeProtocol" NOT NULL,
    "health" "NodeHealthState" NOT NULL DEFAULT 'UNKNOWN',
    "agentTokenHash" TEXT NOT NULL,
    "agentTokenHint" TEXT NOT NULL,
    "adapterKey" TEXT NOT NULL,
    "version" TEXT,
    "agentVersion" TEXT,
    "cpuPercent" DOUBLE PRECISION,
    "ramPercent" DOUBLE PRECISION,
    "bandwidthMbps" DOUBLE PRECISION,
    "activeSessions" INTEGER NOT NULL DEFAULT 0,
    "maxSessions" INTEGER,
    "weight" INTEGER NOT NULL DEFAULT 100,
    "tags" TEXT[],
    "draining" BOOLEAN NOT NULL DEFAULT false,
    "maintenance" BOOLEAN NOT NULL DEFAULT false,
    "isRealGateway" BOOLEAN NOT NULL DEFAULT true,
    "lastHeartbeatAt" TIMESTAMP(3),
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "vpn_node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_health_sample" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpuPercent" DOUBLE PRECISION,
    "ramPercent" DOUBLE PRECISION,
    "bandwidthMbps" DOUBLE PRECISION,
    "activeSessions" INTEGER,
    "latencyMs" DOUBLE PRECISION,
    "packetLossPct" DOUBLE PRECISION,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',

    CONSTRAINT "node_health_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node_pool_policy" (
    "id" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "maxLatencyMs" DOUBLE PRECISION,
    "regionLabel" TEXT,
    "protocols" "NodeProtocol"[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_pool_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "publicSourceIp" TEXT,
    "observedSourceIps" TEXT[],
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "lastHandshakeAt" TIMESTAMP(3),
    "connectionStatus" "DeviceConnectionStatus" NOT NULL DEFAULT 'OFFLINE',
    "approvalState" "DeviceApprovalState" NOT NULL DEFAULT 'PENDING',
    "securityState" "DeviceSecurityState" NOT NULL DEFAULT 'NORMAL',
    "uploadBytes" BIGINT NOT NULL DEFAULT 0,
    "downloadBytes" BIGINT NOT NULL DEFAULT 0,
    "quotaExceededAt" TIMESTAMP(3),
    "blockedAt" TIMESTAMP(3),
    "blockedReason" TEXT,
    "ownerUserId" TEXT,
    "assignedNodeId" TEXT,
    "assignedConfigId" TEXT,
    "optimizationProfileId" TEXT,
    "approvalNote" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "latencyMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "packetLossPct" DOUBLE PRECISION,
    "qualityScore" DOUBLE PRECISION,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_credential" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "publicKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "secretSealed" TEXT,
    "keyRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "rotatedFromId" TEXT,
    "nodeId" TEXT,

    CONSTRAINT "device_credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" "NodeProtocol" NOT NULL,
    "deviceId" TEXT,
    "nodeId" TEXT,
    "status" "ConfigStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedReason" TEXT,
    "currentVersionId" TEXT,

    CONSTRAINT "vpn_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_version" (
    "id" TEXT NOT NULL,
    "configId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payloadSealed" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "changeNote" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "config_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vpn_session" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "configId" TEXT,
    "gatewaySessionId" TEXT NOT NULL,
    "sourceIp" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" "SessionEndReason",
    "bytesUp" BIGINT NOT NULL DEFAULT 0,
    "bytesDown" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" DOUBLE PRECISION,
    "jitterMs" DOUBLE PRECISION,
    "packetLossPct" DOUBLE PRECISION,
    "reconnectCount" INTEGER NOT NULL DEFAULT 0,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',

    CONSTRAINT "vpn_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota" (
    "id" TEXT NOT NULL,
    "scope" "QuotaScope" NOT NULL,
    "scopeRefId" TEXT,
    "label" TEXT NOT NULL,
    "limitBytes" BIGINT NOT NULL,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "graceBytes" BIGINT NOT NULL DEFAULT 0,
    "period" "QuotaPeriod" NOT NULL,
    "resetPolicy" "QuotaResetPolicy" NOT NULL DEFAULT 'MANUAL',
    "resetAt" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3),
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "warned80At" TIMESTAMP(3),
    "warned90At" TIMESTAMP(3),
    "exceededAt" TIMESTAMP(3),
    "lastEvaluatedAt" TIMESTAMP(3),
    "deviceId" TEXT,
    "nodeId" TEXT,
    "configId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gateway_policy_state" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "nodeId" TEXT,
    "state" "EnforcementState" NOT NULL,
    "reason" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "appliedAt" TIMESTAMP(3),
    "ackedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gateway_policy_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_sample" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "nodeId" TEXT NOT NULL,
    "deviceId" TEXT,
    "direction" "TrafficDirection" NOT NULL,
    "bytes" BIGINT NOT NULL,
    "bytesOptimized" BIGINT,
    "packets" INTEGER,
    "connections" INTEGER,
    "domainId" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',
    "agentId" TEXT,
    "ingestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_aggregate" (
    "id" TEXT NOT NULL,
    "granularity" "AggregateGranularity" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd" TIMESTAMP(3) NOT NULL,
    "nodeId" TEXT,
    "deviceId" TEXT,
    "userId" TEXT,
    "configId" TEXT,
    "domainId" TEXT,
    "category" TEXT,
    "direction" "TrafficDirection" NOT NULL,
    "bytes" BIGINT NOT NULL,
    "bytesOptimized" BIGINT,
    "packets" BIGINT,
    "connections" INTEGER,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "traffic_aggregate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_destination" (
    "id" TEXT NOT NULL,
    "hostname" TEXT,
    "ip" TEXT,
    "category" TEXT,
    "protocol" TEXT,
    "attribution" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "traffic_destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_list" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "DnsListKind" NOT NULL,
    "category" TEXT,
    "source" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "entryCount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dns_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_list_entry" (
    "id" TEXT NOT NULL,
    "listId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "scope" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dns_list_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_query_stat" (
    "id" TEXT NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "granularity" "AggregateGranularity" NOT NULL,
    "nodeId" TEXT,
    "deviceId" TEXT,
    "domainId" TEXT,
    "domainName" TEXT NOT NULL,
    "category" TEXT,
    "action" "DnsAction" NOT NULL,
    "count" BIGINT NOT NULL DEFAULT 0,
    "estimatedBytesSaved" BIGINT,
    "estimatedBytesKind" "MeasurementKind",
    "source" "DataSource" NOT NULL DEFAULT 'REAL',

    CONSTRAINT "dns_query_stat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_profile" (
    "id" TEXT NOT NULL,
    "key" "OptimizationProfileKey" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "builtin" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "dnsFilteringLevel" TEXT NOT NULL DEFAULT 'standard',
    "dnsBlocklistCategories" TEXT[],
    "compressionEnabled" BOOLEAN NOT NULL DEFAULT true,
    "mediaOptimization" BOOLEAN NOT NULL DEFAULT false,
    "latencyPriority" BOOLEAN NOT NULL DEFAULT false,
    "udpStability" BOOLEAN NOT NULL DEFAULT false,
    "lowQueueing" BOOLEAN NOT NULL DEFAULT false,
    "aggressiveFiltering" BOOLEAN NOT NULL DEFAULT false,
    "routingPolicy" TEXT NOT NULL DEFAULT 'default',
    "targetSavingMinPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "targetSavingMaxPct" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requiredCapabilities" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "optimization_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "optimization_record" (
    "id" TEXT NOT NULL,
    "granularity" "AggregateGranularity" NOT NULL,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "bucketEnd" TIMESTAMP(3) NOT NULL,
    "profileId" TEXT,
    "deviceId" TEXT,
    "nodeId" TEXT,
    "userId" TEXT,
    "category" TEXT,
    "originalBytes" BIGINT NOT NULL,
    "optimizedBytes" BIGINT NOT NULL,
    "savedBytes" BIGINT NOT NULL,
    "savingPct" DOUBLE PRECISION,
    "kind" "MeasurementKind" NOT NULL DEFAULT 'MEASURED',
    "estimationBasis" TEXT,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "optimization_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_config" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'default',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "baseFee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "pricePerGb" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "freeQuotaGb" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'MONTHLY',
    "periodStartDay" INTEGER NOT NULL DEFAULT 1,
    "providerLabel" TEXT NOT NULL DEFAULT 'VWRAY',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "billing_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cost_record" (
    "id" TEXT NOT NULL,
    "scope" "CostScope" NOT NULL,
    "scopeRefId" TEXT,
    "label" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rawBytes" BIGINT NOT NULL,
    "optimizedBytes" BIGINT NOT NULL,
    "savedBytes" BIGINT NOT NULL,
    "freeQuotaGb" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "billableGb" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "baseFee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "pricePerGb" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "computedCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "costWithoutOptimization" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "savedCost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "inputHash" TEXT NOT NULL,
    "source" "DataSource" NOT NULL DEFAULT 'REAL',
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cost_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" TEXT NOT NULL,
    "receiptNumber" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerRef" TEXT,
    "deviceId" TEXT,
    "configLabel" TEXT,
    "nodeLabel" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "rawBytes" BIGINT NOT NULL,
    "optimizedBytes" BIGINT NOT NULL,
    "savedBytes" BIGINT NOT NULL,
    "savingPct" DOUBLE PRECISION,
    "savingsKind" "MeasurementKind" NOT NULL,
    "pricePerGb" DECIMAL(18,4) NOT NULL,
    "baseFee" DECIMAL(18,4) NOT NULL,
    "freeQuotaGb" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "billableGb" DECIMAL(18,6) NOT NULL,
    "simulatedTotal" DECIMAL(18,4) NOT NULL,
    "currency" TEXT NOT NULL,
    "payloadCanonical" TEXT NOT NULL,
    "verificationHash" TEXT NOT NULL,
    "billingConfigId" TEXT,
    "costRecordId" TEXT,
    "stampEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stampText" TEXT,
    "providerLabel" TEXT NOT NULL DEFAULT 'VWRAY',
    "disclaimer" TEXT NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'ISSUED',
    "source" "DataSource" NOT NULL DEFAULT 'REAL',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generatedById" TEXT,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "resourceId" TEXT,
    "result" "AuditResult" NOT NULL,
    "sourceIp" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "category" "SettingCategory" NOT NULL,
    "value" JSONB NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "anomaly_event" (
    "id" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "AnomalyType" NOT NULL,
    "severity" "NotificationSeverity" NOT NULL,
    "nodeId" TEXT,
    "deviceId" TEXT,
    "userId" TEXT,
    "label" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "metrics" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "AnomalyStatus" NOT NULL DEFAULT 'OPEN',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "anomaly_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" "NotificationSeverity" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "resource" TEXT,
    "resourceId" TEXT,
    "readAt" TIMESTAMP(3),
    "webhookDeliveredAt" TIMESTAMP(3),
    "webhookStatus" TEXT,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secretSealed" TEXT,
    "events" TEXT[],
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastDeliveryAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "maintenance_run" (
    "id" TEXT NOT NULL,
    "job" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "deletedRows" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "detail" JSONB,

    CONSTRAINT "maintenance_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_username_key" ON "admin_user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admin_user_email_key" ON "admin_user"("email");

-- CreateIndex
CREATE INDEX "admin_user_status_idx" ON "admin_user"("status");

-- CreateIndex
CREATE INDEX "access_code_revokedAt_idx" ON "access_code"("revokedAt");

-- CreateIndex
CREATE INDEX "access_code_expiresAt_idx" ON "access_code"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_session_tokenHash_key" ON "admin_session"("tokenHash");

-- CreateIndex
CREATE INDEX "admin_session_userId_revokedAt_idx" ON "admin_session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "admin_session_expiresAt_idx" ON "admin_session"("expiresAt");

-- CreateIndex
CREATE INDEX "auth_attempt_identifier_createdAt_idx" ON "auth_attempt"("identifier", "createdAt");

-- CreateIndex
CREATE INDEX "auth_attempt_ip_createdAt_idx" ON "auth_attempt"("ip", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_prefix_key" ON "api_key"("prefix");

-- CreateIndex
CREATE INDEX "api_key_revokedAt_idx" ON "api_key"("revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_node_nodeId_key" ON "vpn_node"("nodeId");

-- CreateIndex
CREATE INDEX "vpn_node_health_idx" ON "vpn_node"("health");

-- CreateIndex
CREATE INDEX "vpn_node_lastHeartbeatAt_idx" ON "vpn_node"("lastHeartbeatAt");

-- CreateIndex
CREATE INDEX "vpn_node_draining_idx" ON "vpn_node"("draining");

-- CreateIndex
CREATE INDEX "node_health_sample_nodeId_sampledAt_idx" ON "node_health_sample"("nodeId", "sampledAt");

-- CreateIndex
CREATE UNIQUE INDEX "node_pool_policy_nodeId_key" ON "node_pool_policy"("nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "device_deviceId_key" ON "device"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "device_assignedConfigId_key" ON "device"("assignedConfigId");

-- CreateIndex
CREATE INDEX "device_approvalState_idx" ON "device"("approvalState");

-- CreateIndex
CREATE INDEX "device_connectionStatus_idx" ON "device"("connectionStatus");

-- CreateIndex
CREATE INDEX "device_lastSeenAt_idx" ON "device"("lastSeenAt");

-- CreateIndex
CREATE INDEX "device_assignedNodeId_idx" ON "device"("assignedNodeId");

-- CreateIndex
CREATE INDEX "device_ownerUserId_idx" ON "device"("ownerUserId");

-- CreateIndex
CREATE INDEX "device_credential_deviceId_revokedAt_idx" ON "device_credential"("deviceId", "revokedAt");

-- CreateIndex
CREATE INDEX "device_credential_fingerprint_idx" ON "device_credential"("fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_config_currentVersionId_key" ON "vpn_config"("currentVersionId");

-- CreateIndex
CREATE INDEX "vpn_config_deviceId_idx" ON "vpn_config"("deviceId");

-- CreateIndex
CREATE INDEX "vpn_config_nodeId_idx" ON "vpn_config"("nodeId");

-- CreateIndex
CREATE INDEX "vpn_config_status_idx" ON "vpn_config"("status");

-- CreateIndex
CREATE INDEX "config_version_configId_idx" ON "config_version"("configId");

-- CreateIndex
CREATE UNIQUE INDEX "config_version_configId_version_key" ON "config_version"("configId", "version");

-- CreateIndex
CREATE INDEX "vpn_session_deviceId_startedAt_idx" ON "vpn_session"("deviceId", "startedAt");

-- CreateIndex
CREATE INDEX "vpn_session_nodeId_startedAt_idx" ON "vpn_session"("nodeId", "startedAt");

-- CreateIndex
CREATE INDEX "vpn_session_endedAt_idx" ON "vpn_session"("endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "vpn_session_nodeId_gatewaySessionId_startedAt_key" ON "vpn_session"("nodeId", "gatewaySessionId", "startedAt");

-- CreateIndex
CREATE INDEX "quota_exceededAt_idx" ON "quota"("exceededAt");

-- CreateIndex
CREATE INDEX "quota_enabled_idx" ON "quota"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "quota_scope_scopeRefId_key" ON "quota"("scope", "scopeRefId");

-- CreateIndex
CREATE INDEX "gateway_policy_state_state_idx" ON "gateway_policy_state"("state");

-- CreateIndex
CREATE INDEX "gateway_policy_state_appliedAt_idx" ON "gateway_policy_state"("appliedAt");

-- CreateIndex
CREATE UNIQUE INDEX "gateway_policy_state_deviceId_nodeId_key" ON "gateway_policy_state"("deviceId", "nodeId");

-- CreateIndex
CREATE INDEX "traffic_sample_ts_idx" ON "traffic_sample"("ts");

-- CreateIndex
CREATE INDEX "traffic_sample_deviceId_ts_idx" ON "traffic_sample"("deviceId", "ts");

-- CreateIndex
CREATE INDEX "traffic_sample_nodeId_ts_idx" ON "traffic_sample"("nodeId", "ts");

-- CreateIndex
CREATE INDEX "traffic_sample_source_idx" ON "traffic_sample"("source");

-- CreateIndex
CREATE INDEX "traffic_aggregate_bucketStart_granularity_idx" ON "traffic_aggregate"("bucketStart", "granularity");

-- CreateIndex
CREATE INDEX "traffic_aggregate_deviceId_bucketStart_idx" ON "traffic_aggregate"("deviceId", "bucketStart");

-- CreateIndex
CREATE INDEX "traffic_aggregate_nodeId_bucketStart_idx" ON "traffic_aggregate"("nodeId", "bucketStart");

-- CreateIndex
CREATE INDEX "traffic_aggregate_userId_bucketStart_idx" ON "traffic_aggregate"("userId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_aggregate_granularity_bucketStart_nodeId_deviceId_u_key" ON "traffic_aggregate"("granularity", "bucketStart", "nodeId", "deviceId", "userId", "configId", "domainId", "category", "direction", "source");

-- CreateIndex
CREATE INDEX "traffic_destination_category_idx" ON "traffic_destination"("category");

-- CreateIndex
CREATE INDEX "traffic_destination_lastSeenAt_idx" ON "traffic_destination"("lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_destination_hostname_ip_key" ON "traffic_destination"("hostname", "ip");

-- CreateIndex
CREATE INDEX "dns_list_kind_enabled_idx" ON "dns_list"("kind", "enabled");

-- CreateIndex
CREATE INDEX "dns_list_entry_domain_idx" ON "dns_list_entry"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "dns_list_entry_listId_domain_scope_key" ON "dns_list_entry"("listId", "domain", "scope");

-- CreateIndex
CREATE INDEX "dns_query_stat_bucketStart_idx" ON "dns_query_stat"("bucketStart");

-- CreateIndex
CREATE INDEX "dns_query_stat_domainName_idx" ON "dns_query_stat"("domainName");

-- CreateIndex
CREATE INDEX "dns_query_stat_deviceId_bucketStart_idx" ON "dns_query_stat"("deviceId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "dns_query_stat_granularity_bucketStart_nodeId_deviceId_doma_key" ON "dns_query_stat"("granularity", "bucketStart", "nodeId", "deviceId", "domainName", "action", "source");

-- CreateIndex
CREATE UNIQUE INDEX "optimization_profile_key_key" ON "optimization_profile"("key");

-- CreateIndex
CREATE INDEX "optimization_profile_enabled_idx" ON "optimization_profile"("enabled");

-- CreateIndex
CREATE INDEX "optimization_record_bucketStart_idx" ON "optimization_record"("bucketStart");

-- CreateIndex
CREATE INDEX "optimization_record_deviceId_bucketStart_idx" ON "optimization_record"("deviceId", "bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "optimization_record_granularity_bucketStart_deviceId_nodeId_key" ON "optimization_record"("granularity", "bucketStart", "deviceId", "nodeId", "profileId", "category", "kind", "source");

-- CreateIndex
CREATE INDEX "billing_config_active_idx" ON "billing_config"("active");

-- CreateIndex
CREATE INDEX "cost_record_periodStart_idx" ON "cost_record"("periodStart");

-- CreateIndex
CREATE INDEX "cost_record_scope_scopeRefId_idx" ON "cost_record"("scope", "scopeRefId");

-- CreateIndex
CREATE UNIQUE INDEX "cost_record_scope_scopeRefId_periodStart_periodEnd_source_key" ON "cost_record"("scope", "scopeRefId", "periodStart", "periodEnd", "source");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_receiptNumber_key" ON "receipt"("receiptNumber");

-- CreateIndex
CREATE INDEX "receipt_generatedAt_idx" ON "receipt"("generatedAt");

-- CreateIndex
CREATE INDEX "receipt_customerRef_idx" ON "receipt"("customerRef");

-- CreateIndex
CREATE INDEX "receipt_verificationHash_idx" ON "receipt"("verificationHash");

-- CreateIndex
CREATE INDEX "audit_log_ts_idx" ON "audit_log"("ts");

-- CreateIndex
CREATE INDEX "audit_log_action_ts_idx" ON "audit_log"("action", "ts");

-- CreateIndex
CREATE INDEX "audit_log_resource_resourceId_idx" ON "audit_log"("resource", "resourceId");

-- CreateIndex
CREATE INDEX "audit_log_actorId_ts_idx" ON "audit_log"("actorId", "ts");

-- CreateIndex
CREATE INDEX "audit_log_result_idx" ON "audit_log"("result");

-- CreateIndex
CREATE INDEX "system_setting_category_idx" ON "system_setting"("category");

-- CreateIndex
CREATE INDEX "anomaly_event_detectedAt_idx" ON "anomaly_event"("detectedAt");

-- CreateIndex
CREATE INDEX "anomaly_event_status_idx" ON "anomaly_event"("status");

-- CreateIndex
CREATE INDEX "anomaly_event_type_detectedAt_idx" ON "anomaly_event"("type", "detectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "anomaly_event_dedupeKey_key" ON "anomaly_event"("dedupeKey");

-- CreateIndex
CREATE INDEX "notification_createdAt_idx" ON "notification"("createdAt");

-- CreateIndex
CREATE INDEX "notification_readAt_idx" ON "notification"("readAt");

-- CreateIndex
CREATE INDEX "notification_type_createdAt_idx" ON "notification"("type", "createdAt");

-- CreateIndex
CREATE INDEX "webhook_endpoint_enabled_idx" ON "webhook_endpoint"("enabled");

-- CreateIndex
CREATE INDEX "maintenance_run_job_startedAt_idx" ON "maintenance_run"("job", "startedAt");

-- AddForeignKey
ALTER TABLE "access_code" ADD CONSTRAINT "access_code_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_session" ADD CONSTRAINT "admin_session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "admin_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "admin_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_health_sample" ADD CONSTRAINT "node_health_sample_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node_pool_policy" ADD CONSTRAINT "node_pool_policy_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "admin_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_assignedNodeId_fkey" FOREIGN KEY ("assignedNodeId") REFERENCES "vpn_node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_assignedConfigId_fkey" FOREIGN KEY ("assignedConfigId") REFERENCES "vpn_config"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device" ADD CONSTRAINT "device_optimizationProfileId_fkey" FOREIGN KEY ("optimizationProfileId") REFERENCES "optimization_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_credential" ADD CONSTRAINT "device_credential_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_config" ADD CONSTRAINT "vpn_config_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_config" ADD CONSTRAINT "vpn_config_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_config" ADD CONSTRAINT "vpn_config_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "config_version"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "config_version" ADD CONSTRAINT "config_version_configId_fkey" FOREIGN KEY ("configId") REFERENCES "vpn_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_session" ADD CONSTRAINT "vpn_session_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_session" ADD CONSTRAINT "vpn_session_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vpn_session" ADD CONSTRAINT "vpn_session_configId_fkey" FOREIGN KEY ("configId") REFERENCES "vpn_config"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota" ADD CONSTRAINT "quota_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota" ADD CONSTRAINT "quota_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota" ADD CONSTRAINT "quota_configId_fkey" FOREIGN KEY ("configId") REFERENCES "vpn_config"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_policy_state" ADD CONSTRAINT "gateway_policy_state_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gateway_policy_state" ADD CONSTRAINT "gateway_policy_state_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_sample" ADD CONSTRAINT "traffic_sample_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_sample" ADD CONSTRAINT "traffic_sample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_sample" ADD CONSTRAINT "traffic_sample_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "traffic_destination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_aggregate" ADD CONSTRAINT "traffic_aggregate_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "vpn_node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_aggregate" ADD CONSTRAINT "traffic_aggregate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_aggregate" ADD CONSTRAINT "traffic_aggregate_configId_fkey" FOREIGN KEY ("configId") REFERENCES "vpn_config"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_aggregate" ADD CONSTRAINT "traffic_aggregate_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "traffic_destination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_list_entry" ADD CONSTRAINT "dns_list_entry_listId_fkey" FOREIGN KEY ("listId") REFERENCES "dns_list"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_query_stat" ADD CONSTRAINT "dns_query_stat_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_query_stat" ADD CONSTRAINT "dns_query_stat_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "traffic_destination"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_record" ADD CONSTRAINT "optimization_record_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "optimization_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "optimization_record" ADD CONSTRAINT "optimization_record_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt" ADD CONSTRAINT "receipt_billingConfigId_fkey" FOREIGN KEY ("billingConfigId") REFERENCES "billing_config"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "admin_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "anomaly_event" ADD CONSTRAINT "anomaly_event_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "device"("id") ON DELETE SET NULL ON UPDATE CASCADE;
