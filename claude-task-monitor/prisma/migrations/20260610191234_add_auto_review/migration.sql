-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'running', 'done', 'incomplete', 'skipped');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "autoReviewEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "autoReviewEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewCompletedAt" TIMESTAMP(3),
ADD COLUMN     "reviewScheduledAt" TIMESTAMP(3),
ADD COLUMN     "reviewStartedAt" TIMESTAMP(3),
ADD COLUMN     "reviewStatus" "ReviewStatus",
ADD COLUMN     "reviewVerdictNotes" TEXT;

-- CreateIndex
CREATE INDEX "Task_reviewStatus_idx" ON "Task"("reviewStatus");
