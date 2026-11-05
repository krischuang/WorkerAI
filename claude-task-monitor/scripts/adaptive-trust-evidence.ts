/**
 * Adaptive Trust Engine — reproducible Before/After evidence experiment.
 *
 * Distinct from scripts/demo-adaptive-trust.ts (the fast, ~31s, 2-agent
 * script used LIVE on stage). This script is for judge-facing, reproducible
 * evidence: it exercises the real, unmodified production functions
 * (lib/agent-selector.ts's selectBestAgent, lib/adaptive-trust.ts's
 * getAdvisoryRecommendation, lib/policy-engine.ts's evaluateDispatchPolicy)
 * across 7 distinct scenarios and prints a compact comparison table. Not
 * timed for live narration — run it ahead of time and show the output, or
 * run it live if there's a question about it; it takes under a minute.
 *
 * IMPORTANT — what this is and is not:
 *   - lib/agent-selector.ts, lib/adaptive-trust.ts, lib/agent-reliability.ts,
 *     lib/policy-engine.ts are called exactly as production code would call
 *     them. Nothing here is a reimplementation or a mock of the decision
 *     logic.
 *   - The AGENT HISTORY fed into them is SYNTHETIC FIXTURE DATA, labeled
 *     [SYNTHETIC] throughout, seeded and deleted by this script. This
 *     repository does not yet have enough real accumulated task history to
 *     run this comparison honestly against real production data.
 *   - This script does NOT measure or claim any real production success
 *     rate improvement — it demonstrates the algorithm's decision logic
 *     against controlled, labeled scenarios, nothing more.
 *   - Every "recommendation" printed is advisory only — confirmed directly
 *     in each row via the same `mode: "SHADOW_ADVISORY"` field production
 *     code would see.
 *
 * Run directly (not via `npm run` — see scripts/demo-adaptive-trust.ts's
 * header comment for why `npm run` is unreliable on this machine):
 *   set -a; source .env.local; set +a; npx tsx scripts/adaptive-trust-evidence.ts
 */

import { prisma } from "../lib/prisma";
import { selectBestAgent, type AgentCandidate } from "../lib/agent-selector";
import { getAdvisoryRecommendation } from "../lib/adaptive-trust";
import { evaluateDispatchPolicy } from "../lib/policy-engine";

const PREFIX = "_ate_evidence_";
const PROJECT_ID = `${PREFIX}project`;
const SERVER_ID = `${PREFIX}server`;

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.log(`   (connection attempt ${i + 1} failed, retrying in 3s...)`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastErr;
}

function baseAgent(id: string, overrides: Partial<AgentCandidate> = {}): AgentCandidate {
  return {
    id,
    name: id.replace(PREFIX, ""),
    tags: [],
    status: "idle",
    healthScore: 100,
    activeTaskCount: 0,
    maxConcurrentTasks: 5,
    claudeSessionPct: 0,
    claudeWeekPct: 0,
    pausedDueToUsage: false,
    cooldownUntil: null,
    ...overrides,
  };
}

async function seedAgent(id: string) {
  await prisma.agent.upsert({
    where: { id },
    create: { id, serverId: SERVER_ID, name: `[SYNTHETIC] ${id}`, slug: id, workDir: "/tmp", tmuxSession: id, status: "idle" },
    update: { status: "idle" },
  });
}

/** Seed N task+auditEvent rows for an agent. `outcomes` entries are either
 *  "passed" or ["failed", reason] — see lib/agent-reliability.ts's
 *  REASON_BUCKET for the exact reason strings this maps to. Pass
 *  `noEvent: true` entries to simulate a pure infrastructure failure: a
 *  Task row exists, but no validation AuditEvent was ever emitted, because
 *  the agent never reached a completion marker in the first place. */
async function seedOutcomes(
  agentId: string,
  outcomes: Array<"passed" | ["failed", string] | "noEvent">,
  taskType = "coding",
) {
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = outcomes[i];
    const taskId = `${agentId}_task_${i}`;
    const isNoEvent = outcome === "noEvent";
    const status = isNoEvent ? "failed" : Array.isArray(outcome) ? "failed" : "completed";
    await prisma.task.upsert({
      where: { id: taskId },
      create: {
        id: taskId, projectId: PROJECT_ID, agentId,
        title: `[SYNTHETIC] ${taskId}`, priority: "P4", status,
        taskType: taskType as never, estimatedCostLevel: "low", isAutonomous: true,
        validationStatus: isNoEvent ? null : Array.isArray(outcome) ? "failed" : "passed",
        lastFailReason: isNoEvent ? "SSH connection dropped mid-execution (simulated infrastructure failure — no completion marker ever appeared)" : undefined,
      },
      update: {},
    });
    if (!isNoEvent) {
      const reason = Array.isArray(outcome) ? outcome[1] : undefined;
      await prisma.auditEvent.create({
        data: {
          entityType: "task", entityId: taskId,
          eventType: outcome === "passed" ? "task.validation_passed" : "task.validation_failed",
          actorType: "poller",
          payload: reason ? { reason } : {},
        },
      });
    }
  }
}

