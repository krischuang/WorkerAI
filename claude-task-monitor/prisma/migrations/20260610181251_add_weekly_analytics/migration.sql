-- CreateTable
CREATE TABLE "WeeklyAnalytics" (
    "id" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "weekEnd" TIMESTAMP(3) NOT NULL,
    "tasksCompleted" INTEGER NOT NULL DEFAULT 0,
    "tasksFailed" INTEGER NOT NULL DEFAULT 0,
    "tasksRetried" INTEGER NOT NULL DEFAULT 0,
    "tasksTimedOut" INTEGER NOT NULL DEFAULT 0,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "reviewsRun" INTEGER NOT NULL DEFAULT 0,
    "reviewsPassed" INTEGER NOT NULL DEFAULT 0,
    "reviewsFailed" INTEGER NOT NULL DEFAULT 0,
    "avgExecutionMinutes" DOUBLE PRECISION,
    "p50ExecutionMinutes" DOUBLE PRECISION,
    "p95ExecutionMinutes" DOUBLE PRECISION,
    "workerRecoveries" INTEGER NOT NULL DEFAULT 0,
    "dispatchFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WeeklyAnalytics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WeeklyAnalytics_weekStart_key" ON "WeeklyAnalytics"("weekStart");

-- CreateIndex
CREATE INDEX "WeeklyAnalytics_weekStart_idx" ON "WeeklyAnalytics"("weekStart");
