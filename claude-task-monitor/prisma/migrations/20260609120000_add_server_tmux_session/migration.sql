-- AlterTable: add configurable tmux session name to Server
-- Existing servers default to "claude" (the original hardcoded session name).
ALTER TABLE "Server" ADD COLUMN "tmuxSession" TEXT NOT NULL DEFAULT 'claude';
