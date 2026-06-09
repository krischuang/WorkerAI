-- CreateEnum
CREATE TYPE "ClaudePermissionMode" AS ENUM ('read_only', 'workspace_write', 'full_autonomous');

-- AlterTable
ALTER TABLE "Server" ADD COLUMN     "claudePermissionMode" "ClaudePermissionMode" NOT NULL DEFAULT 'workspace_write';
