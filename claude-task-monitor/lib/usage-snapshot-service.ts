/**
 * Single write path for Claude usage data, used by both the background poller and the manual
 * "Refresh usage" button (app/api/agents/[id]/claude-usage/route.ts).
 *
 * Two separate guarantees, both enforced here rather than at each call site:
 *   1. Every refresh attempt — success, failure, or low-confidence — is recorded as an
 *      AgentUsageSnapshot row, so the full capture history is always inspectable.
 *   2. Agent.claudeSessionPct/claudeWeekPct (the numbers shown everywhere else in the app) are
 *      only ever updated from a snapshot with confidence "high" or "medium". A "low" or
 *      "failed" result is recorded for the history but never touches the Agent row — this is
 *      what prevents a single bad capture from overwriting a known-good number with garbage,
 *      and from a later low-confidence read clobbering an earlier reliable one.
 */

import { prisma } from "@/lib/prisma";
import type { ReliableUsageResult, UsageCaptureSource } from "@/lib/ssh-claude-tmux";

export async function recordUsageSnapshot(
  agentId: string,
  result: ReliableUsageResult,
  source: UsageCaptureSource,
): Promise<{ snapshotId: string; agentUpdated: boolean }> {
  const snapshot = await prisma.agentUsageSnapshot.create({
    data: {
      agentId,
      sessionPercent: result.parsed.sessionPct ?? null,
      sessionResetTime: result.parsed.sessionResets ?? null,
      sessionResetAt: result.parsed.sessionResetsAt ?? null,
      weekPercent: result.parsed.weekPct ?? null,
      weekResetTime: result.parsed.weekResets ?? null,
      weekResetAt: result.parsed.weekResetsAt ?? null,
      usageCreditsEnabled: result.parsed.usageCreditsEnabled ?? null,
      parserConfidence: result.confidence,
      parseWarnings: result.warnings,
      source,
      captureStatus: result.status,
      rawOutput: result.rawOutput || null,
      cleanedOutput: result.cleanedOutput || null,
    },
  });

  // Never update the Agent's cached usage fields from a low-confidence or failed capture —
  // this is the rule that stops a bad single read from overwriting good data.
  const isEligible = result.confidence === "high" || result.confidence === "medium";

  if (isEligible) {
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        claudeSessionPct: result.parsed.sessionPct ?? null,
        claudeSessionResets: result.parsed.sessionResets ?? null,
        claudeSessionResetsAt: result.parsed.sessionResetsAt ?? null,
        claudeWeekPct: result.parsed.weekPct ?? null,
        claudeWeekResets: result.parsed.weekResets ?? null,
        claudeWeekResetsAt: result.parsed.weekResetsAt ?? null,
        claudeUsageRaw: result.rawOutput.slice(0, 500),
        claudeUsageFetchedAt: new Date(),
        claudeUsageCreditsEnabled: result.parsed.usageCreditsEnabled ?? null,
        claudeLastRefreshStatus: result.status,
      },
    });
  } else {
    // Still record that a refresh attempt happened and what its outcome was, without
    // touching any of the percentage/reset fields.
    await prisma.agent.update({
      where: { id: agentId },
      data: { claudeLastRefreshStatus: result.status },
    }).catch(() => { /* agent may have been deleted mid-refresh — non-fatal */ });
  }

  return { snapshotId: snapshot.id, agentUpdated: isEligible };
}
