-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "lastProgressAt" TIMESTAMP(3),
ADD COLUMN     "stallDetectedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "SystemConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemConfig_pkey" PRIMARY KEY ("key")
);
