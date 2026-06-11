-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "completedTasks" INTEGER,
ADD COLUMN     "completionPct" DOUBLE PRECISION,
ADD COLUMN     "estimatedCompletionAt" TIMESTAMP(3),
ADD COLUMN     "failedTasks" INTEGER,
ADD COLUMN     "pendingTasks" INTEGER,
ADD COLUMN     "progressUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "runningTasks" INTEGER,
ADD COLUMN     "totalTasks" INTEGER;
