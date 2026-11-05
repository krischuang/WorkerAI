/**
 * Adaptive Trust Engine — advisory routing layer.
 *
 * SHADOW / ADVISORY MODE ONLY. This module never changes what gets
 * dispatched. It calls the existing, unmodified lib/agent-selector.ts
 * exactly as production dispatch does (same hard eligibility gates, same
 * scoring), then layers an explainable reliability annotation on top for
 * a human or a demo to read. Nothing here is wired into
 * lib/task-service.ts's autoAssignQueuedTasks — that function still calls
 * selectBestAgent() directly and is untouched by this file.
 *
 * Explicit non-goals, enforced by construction:
 *   - Never overrides a hard eligibility rejection (scoreAgent's gates are
 *     called exactly as-is; this module only reads their output).
 *   - Never overrides or bypasses a policy/approval decision — those live
 *     entirely in lib/policy-engine.ts and lib/task-dispatch.ts, neither of
 *     which this module calls or reimplements.
 *   - Never uses a low reliability score as a hard ban — at most it adds a
 *     "flagged" review note next to the top pick; the top pick by the
 *     existing scorer is still returned as the recommendation.
 *   - Never persists or feeds back into scoreAgent's own weights — every
 *     call recomputes from raw AuditEvent rows, so there is no
 *     self-reinforcing loop where a low score makes future scores lower.
 *
 * Two exported entry points:
 *   - getAdvisoryRecommendation() — annotates the existing pick, never
 *     changes it. Use when you want evidence layered onto today's answer.
 *   - compareBaselineWithEvidencePreference() — may recommend a genuinely
 *     different, but still eligible, agent when the evidence gap clears a
 *     conservative threshold (MIN_SCORE_GAP_TO_PREFER). Still advisory
 *     only: it returns a comparison object, it dispatches nothing.
 */

import { selectBestAgent, type AgentCandidate, type TaskRequirement, type AgentScoreResult } from "@/lib/agent-selector";
import { computeAgentReliability, type AgentReliabilityResult } from "@/lib/agent-reliability";

export interface AdvisoryCandidate {
  score: AgentScoreResult;
  reliability: AgentReliabilityResult | null;
}

export interface AdvisoryRecommendation {
  /** Exactly what production dispatch would pick today — untouched. */
  productionPick: string | null;
  /** Per-candidate breakdown: existing eligibility/score plus reliability evidence. */
  candidates: AdvisoryCandidate[];
  /** Human-readable advisory note. Never a dispatch instruction. */
  advisoryNote: string;
  /** True only when the top-scored eligible agent has a confirmed false
   *  positive on record for this task type — worth a human glance, never
   *  a block. */
  flaggedForReview: boolean;
  mode: "SHADOW_ADVISORY";
}

/**
 * Produce an explainable advisory recommendation for a task. Does not
 * dispatch anything and does not persist anything. Safe to call as often
 * as desired, including from a demo script or a read-only API route.
 */
export async function getAdvisoryRecommendation(
  agents: AgentCandidate[],
  task: TaskRequirement & { taskType?: string },
  now: Date = new Date(),
): Promise<AdvisoryRecommendation> {
  // Unmodified existing selection — same hard gates, same scoring, same
  // result production dispatch would get for this exact input.
  const { agentId: productionPick, scores } = selectBestAgent(agents, task, now);

  const candidates: AdvisoryCandidate[] = await Promise.all(
    scores.map(async (score) => ({
      score,
      reliability: score.eligible
        ? await computeAgentReliability(score.agentId, { taskType: task.taskType })
        : null,
    })),
  );

  if (!productionPick) {
    return {
      productionPick: null,
      candidates,
      advisoryNote: "No eligible agent today — reliability evidence is not applicable when there is nothing to recommend.",
      flaggedForReview: false,
      mode: "SHADOW_ADVISORY",
    };
  }

  const picked = candidates.find((c) => c.score.agentId === productionPick)!;
  const reliability = picked.reliability;

  let advisoryNote: string;
  let flaggedForReview = false;

  if (!reliability || reliability.verdict === "INSUFFICIENT_EVIDENCE") {
    advisoryNote = `Production pick "${picked.score.agentName}" has insufficient independently-verified history for this task type yet — proceeding on the existing eligibility/score rules alone, same as today.`;
  } else if (reliability.counts.verifiedFailureFalsePositive > 0) {
    flaggedForReview = true;
    advisoryNote = `Production pick "${picked.score.agentName}" is still the top-scored eligible agent (hard gates and scoring unchanged). Advisory note only: this agent has ${reliability.counts.verifiedFailureFalsePositive} confirmed false-positive completion(s) on record for this task type — a human may want to review its output more closely, but dispatch is not blocked or altered.`;
  } else if (reliability.verdict === "UNRELIABLE") {
    advisoryNote = `Production pick "${picked.score.agentName}" is still the top-scored eligible agent. Advisory note only: its independently-verified reliability score is low (${reliability.score}/100, n=${reliability.sampleSize}) — worth a closer look, not a block.`;
  } else {
    advisoryNote = `Production pick "${picked.score.agentName}" also has a strong independently-verified track record (${reliability.score}/100, n=${reliability.sampleSize}). No discrepancy to flag.`;
  }

  return { productionPick, candidates, advisoryNote, flaggedForReview, mode: "SHADOW_ADVISORY" };
}

