-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "diskTotalBytes" BIGINT,
ADD COLUMN     "diskUsedBytes" BIGINT;

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "diskTotalBytes" BIGINT,
ADD COLUMN     "diskUsedBytes" BIGINT;
