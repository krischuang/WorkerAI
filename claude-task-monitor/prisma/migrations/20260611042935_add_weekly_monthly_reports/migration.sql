-- CreateTable
CREATE TABLE "WeeklyReport" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "runningCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "retriedCount" INTEGER NOT NULL DEFAULT 0,
    "timedOutCount" INTEGER NOT NULL DEFAULT 0,
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "avgExecutionMinutes" DOUBLE PRECISION,
    "activeServerCount" INTEGER NOT NULL DEFAULT 0,
    "activeAgentCount" INTEGER NOT NULL DEFAULT 0,
    "agentUtilisation" JSONB NOT NULL DEFAULT '{}',
    "topCompletedTasks" JSONB NOT NULL DEFAULT '[]',
    "generatedBy" TEXT NOT NULL DEFAULT 'manual',
    "reportText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyReport" (
    "id" TEXT NOT NULL,
    "monthStart" TIMESTAMP(3) NOT NULL,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "runningCount" INTEGER NOT NULL DEFAULT 0,
    "pendingCount" INTEGER NOT NULL DEFAULT 0,
    "queuedCount" INTEGER NOT NULL DEFAULT 0,
    "retriedCount" INTEGER NOT NULL DEFAULT 0,
    "timedOutCount" INTEGER NOT NULL DEFAULT 0,
    "recoveryCount" INTEGER NOT NULL DEFAULT 0,
    "avgExecutionMinutes" DOUBLE PRECISION,
    "activeServerCount" INTEGER NOT NULL DEFAULT 0,
    "activeAgentCount" INTEGER NOT NULL DEFAULT 0,
    "agentUtilisation" JSONB NOT NULL DEFAULT '{}',
    "topCompletedTasks" JSONB NOT NULL DEFAULT '[]',
    "generatedBy" TEXT NOT NULL DEFAULT 'manual',
    "reportText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WeeklyReport_weekStart_idx" ON "WeeklyReport"("weekStart");

-- CreateIndex
CREATE INDEX "MonthlyReport_monthStart_idx" ON "MonthlyReport"("monthStart");
