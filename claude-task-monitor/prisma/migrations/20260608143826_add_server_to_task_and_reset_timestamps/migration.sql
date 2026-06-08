-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "claudeSessionResetsAt" TIMESTAMP(3),
ADD COLUMN     "claudeWeekResetsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "serverId" TEXT;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_serverId_fkey" FOREIGN KEY ("serverId") REFERENCES "Server"("id") ON DELETE SET NULL ON UPDATE CASCADE;
