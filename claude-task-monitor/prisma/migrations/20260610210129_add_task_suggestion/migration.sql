-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('pending_review', 'approved', 'rejected', 'converted');

-- CreateEnum
CREATE TYPE "SuggestionSourceType" AS ENUM ('scan', 'debt', 'review', 'manual');

-- CreateTable
CREATE TABLE "TaskSuggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sourceType" "SuggestionSourceType" NOT NULL DEFAULT 'manual',
    "sourceId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "priority" "Priority" NOT NULL DEFAULT 'P3',
    "taskType" "TaskType" NOT NULL DEFAULT 'coding',
    "estimatedCostLevel" "CostLevel" NOT NULL DEFAULT 'medium',
    "rationale" TEXT,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'pending_review',
    "convertedTaskId" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskSuggestion_projectId_status_idx" ON "TaskSuggestion"("projectId", "status");

-- CreateIndex
CREATE INDEX "TaskSuggestion_sourceType_sourceId_idx" ON "TaskSuggestion"("sourceType", "sourceId");

-- AddForeignKey
ALTER TABLE "TaskSuggestion" ADD CONSTRAINT "TaskSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
