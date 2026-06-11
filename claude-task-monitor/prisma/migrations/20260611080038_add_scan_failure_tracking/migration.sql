-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "autoImprovementPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scanFailureCount" INTEGER NOT NULL DEFAULT 0;
