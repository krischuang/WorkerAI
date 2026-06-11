-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "autoRecovery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastRecoveryAt" TIMESTAMP(3),
ADD COLUMN     "maxRecoveryAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "autoRecovery" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastRecoveryAt" TIMESTAMP(3),
ADD COLUMN     "maxRecoveryAttempts" INTEGER NOT NULL DEFAULT 3,
ADD COLUMN     "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "RecoveryLog" (
    "id" TEXT NOT NULL,
    "serverId" TEXT,
    "agentId" TEXT,
    "triggeredBy" TEXT NOT NULL DEFAULT 'auto',
    "success" BOOLEAN NOT NULL,
    "command" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecoveryLog_serverId_createdAt_idx" ON "RecoveryLog"("serverId", "createdAt");

-- CreateIndex
CREATE INDEX "RecoveryLog_agentId_createdAt_idx" ON "RecoveryLog"("agentId", "createdAt");

-- AddForeignKey
ALTER TABLE "RecoveryLog" ADD CONSTRAINT "RecoveryLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryLog" ADD CONSTRAINT "RecoveryLog_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
