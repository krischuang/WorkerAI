-- AlterTable
ALTER TABLE "ExecutionLog" ADD COLUMN     "failureReason" TEXT,
ADD COLUMN     "retryNumber" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "lastFailReason" TEXT,
ADD COLUMN     "maxRetries" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryAfter" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;
