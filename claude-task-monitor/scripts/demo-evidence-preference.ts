/**
 * Baseline vs. Evidence-Preferred — reproducible demo, under 40s.
 *
 * Distinct from scripts/demo-adaptive-trust.ts (which demonstrates
 * getAdvisoryRecommendation — a function that NEVER changes the pick, by
 * design) — this script demonstrates compareBaselineWithEvidencePreference,
 * which CAN recommend a genuinely different, but still eligible, agent when
 * the evidence gap clearly justifies it (lib/adaptive-trust.ts).
 *
 * IMPORTANT — what this is and is not:
 *   - lib/agent-selector.ts and lib/adaptive-trust.ts are called exactly as
 *     production code would call them. Both the baseline pick and the
 *     evidence-preferred pick below come from real function calls — neither
 *     is a hardcoded UI label.
 *   - The agent history is SYNTHETIC FIXTURE DATA, labeled [SYNTHETIC]
 *     throughout, seeded and deleted by this script.
 *   - The two agents seeded here are deliberately constructed so the
 *     evidence gap clears MIN_SCORE_GAP_TO_PREFER — this is not "forcing"
 *     a different result; it is choosing a scenario where real evidence
 *     legitimately supports one. Run scripts/adaptive-trust-evidence.ts
 *     for cases where no alternative is recommended, by the same logic.
 *
 * Run directly, not via `npm run` (see scripts/demo-adaptive-trust.ts's
 * header comment for why `npm run` is unreliable on this machine):
 *   set -a; source .env.local; set +a; npx tsx scripts/demo-evidence-preference.ts
 */

import { prisma } from "../lib/prisma";
import { selectBestAgent, type AgentCandidate } from "../lib/agent-selector";
import { compareBaselineWithEvidencePreference } from "../lib/adaptive-trust";

const PREFIX = "_demo_evidence_pref_";
const PROJECT_ID = `${PREFIX}project`;
const SERVER_ID = `${PREFIX}server`;
// "a_" / "b_" prefixes (not the words "weak"/"strong" themselves — verified
// by actually running this, not assumed: "strong" < "weak" lexicographically,
// which silently made the baseline already pick the strong agent and
// defeated the point of this demo on the first attempt) — a_weak sorts
// first and wins the baseline tie-break; b_strong does not.
const WEAK_ID = `${PREFIX}a_weak`;
const STRONG_ID = `${PREFIX}b_strong`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      if (i < attempts - 1) { console.log(`   (connection attempt ${i + 1} failed, retrying in 3s...)`); await new Promise((r) => setTimeout(r, 3000)); }
    }
  }
  throw lastErr;
}

async function cleanup() {
  await prisma.auditEvent.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } });
}

async function main() {
  console.log("=== Baseline vs. Evidence-Preferred — SYNTHETIC FIXTURE DATA ===\n");
  await withRetry(cleanup);

  await prisma.project.upsert({ where: { id: PROJECT_ID }, create: { id: PROJECT_ID, name: "[SYNTHETIC] evidence-preference demo", priority: "P4", status: "active" }, update: {} });
  await prisma.server.upsert({ where: { id: SERVER_ID }, create: { id: SERVER_ID, name: "[SYNTHETIC] demo server", host: "127.0.0.1", username: "demo", sshKeyPath: "/dev/null" }, update: {} });
  await prisma.agent.upsert({ where: { id: WEAK_ID }, create: { id: WEAK_ID, serverId: SERVER_ID, name: "[SYNTHETIC] agent_weak", slug: WEAK_ID, workDir: "/tmp", tmuxSession: WEAK_ID, status: "idle" }, update: { status: "idle" } });
  await prisma.agent.upsert({ where: { id: STRONG_ID }, create: { id: STRONG_ID, serverId: SERVER_ID, name: "[SYNTHETIC] agent_strong", slug: STRONG_ID, workDir: "/tmp", tmuxSession: STRONG_ID, status: "idle" }, update: { status: "idle" } });

  // B. Independent verification outcomes — real AuditEvent rows, same shape
  // lib/validation-gate.ts actually writes.
  const weakOutcomes: Array<["passed"] | ["failed", string]> = [["passed"], ["failed", "independent_check_disagreed"], ["failed", "independent_check_disagreed"]];
  for (let i = 0; i < weakOutcomes.length; i++) {
    const [status, reason] = weakOutcomes[i];
    const taskId = `${WEAK_ID}_task_${i}`;
    await prisma.task.create({ data: { id: taskId, projectId: PROJECT_ID, agentId: WEAK_ID, title: `[SYNTHETIC] ${taskId}`, priority: "P4", status: status === "passed" ? "completed" : "failed", taskType: "coding", estimatedCostLevel: "low", isAutonomous: true, validationStatus: status } });
    await prisma.auditEvent.create({ data: { entityType: "task", entityId: taskId, eventType: status === "passed" ? "task.validation_passed" : "task.validation_failed", actorType: "poller", payload: reason ? { reason } : {} } });
  }
  for (let i = 0; i < 5; i++) {
    const taskId = `${STRONG_ID}_task_${i}`;
    await prisma.task.create({ data: { id: taskId, projectId: PROJECT_ID, agentId: STRONG_ID, title: `[SYNTHETIC] ${taskId}`, priority: "P4", status: "completed", taskType: "coding", estimatedCostLevel: "low", isAutonomous: true, validationStatus: "passed" } });
    await prisma.auditEvent.create({ data: { entityType: "task", entityId: taskId, eventType: "task.validation_passed", actorType: "poller", payload: {} } });
  }

  const candidates: AgentCandidate[] = [
    { id: WEAK_ID, name: "agent_weak", tags: [], status: "idle", healthScore: 100, activeTaskCount: 0, maxConcurrentTasks: 5, claudeSessionPct: 0, claudeWeekPct: 0, pausedDueToUsage: false, cooldownUntil: null },
    { id: STRONG_ID, name: "agent_strong", tags: [], status: "idle", healthScore: 100, activeTaskCount: 0, maxConcurrentTasks: 5, claudeSessionPct: 0, claudeWeekPct: 0, pausedDueToUsage: false, cooldownUntil: null },
  ];

  console.log("A. BASELINE selection (lib/agent-selector.ts's real selectBestAgent, unmodified):");
  const baseline = selectBestAgent(candidates, { requiredTags: [] });
  console.log(`   picked: ${baseline.agentId}  (both agents tie on health/load — alphabetical tie-break)\n`);

  console.log("B. Independent verification outcomes just seeded (real AuditEvent rows):");
  console.log("   agent_weak:   1 verified success, 2 false positives (caught lies)");
  console.log("   agent_strong: 5 verified successes, 0 failures\n");

  console.log("C. Evidence-informed advisory (lib/adaptive-trust.ts's real compareBaselineWithEvidencePreference):");
  const comparison = await compareBaselineWithEvidencePreference(candidates, { requiredTags: [], taskType: "coding" });
  console.log(`   baseline:           ${comparison.baselineAgentId}`);
  console.log(`   evidence-preferred: ${comparison.evidencePreferredAgentId}`);
  console.log(`   recommendationChanged: ${comparison.recommendationChanged}`);
  console.log(`   advisoryOnly: ${comparison.advisoryOnly}\n`);

  console.log("D. Explanation of the difference:");
  console.log(`   ${comparison.explanation}\n`);

  await withRetry(cleanup);
  await prisma.$disconnect();
  console.log("[demo-evidence-preference] done — all synthetic fixture rows removed.");
}

main().catch(async (err) => {
  console.error("[demo-evidence-preference] FAILED:", err);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
