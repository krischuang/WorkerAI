-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('warning', 'error', 'critical');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('open', 'investigating', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "RepairTaskStatus" AS ENUM ('pending', 'assigned', 'in_progress', 'fixed', 'failed_validation', 'needs_human_review', 'failed');

-- CreateTable
CREATE TABLE "Incident" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "severity" "IncidentSeverity" NOT NULL,
    "affectedAgentId" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "rawError" TEXT,
    "contextJson" JSONB NOT NULL DEFAULT '{}',
    "status" "IncidentStatus" NOT NULL DEFAULT 'open',
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairTask" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "suggestedSteps" TEXT[],
    "status" "RepairTaskStatus" NOT NULL DEFAULT 'pending',
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'low',
    "assignedAgentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepairTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairAttempt" (
    "id" TEXT NOT NULL,
    "repairTaskId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "executedBy" TEXT,
    "logs" TEXT,
    "validationOutput" TEXT,
    "validationPassed" BOOLEAN,
    "changedFiles" TEXT[],
    "commitHash" TEXT,
    "status" TEXT NOT NULL DEFAULT 'running',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "RepairAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepairAuditLog" (
    "id" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "repairTaskId" TEXT NOT NULL,
    "assignedAgentId" TEXT,
    "status" TEXT NOT NULL,
    "validationResult" TEXT,
    "changedFiles" TEXT[],
    "commitHash" TEXT,
    "pushStatus" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepairAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Incident_status_idx" ON "Incident"("status");

-- CreateIndex
CREATE INDEX "Incident_affectedAgentId_idx" ON "Incident"("affectedAgentId");

-- CreateIndex
CREATE INDEX "Incident_source_status_idx" ON "Incident"("source", "status");

-- CreateIndex
CREATE INDEX "Incident_createdAt_idx" ON "Incident"("createdAt");

-- CreateIndex
CREATE INDEX "RepairTask_incidentId_idx" ON "RepairTask"("incidentId");

-- CreateIndex
CREATE INDEX "RepairTask_status_idx" ON "RepairTask"("status");

-- CreateIndex
CREATE INDEX "RepairTask_assignedAgentId_idx" ON "RepairTask"("assignedAgentId");

-- CreateIndex
CREATE INDEX "RepairAttempt_repairTaskId_idx" ON "RepairAttempt"("repairTaskId");

-- CreateIndex
CREATE INDEX "RepairAuditLog_incidentId_idx" ON "RepairAuditLog"("incidentId");

-- CreateIndex
CREATE INDEX "RepairAuditLog_repairTaskId_idx" ON "RepairAuditLog"("repairTaskId");

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_affectedAgentId_fkey" FOREIGN KEY ("affectedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairTask" ADD CONSTRAINT "RepairTask_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairTask" ADD CONSTRAINT "RepairTask_assignedAgentId_fkey" FOREIGN KEY ("assignedAgentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairAttempt" ADD CONSTRAINT "RepairAttempt_repairTaskId_fkey" FOREIGN KEY ("repairTaskId") REFERENCES "RepairTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepairAuditLog" ADD CONSTRAINT "RepairAuditLog_repairTaskId_fkey" FOREIGN KEY ("repairTaskId") REFERENCES "RepairTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
