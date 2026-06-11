-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "autoPauseEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedDueToUsage" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "autoPauseEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "pausedDueToUsage" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "ScheduledResume" (
    "id" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "resumeAt" TIMESTAMP(3) NOT NULL,
    "triggered" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledResume_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledResume_resumeAt_triggered_idx" ON "ScheduledResume"("resumeAt", "triggered");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledResume_resourceType_resourceId_key" ON "ScheduledResume"("resourceType", "resourceId");
