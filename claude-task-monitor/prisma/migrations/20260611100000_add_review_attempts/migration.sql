-- Add failed variant to ReviewStatus enum
ALTER TYPE "ReviewStatus" ADD VALUE 'failed';

-- Add reviewAttempts counter to Task
ALTER TABLE "Task" ADD COLUMN "reviewAttempts" INTEGER NOT NULL DEFAULT 0;