// ─── Baseline vs. evidence-preferred comparison ────────────────────────────

/**
 * An evidence-preferred candidate is only ever recommended over the baseline
 * when its reliability score beats the baseline's by at least this many
 * points, AND both have met the minimum sample size
 * (lib/agent-reliability.ts's MIN_SAMPLE_SIZE). This is a deliberate,
 * conservative floor — "3/3 successes" is never, on its own, enough to
 * prefer one agent over another; a real, clear gap is required. Keeps this
 * advisory from flip-flopping on noise-level score differences.
 */
export const MIN_SCORE_GAP_TO_PREFER = 20;

export interface BaselineVsEvidenceComparison {
  taskCategory: string | null;
  /** Exactly what lib/agent-selector.ts's selectBestAgent() picks today — untouched. */
  baselineAgentId: string | null;
  /** Same as baselineAgentId unless real, sufficient evidence justified a
   *  different pick AMONG THE SAME ELIGIBLE CANDIDATES. Never an ineligible
   *  agent — see reuseOfEligibility below. */
  evidencePreferredAgentId: string | null;
  recommendationChanged: boolean;
  baselineReliability: AgentReliabilityResult | null;
  preferredReliability: AgentReliabilityResult | null;
  /** Human-readable, never a dispatch instruction. */
  explanation: string;
  /** Populated whenever recommendationChanged is false — always states a
   *  concrete reason, never left to be inferred. */
  reasonNoAlternative: string | null;
  advisoryOnly: true;
}

/**
 * Compare the baseline (capability/health/load) pick against an
 * evidence-preferred alternative computed purely from independently-verified
 * reliability history — among the SAME eligible candidate set, reusing
 * lib/agent-selector.ts's own eligibility output rather than re-deriving it.
 *
 * Does not dispatch anything. Does not persist anything. The two
 * recommendations may legitimately differ when evidence clearly supports
 * it, but this function never forces a difference — when evidence is
 * insufficient, ambiguous, or within normal variance of the baseline, it
 * returns the baseline unchanged with an explicit reason.
 */
