-- DropIndex
DROP INDEX "ExecutionLog_outputSummary_trgm_idx";

-- DropIndex
DROP INDEX "Task_description_trgm_idx";

-- DropIndex
DROP INDEX "Task_title_trgm_idx";

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "tags" TEXT[];

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "requiredTags" TEXT[];
