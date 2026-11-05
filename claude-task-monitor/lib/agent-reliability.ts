/**
 * Adaptive Trust Engine — Evidence-Driven Agent Reliability.
 *
 * Deterministic, evidence-based scoring. This is NOT machine learning —
 * there is no trained model, no gradient, no weights that change over
 * time. Every number here is a direct, auditable aggregation of real
 * AuditEvent rows already written by lib/validation-gate.ts, which itself
 * never trusts an agent's self-report: a task only reaches
 * "task.validation_passed" after independent re-execution agreed with it.
 *
 * Core invariant: an agent's reliability signal is built exclusively from
 * INDEPENDENTLY VERIFIED outcomes, never from what the agent claimed.
 *
 * What is deliberately excluded from the sample, and why:
 *   - "missing_validation_block"            — the agent never proved anything
 *     either way (protocol violation, not a code-quality signal).
 *   - "file_level_policy_denied" /
 *     "file_level_policy_requires_approval" — the code may have been fine;
 *     a forbidden file was touched. Not a code-quality signal.
 *   - "workspace_unavailable" /
 *     "verification_attempt_failed"         — NOT_VERIFIED: WorkerAI itself
 *     couldn't confirm anything, so nothing is attributed to the agent.
 *   - Tasks with no validation event at all  — by construction, a task only
 *     gets ANY validation event once a completion marker appeared, so pure
 *     dispatch/infrastructure failures (SSH dropped before the agent ever
 *     got that far) never enter this computation in the first place.
 *
 * This keeps the sample restricted to cases where WorkerAI actually knows,
 * from real re-execution, whether the agent's claim held up — satisfying
 * "do not treat infrastructure failures as confirmed code-quality
 * failures" without needing a second join or a new column.
 */

import { prisma } from "@/lib/prisma";

export const MIN_SAMPLE_SIZE = 3;

/** False positives (agent claimed success, independent re-run disagreed) are
 *  weighted more heavily than honest failures — an agent that fails openly
 *  is more trustworthy than one that fails silently and claims success. */
const FALSE_POSITIVE_WEIGHT = 2;

export type ReliabilityVerdict =
  | "RELIABLE"
  | "MIXED"
  | "UNRELIABLE"
  | "INSUFFICIENT_EVIDENCE";

export interface ReliabilityCounts {
  verifiedSuccess: number;
  verifiedFailureHonest: number;
  verifiedFailureFalsePositive: number;
  excludedAmbiguous: number;
  excludedPolicy: number;
  excludedNotVerified: number;
}

export interface AgentReliabilityResult {
  agentId: string;
  /** null = aggregated across all task types for this agent. */
  taskType: string | null;
  verdict: ReliabilityVerdict;
  /** 0-100, deterministic formula below. null when INSUFFICIENT_EVIDENCE. */
  score: number | null;
  /** Count actually used in the score — excludes every "excluded*" bucket. */
  sampleSize: number;
  counts: ReliabilityCounts;
  explanation: string;
  /** Explicit, permanent marker: this is deterministic evidence aggregation,
   *  not a trained or learned model. */
  method: "deterministic_evidence_aggregation";
}

const REASON_BUCKET: Record<string, keyof ReliabilityCounts | "success"> = {
  independent_check_disagreed: "verifiedFailureFalsePositive",
  validation_block_reported_failed: "verifiedFailureHonest",
  missing_validation_block: "excludedAmbiguous",
  file_level_policy_denied: "excludedPolicy",
  file_level_policy_requires_approval: "excludedPolicy",
  workspace_unavailable: "excludedNotVerified",
  verification_attempt_failed: "excludedNotVerified",
};

function emptyCounts(): ReliabilityCounts {
  return {
    verifiedSuccess: 0,
    verifiedFailureHonest: 0,
    verifiedFailureFalsePositive: 0,
    excludedAmbiguous: 0,
    excludedPolicy: 0,
    excludedNotVerified: 0,
  };
}

function explain(counts: ReliabilityCounts, sampleSize: number, verdict: ReliabilityVerdict): string {
  if (verdict === "INSUFFICIENT_EVIDENCE") {
    return `Only ${sampleSize} independently-verified observation(s) — fewer than the minimum of ${MIN_SAMPLE_SIZE} required before scoring. Not enough evidence to rate this agent yet.`;
  }
  const parts = [
    `${counts.verifiedSuccess} independently verified success(es)`,
    counts.verifiedFailureHonest > 0 ? `${counts.verifiedFailureHonest} honest failure(s)` : null,
    counts.verifiedFailureFalsePositive > 0
      ? `${counts.verifiedFailureFalsePositive} false positive(s) (claimed success, independent re-execution disagreed)`
      : null,
  ].filter(Boolean);
  const excludedTotal = counts.excludedAmbiguous + counts.excludedPolicy + counts.excludedNotVerified;
  const excludedNote = excludedTotal > 0
    ? ` (${excludedTotal} additional observation(s) excluded — not verified, ambiguous, or policy-related, not a code-quality signal)`
    : "";
  return `Based on ${sampleSize} independently-verified outcome(s): ${parts.join(", ")}.${excludedNote}`;
}

