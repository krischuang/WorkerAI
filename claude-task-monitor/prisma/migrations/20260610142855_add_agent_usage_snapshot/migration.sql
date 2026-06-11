-- DropIndex
DROP INDEX "ExecutionLog_searchVector_gin_idx";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "claudeLastRefreshStatus" TEXT,
ADD COLUMN     "claudeUsageCreditsEnabled" BOOLEAN;

-- CreateTable
CREATE TABLE "AgentUsageSnapshot" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "usagePercent" DOUBLE PRECISION,
    "resetTime" TEXT,
    "resetAt" TIMESTAMP(3),
    "usageCreditsEnabled" BOOLEAN,
    "captureStatus" TEXT NOT NULL DEFAULT 'unknown',
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rawOutput" TEXT,
    "cleanedOutput" TEXT,

    CONSTRAINT "AgentUsageSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentUsageSnapshot_agentId_capturedAt_idx" ON "AgentUsageSnapshot"("agentId", "capturedAt");

-- AddForeignKey
ALTER TABLE "AgentUsageSnapshot" ADD CONSTRAINT "AgentUsageSnapshot_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
