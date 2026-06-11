-- CreateEnum
CREATE TYPE "DebtSeverity" AS ENUM ('low', 'medium', 'high', 'critical');

-- CreateEnum
CREATE TYPE "DebtCategory" AS ENUM ('architecture', 'testing', 'documentation', 'security', 'performance');

-- CreateEnum
CREATE TYPE "DebtStatus" AS ENUM ('open', 'acknowledged', 'in_progress', 'resolved', 'wont_fix');

-- CreateTable
CREATE TABLE "DebtItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "severity" "DebtSeverity" NOT NULL DEFAULT 'medium',
    "category" "DebtCategory" NOT NULL DEFAULT 'architecture',
    "status" "DebtStatus" NOT NULL DEFAULT 'open',
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DebtItem_projectId_status_idx" ON "DebtItem"("projectId", "status");

-- CreateIndex
CREATE INDEX "DebtItem_severity_idx" ON "DebtItem"("severity");

-- CreateIndex
CREATE INDEX "DebtItem_status_idx" ON "DebtItem"("status");

-- AddForeignKey
ALTER TABLE "DebtItem" ADD CONSTRAINT "DebtItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