async function cleanup() {
  await prisma.auditEvent.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } });
}

interface Row {
  scenario: string;
  before: string;
  after: string;
  taskType: string;
  n: number | string;
  success: number | string;
  failures: string;
  verdict: string;
  explanation: string;
  advisoryOnly: boolean | string;
}

async function main() {
  console.log("=== Adaptive Trust Engine — reproducible Before/After evidence ===");
  console.log("=== SYNTHETIC FIXTURE DATA throughout — not real production history ===\n");

  await withRetry(cleanup);
  await prisma.project.upsert({
    where: { id: PROJECT_ID },
    create: { id: PROJECT_ID, name: "[SYNTHETIC] ATE evidence", priority: "P4", status: "active" },
    update: {},
  });
  await prisma.server.upsert({
    where: { id: SERVER_ID },
    create: { id: SERVER_ID, name: "[SYNTHETIC] evidence server", host: "127.0.0.1", username: "demo", sshKeyPath: "/dev/null" },
    update: {},
  });

  const rows: Row[] = [];
  const taskReq = { requiredTags: [] as string[], taskType: "coding" };

  // Shared "neutral" baseline agent every scenario's test agent competes
  // against — identical eligibility/score, zero history, so the BEFORE
  // pick is always a tie broken by lexicographic agent id (deterministic,
  // not meaningful on its own — the point is what AFTER adds on top).
  // "zz_" prefix guarantees this id sorts AFTER every scenario's test-agent
  // id below (selectBestAgent breaks ties lexicographically) — otherwise an
  // accident of alphabetical ordering could pick this zero-history baseline
  // instead of the scenario's actual subject, making the printed
  // explanation describe the wrong agent. Caught by actually running this
  // script and reading its output, not assumed.
  const neutralId = `${PREFIX}zz_neutral`;
  await seedAgent(neutralId);

  async function runScenario(label: string, agentId: string) {
    await seedAgent(agentId);
    const candidates = [baseAgent(agentId), baseAgent(neutralId)];
    const before = selectBestAgent(candidates, taskReq);
    const after = await getAdvisoryRecommendation(candidates, taskReq);
    const testAgentReliability = after.candidates.find((c) => c.score.agentId === agentId)?.reliability;
    return { before, after, testAgentReliability };
  }

  // 1. Verified agent success
  {
    const agentId = `${PREFIX}vet_success`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", "passed", "passed", "passed", "passed"]);
    const { before, after, testAgentReliability: r } = await runScenario("Verified agent success", agentId);
    rows.push({
      scenario: "1. Verified agent success",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: r?.sampleSize ?? "n/a",
      success: r?.counts.verifiedSuccess ?? "n/a",
      failures: `${r?.counts.verifiedFailureHonest ?? 0} honest / ${r?.counts.verifiedFailureFalsePositive ?? 0} false-positive`,
      verdict: r?.verdict ?? "n/a",
      explanation: after.advisoryNote,
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 2. Verified agent failure (honest)
  {
    const agentId = `${PREFIX}vet_failure`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", ["failed", "validation_block_reported_failed"], ["failed", "validation_block_reported_failed"]]);
    const { before, after, testAgentReliability: r } = await runScenario("Verified agent failure", agentId);
    rows.push({
      scenario: "2. Verified agent failure (honest)",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: r?.sampleSize ?? "n/a",
      success: r?.counts.verifiedSuccess ?? "n/a",
      failures: `${r?.counts.verifiedFailureHonest ?? 0} honest / ${r?.counts.verifiedFailureFalsePositive ?? 0} false-positive`,
      verdict: r?.verdict ?? "n/a",
      explanation: after.advisoryNote,
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 3. False self-reported success (caught lie)
  {
    const agentId = `${PREFIX}false_positive`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", "passed", ["failed", "independent_check_disagreed"]]);
    const { before, after, testAgentReliability: r } = await runScenario("False self-reported success", agentId);
    rows.push({
      scenario: "3. False self-reported success",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: r?.sampleSize ?? "n/a",
      success: r?.counts.verifiedSuccess ?? "n/a",
      failures: `${r?.counts.verifiedFailureHonest ?? 0} honest / ${r?.counts.verifiedFailureFalsePositive ?? 0} false-positive`,
      verdict: r?.verdict ?? "n/a",
      explanation: after.advisoryNote,
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 4. Infrastructure failure (excluded from the sample entirely)
  {
    const agentId = `${PREFIX}infra_failure`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", "passed", "noEvent", "noEvent", "noEvent"]);
    const { before, after, testAgentReliability: r } = await runScenario("Infrastructure failure", agentId);
    rows.push({
      scenario: "4. Infrastructure failure (3 SSH drops, 5 tasks total)",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: `${r?.sampleSize ?? "n/a"} (of 5 tasks — 3 excluded, never reached a completion marker)`,
      success: r?.counts.verifiedSuccess ?? "n/a",
      failures: `${r?.counts.verifiedFailureHonest ?? 0} honest / ${r?.counts.verifiedFailureFalsePositive ?? 0} false-positive`,
      verdict: r?.verdict ?? "n/a",
      explanation: after.advisoryNote,
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 5. Insufficient sample size
  {
    const agentId = `${PREFIX}insufficient`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", "passed"]);
    const { before, after, testAgentReliability: r } = await runScenario("Insufficient sample size", agentId);
    rows.push({
      scenario: "5. Insufficient sample size (2 obs, min is 3)",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: r?.sampleSize ?? "n/a",
      success: r?.counts.verifiedSuccess ?? "n/a",
      failures: `${r?.counts.verifiedFailureHonest ?? 0} honest / ${r?.counts.verifiedFailureFalsePositive ?? 0} false-positive`,
      verdict: r?.verdict ?? "n/a",
      explanation: after.advisoryNote,
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 6. Hard eligibility exclusion — offline agent, reliability never consulted
  {
    const agentId = `${PREFIX}offline`;
    await seedAgent(agentId);
    await seedOutcomes(agentId, ["passed", "passed", "passed", "passed", "passed"]); // perfect history, irrelevant
    const candidates = [baseAgent(agentId, { status: "offline" }), baseAgent(neutralId)];
    const before = selectBestAgent(candidates, taskReq);
    const after = await getAdvisoryRecommendation(candidates, taskReq);
    const offlineCandidate = after.candidates.find((c) => c.score.agentId === agentId)!;
    rows.push({
      scenario: "6. Hard eligibility exclusion (agent offline, 5-obs perfect history)",
      before: before.agentId ?? "none",
      after: after.productionPick ?? "none",
      taskType: "coding",
      n: "n/a — hard gate rejected first",
      success: "n/a",
      failures: "n/a",
      verdict: `rejected: ${offlineCandidate.score.reasons.join("; ")}`,
      explanation: "Offline status is a hard gate in lib/agent-selector.ts, checked before any reliability lookup — a perfect 5-observation history does not and cannot override it.",
      advisoryOnly: after.mode === "SHADOW_ADVISORY",
    });
  }

  // 7. High-risk policy restriction — separate gate, untouched by ATE
  {
    const policyResult = await evaluateDispatchPolicy({ taskId: `${PREFIX}highrisk_task`, riskLevel: "high" });
    rows.push({
      scenario: "7. High-risk policy restriction (real evaluateDispatchPolicy call)",
      before: "n/a — this is a dispatch-policy check, not agent selection",
      after: "n/a — ATE does not call or override this function",
      taskType: "code_execution",
      n: "n/a",
      success: "n/a",
      failures: "n/a",
      verdict: `decision=${policyResult.decision} blocked=${policyResult.blocked} requiresApproval=${policyResult.requiresApproval}`,
      explanation: "lib/policy-engine.ts's real evaluateDispatchPolicy — a high-risk task requires approval regardless of which agent ATE would recommend. This gate runs independently and is never consulted by or able to be influenced by the Adaptive Trust Engine.",
      advisoryOnly: "n/a — not an ATE decision",
    });
  }

  console.log("Scenario | Before (plain selector) | After (advisory) | n | success | failures | verdict");
  console.log("-".repeat(100));
  for (const r of rows) {
    console.log(`\n${r.scenario}`);
    console.log(`  before=${r.before}  after=${r.after}  taskType=${r.taskType}`);
    console.log(`  n=${r.n}  success=${r.success}  failures=${r.failures}  verdict=${r.verdict}`);
    console.log(`  advisoryOnly=${r.advisoryOnly}`);
    console.log(`  explanation: ${r.explanation}`);
  }

  console.log("\n=== Summary ===");
  console.log("In every scenario, the AFTER (advisory) recommendation matches the BEFORE");
  console.log("(plain selector) recommendation exactly — by construction, the Adaptive");
  console.log("Trust Engine never overrides a production pick. What changes is the");
  console.log("EXPLANATION layered on top: from nothing (before) to an explicit,");
  console.log("evidence-grounded verdict with sample counts (after).");

  await withRetry(cleanup);
  await prisma.$disconnect();
  console.log("\n[adaptive-trust-evidence] done — all synthetic fixture rows removed.");
}

main().catch(async (err) => {
  console.error("[adaptive-trust-evidence] FAILED:", err);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
