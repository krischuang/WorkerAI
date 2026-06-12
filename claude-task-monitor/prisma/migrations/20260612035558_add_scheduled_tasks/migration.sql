-- CreateTable
CREATE TABLE "ScheduledTask" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "cronSchedule" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'P3',
    "taskType" "TaskType" NOT NULL DEFAULT 'coding',
    "estimatedCostLevel" "CostLevel" NOT NULL DEFAULT 'medium',
    "timeoutMinutes" INTEGER,
    "maxRetries" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledTask_projectId_idx" ON "ScheduledTask"("projectId");

-- CreateIndex
CREATE INDEX "ScheduledTask_nextRunAt_enabled_idx" ON "ScheduledTask"("nextRunAt", "enabled");

-- AddForeignKey
ALTER TABLE "ScheduledTask" ADD CONSTRAINT "ScheduledTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
