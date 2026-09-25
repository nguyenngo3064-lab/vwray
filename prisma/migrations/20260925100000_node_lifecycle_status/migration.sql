-- Persist node lifecycle independently from derived heartbeat health.
CREATE TYPE "NodeStatus" AS ENUM ('REGISTERING', 'ONLINE', 'OFFLINE', 'DEGRADED', 'REVOKED');

ALTER TABLE "vpn_node" ADD COLUMN "status" "NodeStatus" NOT NULL DEFAULT 'REGISTERING';
CREATE INDEX "vpn_node_status_idx" ON "vpn_node"("status");

UPDATE "vpn_node"
SET "status" = CASE
  WHEN "health" = 'ONLINE' THEN 'ONLINE'::"NodeStatus"
  WHEN "health" = 'DEGRADED' THEN 'DEGRADED'::"NodeStatus"
  WHEN "health" = 'OFFLINE' THEN 'OFFLINE'::"NodeStatus"
  ELSE 'REGISTERING'::"NodeStatus"
END;