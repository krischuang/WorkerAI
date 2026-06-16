-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('low', 'medium', 'high');

-- CreateEnum
CREATE TYPE "ValidationStatus" AS ENUM ('passed', 'failed', 'missing');

-- CreateEnum
CREATE TYPE "ParserConfidence" AS ENUM ('high', 'medium', 'low', 'failed');

-- CreateEnum
CREATE TYPE "UsageCaptureSource" AS ENUM ('tmux_capture', 'pipe_pane', 'manual_refresh');

-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "activeTaskCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: rename the old week-only fields to their new explicit names (data-preserving)
ALTER TABLE "AgentUsageSnapshot" RENAME COLUMN "usagePercent" TO "weekPercent";
ALTER TABLE "AgentUsageSnapshot" RENAME COLUMN "resetTime" TO "weekResetTime";
ALTER TABLE "AgentUsageSnapshot" RENAME COLUMN "resetAt" TO "weekResetAt";

-- AlterTable: add session-percent columns and parser-reliability metadata
ALTER TABLE "AgentUsageSnapshot"
  ADD COLUMN     "sessionPercent" DOUBLE PRECISION,
  ADD COLUMN     "sessionResetTime" TEXT,
  ADD COLUMN     "sessionResetAt" TIMESTAMP(3),
  ADD COLUMN     "parserConfidence" "ParserConfidence" NOT NULL DEFAULT 'failed',
  ADD COLUMN     "parseWarnings" TEXT[],
  ADD COLUMN     "source" "UsageCaptureSource" NOT NULL DEFAULT 'tmux_capture';

-- Backfill: pre-existing rows were captured by the pipe-pane manual-refresh route before this
-- migration, and never went through the new confidence pipeline. Record both facts honestly
-- rather than implying false confidence.
UPDATE "AgentUsageSnapshot" SET "source" = 'pipe_pane', "parserConfidence" = 'failed';

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "allowHighRiskAutonomy" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "autonomousMode" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "constraints" TEXT,
ADD COLUMN     "improvementFocus" TEXT,
ADD COLUMN     "lastObjectiveUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "nonGoals" TEXT,
ADD COLUMN     "objective" TEXT,
ADD COLUMN     "successCriteria" TEXT;

-- AlterTable
ALTER TABLE "Task" ADD COLUMN     "isAutonomous" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "riskLevel" "RiskLevel" NOT NULL DEFAULT 'medium',
ADD COLUMN     "validationEvidence" TEXT,
ADD COLUMN     "validationStatus" "ValidationStatus";
