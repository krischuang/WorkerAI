-- CreateEnum
CREATE TYPE "ServerStatus" AS ENUM ('unknown', 'connected', 'failed');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('success', 'failed');

-- CreateTable
CREATE TABLE "Server" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "sshKeyPath" TEXT NOT NULL,
    "status" "ServerStatus" NOT NULL DEFAULT 'unknown',
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Server_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServerCommandLog" (
    "id" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL,
    "output" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ServerCommandLog_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "ServerCommandLog" ADD CONSTRAINT "ServerCommandLog_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE CASCADE ON UPDATE CASCADE;