function scoreOf(counts: ReliabilityCounts): number {
  const weightedFailures = counts.verifiedFailureHonest + counts.verifiedFailureFalsePositive * FALSE_POSITIVE_WEIGHT;
  const weightedTotal = counts.verifiedSuccess + weightedFailures;
  const raw = weightedTotal > 0 ? (counts.verifiedSuccess / weightedTotal) * 100 : 0;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

function verdictOf(score: number, falsePositives: number, sampleSize: number): ReliabilityVerdict {
  if (sampleSize < MIN_SAMPLE_SIZE) return "INSUFFICIENT_EVIDENCE";
  // Any observed false positive (a lie that was caught) caps the verdict at
  // MIXED at best, regardless of how high the raw score is — a single
  // confirmed lie is a qualitatively different signal than a clean record,
  // and should never be hidden behind an otherwise-high score.
  if (score >= 90 && falsePositives === 0) return "RELIABLE";
  if (score < 50) return "UNRELIABLE";
  return "MIXED";
}

interface ValidationAuditRow {
  entityId: string;
  eventType: string;
  createdAt: Date;
  payload: unknown;
}

/**
 * Compute a deterministic reliability signal for one agent, from real,
 * independently-verified outcomes only. Never throws — a DB error or
 * malformed/missing record degrades to INSUFFICIENT_EVIDENCE rather than
 * crashing a caller (e.g. an advisory routing check).
 */
export async function computeAgentReliability(
  agentId: string,
  opts?: { taskType?: string; since?: Date },
): Promise<AgentReliabilityResult> {
  try {
    const tasks = await prisma.task.findMany({
      where: {
        agentId,
        isAutonomous: true,
        ...(opts?.taskType ? { taskType: opts.taskType as never } : {}),
        ...(opts?.since ? { updatedAt: { gte: opts.since } } : {}),
      },
      select: { id: true },
    });
    if (tasks.length === 0) {
      const counts = emptyCounts();
      return {
        agentId,
        taskType: opts?.taskType ?? null,
        verdict: "INSUFFICIENT_EVIDENCE",
        score: null,
        sampleSize: 0,
        counts,
        explanation: explain(counts, 0, "INSUFFICIENT_EVIDENCE"),
        method: "deterministic_evidence_aggregation",
      };
    }

    const taskIds = tasks.map((t) => t.id);
    const events = (await prisma.auditEvent.findMany({
      where: {
        entityType: "task",
        entityId: { in: taskIds },
        eventType: { in: ["task.validation_passed", "task.validation_failed", "task.verification_unavailable"] },
      },
      select: { entityId: true, eventType: true, createdAt: true, payload: true },
      orderBy: { createdAt: "asc" },
    })) as ValidationAuditRow[];

    // Latest relevant validation event per task — a retried task's earlier
    // attempts aren't a separate trust signal about the agent's current state.
    const latestByTask = new Map<string, ValidationAuditRow>();
    for (const ev of events) latestByTask.set(ev.entityId, ev);

    const counts = emptyCounts();
    for (const ev of latestByTask.values()) {
      if (ev.eventType === "task.validation_passed") {
        counts.verifiedSuccess++;
        continue;
      }
      const payload = (ev.payload ?? {}) as { reason?: unknown };
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      const bucket = reason ? REASON_BUCKET[reason] : undefined;
      if (!bucket) {
        // Unrecognized/malformed reason — fail safe by excluding, never by
        // guessing it was a success or a failure.
        counts.excludedAmbiguous++;
        continue;
      }
      if (bucket === "success") counts.verifiedSuccess++;
      else counts[bucket]++;
    }

    const sampleSize = counts.verifiedSuccess + counts.verifiedFailureHonest + counts.verifiedFailureFalsePositive;
    const score = sampleSize >= MIN_SAMPLE_SIZE ? scoreOf(counts) : null;
    const verdict = sampleSize < MIN_SAMPLE_SIZE
      ? "INSUFFICIENT_EVIDENCE"
      : verdictOf(score!, counts.verifiedFailureFalsePositive, sampleSize);

    return {
      agentId,
      taskType: opts?.taskType ?? null,
      verdict,
      score,
      sampleSize,
      counts,
      explanation: explain(counts, sampleSize, verdict),
      method: "deterministic_evidence_aggregation",
    };
  } catch {
    const counts = emptyCounts();
    return {
      agentId,
      taskType: opts?.taskType ?? null,
      verdict: "INSUFFICIENT_EVIDENCE",
      score: null,
      sampleSize: 0,
      counts,
      explanation: "Reliability data could not be loaded — treated as insufficient evidence, not as a failure.",
      method: "deterministic_evidence_aggregation",
    };
  }
}
