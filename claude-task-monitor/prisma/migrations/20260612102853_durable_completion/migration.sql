-- Migration: durable_completion
-- Adds needs_review TaskStatus, runId on Task/ExecutionLog, cooldownUntil on Agent.
-- All changes are additive (nullable columns, new enum value) — no existing rows affected.
-- Pending/queued tasks continue to work: runId = null falls through to existing detection.

-- 1. Add needs_review to TaskStatus enum (irreversible in PostgreSQL — value can be added but not removed)
ALTER TYPE "TaskStatus" ADD VALUE IF NOT EXISTS 'needs_review';

-- 2. Add runId to Task (nullable — null means legacy task using tmux pane detection)
ALTER TABLE "Task" ADD COLUMN IF NOT EXISTS "runId" TEXT;

-- 3. Add runId to ExecutionLog (nullable — links to done-file on remote server)
ALTER TABLE "ExecutionLog" ADD COLUMN IF NOT EXISTS "runId" TEXT;

-- 4. Add cooldownUntil to Agent (nullable — poller skips dispatch until this timestamp passes)
ALTER TABLE "Agent" ADD COLUMN IF NOT EXISTS "cooldownUntil" TIMESTAMP(3);
