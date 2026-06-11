-- AlterTable
ALTER TABLE "ExecutionLog" ADD COLUMN     "actualCostUsd" DOUBLE PRECISION,
ADD COLUMN     "tokenCount" INTEGER,
ADD COLUMN     "usageSnapshotPct" DOUBLE PRECISION;
