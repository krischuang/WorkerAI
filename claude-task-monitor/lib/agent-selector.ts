/**
 * Agent selection layer for autonomous task dispatch.
 *
 * scoreAgent() rejects agents that are offline, paused, over the usage threshold, unhealthy,
 * over capacity, in cooldown, or missing required tags. Eligible agents are scored by tag
 * match, usage (lower is better), health (higher is better), and active task count (lower is
 * better). selectBestAgent() picks the highest-scoring eligible agent and returns the full
 * per-candidate breakdown so callers can write an audit trail explaining the decision — see
 * lib/task-service.ts's autoAssignQueuedTasks.
 */

import { USAGE_THRESHOLD } from "@/lib/constants";

export type AgentStatus = "idle" | "running" | "offline" | "error";

export interface AgentCandidate {
  id: string;
  name: string;
  tags: string[];
  status: AgentStatus;
  healthScore: number | null;
  activeTaskCount: number;
  maxConcurrentTasks: number;
  claudeSessionPct: number | null;
  claudeWeekPct: number | null;
  pausedDueToUsage: boolean;
  cooldownUntil: Date | null;
}

export interface TaskRequirement {
  requiredTags: string[];
}

export interface AgentScoreResult {
  agentId: string;
  agentName: string;
  eligible: boolean;
  /** -Infinity for rejected agents; a finite weighted score for eligible ones (higher = better). */
  score: number;
  /** Rejection reason(s) when ineligible; descriptive scoring notes when eligible. */
  reasons: string[];
}

/** Agents below this health score are treated as unhealthy and rejected outright. */
export const MIN_HEALTH_SCORE = 30;

function usagePercentOf(agent: AgentCandidate): number {
  return Math.max(agent.claudeSessionPct ?? 0, agent.claudeWeekPct ?? 0);
}

function rejected(agent: AgentCandidate, reason: string): AgentScoreResult {
  return { agentId: agent.id, agentName: agent.name, eligible: false, score: -Infinity, reasons: [reason] };
}

/**
 * Score a single agent against a task's requirements. Returns `eligible: false` with a
 * human-readable rejection reason for any agent that fails a hard gate; otherwise returns a
 * weighted score for ranking against other eligible agents.
 */
export function scoreAgent(
  agent: AgentCandidate,
  task: TaskRequirement,
  now: Date = new Date(),
): AgentScoreResult {
  if (agent.status === "offline" || agent.status === "error") {
    return rejected(agent, `status is "${agent.status}"`);
  }
  if (agent.pausedDueToUsage) {
    return rejected(agent, "paused due to usage limit");
  }

  const usagePct = usagePercentOf(agent);
  if (usagePct >= USAGE_THRESHOLD) {
    return rejected(agent, `usage at ${usagePct}% is at or above the ${USAGE_THRESHOLD}% threshold`);
  }

  if (agent.cooldownUntil && agent.cooldownUntil.getTime() > now.getTime()) {
    return rejected(agent, `in cooldown until ${agent.cooldownUntil.toISOString()}`);
  }

  if (agent.activeTaskCount >= agent.maxConcurrentTasks) {
    return rejected(agent, `at capacity (${agent.activeTaskCount}/${agent.maxConcurrentTasks} active tasks)`);
  }

  if (agent.healthScore !== null && agent.healthScore < MIN_HEALTH_SCORE) {
    return rejected(agent, `health score ${agent.healthScore} is below the floor of ${MIN_HEALTH_SCORE}`);
  }

  const missingTags = task.requiredTags.filter((t) => !agent.tags.includes(t));
  if (missingTags.length > 0) {
    return rejected(agent, `missing required tags: ${missingTags.join(", ")}`);
  }

  // ── Eligible — weighted score, higher is better ──────────────────────────
  const reasons: string[] = [];
  let score = 0;

  if (task.requiredTags.length > 0) {
    score += 50;
    reasons.push(`matches all ${task.requiredTags.length} required tag(s)`);
  }

  score += (100 - usagePct); // lower usage scores higher, up to +100
  reasons.push(`usage=${usagePct}%`);

  const health = agent.healthScore ?? 100; // unknown health is treated as healthy, not penalized
  score += health * 0.5;
  reasons.push(`health=${agent.healthScore ?? "unknown"}`);

  score -= agent.activeTaskCount * 10; // each active task lowers the score
  reasons.push(`activeTasks=${agent.activeTaskCount}/${agent.maxConcurrentTasks}`);

  return { agentId: agent.id, agentName: agent.name, eligible: true, score, reasons };
}

export interface SelectionResult {
  agentId: string | null;
  scores: AgentScoreResult[];
}

/**
 * Score every candidate and pick the best eligible agent. Ties are broken by agent id
 * (lexicographic) so the result is deterministic regardless of input array order.
 */
export function selectBestAgent(
  agents: AgentCandidate[],
  task: TaskRequirement,
  now: Date = new Date(),
): SelectionResult {
  const scores = agents.map((agent) => scoreAgent(agent, task, now));
  const eligible = scores.filter((s) => s.eligible);

  if (eligible.length === 0) return { agentId: null, scores };

  const [best] = [...eligible].sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
  return { agentId: best.agentId, scores };
}
