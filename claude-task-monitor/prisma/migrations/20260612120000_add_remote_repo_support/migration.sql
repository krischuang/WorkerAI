-- Migration: add_remote_repo_support
-- Adds WorkspaceStrategy enum and remote-first repository fields to Project and Task.
-- All changes are additive (new enum, nullable/defaulted columns) — no existing rows affected.

-- 1. Create WorkspaceStrategy enum
DO $$ BEGIN
  CREATE TYPE "WorkspaceStrategy" AS ENUM ('local_permanent', 'temporary_clone', 'remote_api');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 2. Add remote repository fields to Project
ALTER TABLE "Project"
  ADD COLUMN IF NOT EXISTS "repoUrl"           TEXT,
  ADD COLUMN IF NOT EXISTS "defaultBranch"     TEXT NOT NULL DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS "workspaceStrategy" "WorkspaceStrategy" NOT NULL DEFAULT 'local_permanent';

-- 3. Add temporary workspace directory path to Task
ALTER TABLE "Task"
  ADD COLUMN IF NOT EXISTS "workspaceDir" TEXT;
