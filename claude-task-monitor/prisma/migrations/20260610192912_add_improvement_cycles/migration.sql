-- CreateEnum
CREATE TYPE "CycleStatus" AS ENUM ('idle', 'scanning', 'detecting_debt', 'generating_suggestions', 'awaiting_approval', 'executing', 'reviewing', 'completed', 'cancelled', 'failed');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "cycleFrequencyDays" INTEGER NOT NULL DEFAULT 7,
ADD COLUMN     "improvementAutomationLevel" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastImprovementCycleAt" TIMESTAMP(3),
ADD COLUMN     "nextImprovementCycleAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ImprovementCycle" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "status" "CycleStatus" NOT NULL DEFAULT 'idle',
    "automationLevel" INTEGER NOT NULL DEFAULT 1,
    "scanId" TEXT,
    "tasksCreated" INTEGER NOT NULL DEFAULT 0,
    "tasksExecuted" INTEGER NOT NULL DEFAULT 0,
    "tasksReviewed" INTEGER NOT NULL DEFAULT 0,
    "suggestionsGenerated" INTEGER NOT NULL DEFAULT 0,
    "suggestionsApproved" INTEGER NOT NULL DEFAULT 0,
    "cycleError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "nextCycleAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImprovementCycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImprovementCycle_projectId_createdAt_idx" ON "ImprovementCycle"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ImprovementCycle_status_idx" ON "ImprovementCycle"("status");

-- AddForeignKey
ALTER TABLE "ImprovementCycle" ADD CONSTRAINT "ImprovementCycle_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
