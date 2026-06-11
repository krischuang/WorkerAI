-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "defaultTaskTimeoutMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "defaultTaskTimeoutMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "timeoutMinutes" INTEGER;
