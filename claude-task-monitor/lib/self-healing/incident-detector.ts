/**
 * Detects anomalies in agent state and emits incident descriptors.
 *
 * V1 detected conditions:
 *   usage_fetch_failure  — last refresh status is "error"
 *   usage_parse_error    — most recent snapshot has confidence "failed"
 *   usage_timeout        — error string contains timeout hint
 *   stale_usage_data     — claudeUsageFetchedAt is > STALE_THRESHOLD old while online
 *   invalid_usage_value  — session or week pct outside [0, 100]
 *   stuck_agent          — status "running" but no running tasks
 *
 * All other anomalies produce an incident with needs_human_review.
 */

import { prisma } from "@/lib/prisma";
import type { IncidentSeverity } from "@/app/generated/prisma/client";

const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _STUCK_AGENT_THRESHOLD_MS = 30 * 60 * 1000; // reserved for future use

export const V1_AUTO_REPAIR_SOURCES = new Set([
  "usage_fetch_failure",
  "usage_parse_error",
  "usage_timeout",
  "stale_usage_data",
  "invalid_usage_value",
  "stuck_agent",
]);

export interface IncidentDetection {
  source: string;
  severity: IncidentSeverity;
  affectedAgentId: string;
  title: string;
  message: string;
  rawError?: string;
  contextJson: Record<string, unknown>;
}

export async function detectIncidents(): Promise<IncidentDetection[]> {
  const agents = await prisma.agent.findMany({
    where: { status: { not: "offline" } },
    select: {
      id: true,
      name: true,
      status: true,
      claudeLastRefreshStatus: true,
      claudeUsageFetchedAt: true,
      claudeSessionPct: true,
      claudeWeekPct: true,
      activeTaskCount: true,
    },
  });

  // Fetch latest snapshot per agent for parse-error detection
  const recentSnapshots = await prisma.agentUsageSnapshot.findMany({
    where: {
      agentId: { in: agents.map((a) => a.id) },
      capturedAt: { gte: new Date(Date.now() - 5 * 60 * 1000) },
    },
    orderBy: { capturedAt: "desc" },
    distinct: ["agentId"],
    select: { agentId: true, parserConfidence: true, captureStatus: true, rawOutput: true },
  });
  const snapshotByAgent = new Map(recentSnapshots.map((s) => [s.agentId, s]));

  const detections: IncidentDetection[] = [];

  for (const agent of agents) {
    const refreshStatus = agent.claudeLastRefreshStatus ?? "ok";
    const snapshot = snapshotByAgent.get(agent.id);
    const now = Date.now();

    // ── usage_fetch_failure / usage_timeout ────────────────────────────────
    if (refreshStatus === "error") {
      const rawError = snapshot?.rawOutput?.slice(0, 500) ?? undefined;
      const isTimeout =
        rawError != null &&
        (rawError.toLowerCase().includes("timeout") ||
          rawError.toLowerCase().includes("timed out"));

      detections.push({
        source: isTimeout ? "usage_timeout" : "usage_fetch_failure",
        severity: "warning",
        affectedAgentId: agent.id,
        title: isTimeout
          ? `Usage fetch timed out — ${agent.name}`
          : `Usage fetch failed — ${agent.name}`,
        message: isTimeout
          ? `Agent "${agent.name}" usage refresh timed out.`
          : `Agent "${agent.name}" usage refresh returned an error.`,
        rawError,
        contextJson: { agentName: agent.name, refreshStatus },
      });
      continue; // don't stack further alerts on top of a failed fetch
    }

    // ── usage_parse_error ─────────────────────────────────────────────────
    if (snapshot && snapshot.parserConfidence === "failed" && snapshot.captureStatus !== "offline") {
      detections.push({
        source: "usage_parse_error",
        severity: "warning",
        affectedAgentId: agent.id,
        title: `Usage parse error — ${agent.name}`,
        message: `Agent "${agent.name}" usage output could not be parsed.`,
        rawError: snapshot.rawOutput?.slice(0, 500),
        contextJson: { agentName: agent.name, captureStatus: snapshot.captureStatus },
      });
    }

    // ── stale_usage_data ──────────────────────────────────────────────────
    if (
      agent.claudeUsageFetchedAt &&
      now - agent.claudeUsageFetchedAt.getTime() > STALE_THRESHOLD_MS
    ) {
      const staleMinutes = Math.round(
        (now - agent.claudeUsageFetchedAt.getTime()) / 60_000,
      );
      detections.push({
        source: "stale_usage_data",
        severity: "warning",
        affectedAgentId: agent.id,
        title: `Stale usage data — ${agent.name}`,
        message: `Agent "${agent.name}" usage data is ${staleMinutes} minutes old.`,
        contextJson: {
          agentName: agent.name,
          staleMinutes,
          claudeUsageFetchedAt: agent.claudeUsageFetchedAt.toISOString(),
        },
      });
    }

    // ── invalid_usage_value ───────────────────────────────────────────────
    const sessionPct = agent.claudeSessionPct;
    const weekPct = agent.claudeWeekPct;
    if (
      (sessionPct != null && (sessionPct < 0 || sessionPct > 100)) ||
      (weekPct != null && (weekPct < 0 || weekPct > 100))
    ) {
      detections.push({
        source: "invalid_usage_value",
        severity: "warning",
        affectedAgentId: agent.id,
        title: `Invalid usage value — ${agent.name}`,
        message: `Agent "${agent.name}" has an out-of-range usage value (session=${sessionPct}%, week=${weekPct}%).`,
        contextJson: { agentName: agent.name, sessionPct, weekPct },
      });
    }

    // ── stuck_agent ───────────────────────────────────────────────────────
    if (agent.status === "running" && agent.activeTaskCount === 0) {
      detections.push({
        source: "stuck_agent",
        severity: "error",
        affectedAgentId: agent.id,
        title: `Stuck agent — ${agent.name}`,
        message: `Agent "${agent.name}" is marked running but has no active tasks.`,
        contextJson: { agentName: agent.name, activeTaskCount: agent.activeTaskCount },
      });
    }
  }

  return detections;
}