export async function compareBaselineWithEvidencePreference(
  agents: AgentCandidate[],
  task: TaskRequirement & { taskType?: string },
  now: Date = new Date(),
): Promise<BaselineVsEvidenceComparison> {
  // Reuses selectBestAgent's own eligibility/scoring — never re-derives
  // hard gates (offline, paused-on-usage, over capacity, unhealthy, missing
  // tags). An ineligible agent can never appear as evidencePreferredAgentId
  // because it is filtered out of `eligible` below before reliability is
  // ever consulted.
  const { agentId: baselineAgentId, scores } = selectBestAgent(agents, task, now);
  const taskCategory = task.taskType ?? null;

  if (!baselineAgentId) {
    return {
      taskCategory,
      baselineAgentId: null,
      evidencePreferredAgentId: null,
      recommendationChanged: false,
      baselineReliability: null,
      preferredReliability: null,
      explanation: "No eligible agent today — the same hard gates (offline/paused/over-capacity/missing tags) that block production dispatch also block this advisory comparison.",
      reasonNoAlternative: "no_eligible_agent",
      advisoryOnly: true,
    };
  }

  const eligible = scores.filter((s) => s.eligible);
  const reliabilityByAgent = new Map<string, AgentReliabilityResult>(
    await Promise.all(
      eligible.map(async (s): Promise<[string, AgentReliabilityResult]> => [
        s.agentId,
        await computeAgentReliability(s.agentId, { taskType: task.taskType }),
      ]),
    ),
  );

  const baselineReliability = reliabilityByAgent.get(baselineAgentId) ?? null;

  // Only candidates with evidence past the minimum-sample floor are even
  // considered as a potential alternative — an agent with 2 observations is
  // never preferred over anything, no matter how good those 2 look.
  const withSufficientEvidence = eligible
    .map((s) => ({ agentId: s.agentId, agentName: s.agentName, reliability: reliabilityByAgent.get(s.agentId)! }))
    .filter((c) => c.reliability.verdict !== "INSUFFICIENT_EVIDENCE" && c.reliability.score !== null);

  if (withSufficientEvidence.length === 0) {
    return {
      taskCategory,
      baselineAgentId,
      evidencePreferredAgentId: baselineAgentId,
      recommendationChanged: false,
      baselineReliability,
      preferredReliability: baselineReliability,
      explanation: `No eligible candidate for "${taskCategory ?? "this task type"}" has enough independently-verified history yet to prefer on evidence — proceeding with the baseline pick.`,
      reasonNoAlternative: "insufficient_evidence_for_all_candidates",
      advisoryOnly: true,
    };
  }

  // Highest score wins; ties broken by agent id for determinism, matching
  // lib/agent-selector.ts's own tie-break convention.
  const bestEvidence = [...withSufficientEvidence].sort(
    (a, b) => (b.reliability.score! - a.reliability.score!) || a.agentId.localeCompare(b.agentId),
  )[0];

  const baselineHasSufficientEvidence = baselineReliability && baselineReliability.verdict !== "INSUFFICIENT_EVIDENCE";
  const baselineScore = baselineHasSufficientEvidence ? baselineReliability!.score! : null;
  const gap = baselineScore === null ? bestEvidence.reliability.score! : bestEvidence.reliability.score! - baselineScore;

  const shouldPrefer = bestEvidence.agentId !== baselineAgentId && gap >= MIN_SCORE_GAP_TO_PREFER;

  if (!shouldPrefer) {
    const explanation = baselineHasSufficientEvidence
      ? `Baseline pick "${eligible.find((s) => s.agentId === baselineAgentId)!.agentName}" already has a comparable or stronger independently-verified record (${baselineScore}/100, n=${baselineReliability!.sampleSize}) — no evidence-based reason to prefer a different eligible agent.`
      : `Baseline pick has insufficient evidence, and the best-evidenced alternative's score (${bestEvidence.reliability.score}/100, n=${bestEvidence.reliability.sampleSize}) isn't a clear enough margin (requires ≥${MIN_SCORE_GAP_TO_PREFER} points over baseline) to justify switching away from the existing capability/health/load pick.`;
    return {
      taskCategory,
      baselineAgentId,
      evidencePreferredAgentId: baselineAgentId,
      recommendationChanged: false,
      baselineReliability,
      preferredReliability: baselineReliability,
      explanation,
      reasonNoAlternative: baselineHasSufficientEvidence ? "baseline_already_preferred" : "gap_below_threshold",
      advisoryOnly: true,
    };
  }

  return {
    taskCategory,
    baselineAgentId,
    evidencePreferredAgentId: bestEvidence.agentId,
    recommendationChanged: true,
    baselineReliability,
    preferredReliability: bestEvidence.reliability,
    explanation: `"${bestEvidence.agentName}" has a clearly stronger independently-verified record for "${taskCategory ?? "this task type"}" (${bestEvidence.reliability.score}/100, n=${bestEvidence.reliability.sampleSize}) than the baseline pick (${baselineScore ?? "insufficient evidence"}${baselineScore !== null ? "/100" : ""}${baselineReliability ? `, n=${baselineReliability.sampleSize}` : ""}) — a gap of ${gap} points, past the ${MIN_SCORE_GAP_TO_PREFER}-point threshold this advisory requires before ever preferring an alternative. Advisory only: dispatch still uses the baseline pick unless a human acts on this.`,
    reasonNoAlternative: null,
    advisoryOnly: true,
  };
}
