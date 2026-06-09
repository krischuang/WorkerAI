-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('idle', 'running', 'offline', 'error');

-- CreateTable
CREATE TABLE "Agent" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "workDir" TEXT NOT NULL,
    "tmuxSession" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'offline',
    "claudePermissionMode" "ClaudePermissionMode" NOT NULL DEFAULT 'workspace_write',
    "claudeSessionPct" DOUBLE PRECISION,
    "claudeSessionResets" TEXT,
    "claudeSessionResetsAt" TIMESTAMP(3),
    "claudeWeekPct" DOUBLE PRECISION,
    "claudeWeekResets" TEXT,
    "claudeWeekResetsAt" TIMESTAMP(3),
    "claudeUsageRaw" TEXT,
    "claudeUsageFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Agent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Agent_serverId_slug_key" ON "Agent"("serverId", "slug");

-- AddForeignKey
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN "agentId" TEXT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
