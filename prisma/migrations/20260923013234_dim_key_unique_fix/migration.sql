-- DropIndex
DROP INDEX "dns_query_stat_granularity_bucketStart_nodeId_deviceId_doma_key";

-- DropIndex
DROP INDEX "optimization_record_granularity_bucketStart_deviceId_nodeId_key";

-- DropIndex
DROP INDEX "traffic_aggregate_granularity_bucketStart_nodeId_deviceId_u_key";

-- AlterTable
ALTER TABLE "dns_query_stat" ADD COLUMN     "dimKey" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "optimization_record" ADD COLUMN     "dimKey" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "traffic_aggregate" ADD COLUMN     "dimKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "dns_query_stat_granularity_bucketStart_dimKey_action_source_key" ON "dns_query_stat"("granularity", "bucketStart", "dimKey", "action", "source");

-- CreateIndex
CREATE UNIQUE INDEX "optimization_record_granularity_bucketStart_dimKey_kind_sou_key" ON "optimization_record"("granularity", "bucketStart", "dimKey", "kind", "source");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_aggregate_granularity_bucketStart_dimKey_direction__key" ON "traffic_aggregate"("granularity", "bucketStart", "dimKey", "direction", "source");

