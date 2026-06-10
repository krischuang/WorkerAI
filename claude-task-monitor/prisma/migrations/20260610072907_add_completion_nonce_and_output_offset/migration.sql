-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "completionNonce" TEXT,
ADD COLUMN     "tmuxOutputOffset" INTEGER;
