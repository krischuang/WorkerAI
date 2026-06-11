-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "healthScore" INTEGER,
ADD COLUMN     "lastHealthCheckAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "healthScore" INTEGER,
ADD COLUMN     "lastHealthCheckAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "WorkerHealth" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "agentId" TEXT,
    "healthScore" INTEGER NOT NULL,
    "sshOk" BOOLEAN NOT NULL,
    "tmuxOk" BOOLEAN NOT NULL,
    "claudeOk" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "errorMessage" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkerHealth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkerHealth_serverId_checkedAt_idx" ON "WorkerHealth"("serverId", "checkedAt");

-- CreateIndex
CREATE INDEX "WorkerHealth_agentId_checkedAt_idx" ON "WorkerHealth"("agentId", "checkedAt");

-- AddForeignKey
ALTER TABLE "WorkerHealth" ADD CONSTRAINT "WorkerHealth_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkerHealth" ADD CONSTRAINT "WorkerHealth_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
