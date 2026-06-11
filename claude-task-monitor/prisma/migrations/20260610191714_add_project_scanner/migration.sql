-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('running', 'completed', 'failed');

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "autoScanEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastScannedAt" TIMESTAMP(3),
ADD COLUMN     "scanFrequencyDays" INTEGER NOT NULL DEFAULT 7;

-- CreateTable
CREATE TABLE "ProjectScan" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "scanType" TEXT NOT NULL DEFAULT 'gap_analysis',
    "status" "ScanStatus" NOT NULL DEFAULT 'running',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "scannedTaskCount" INTEGER NOT NULL DEFAULT 0,
    "runOnServerId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectScan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProjectScan_projectId_createdAt_idx" ON "ProjectScan"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectScan_status_idx" ON "ProjectScan"("status");

-- AddForeignKey
ALTER TABLE "ProjectScan" ADD CONSTRAINT "ProjectScan_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
