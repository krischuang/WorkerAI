-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "claudeSessionPct" DOUBLE PRECISION,
ADD COLUMN     "claudeSessionResets" TEXT,
ADD COLUMN     "claudeUsageFetchedAt" TIMESTAMP(3),
ADD COLUMN     "claudeUsageRaw" TEXT,
ADD COLUMN     "claudeWeekPct" DOUBLE PRECISION,
ADD COLUMN     "claudeWeekResets" TEXT;
