/**
 * Adaptive Trust Engine demo — deterministic, evidence-based agent
 * reliability. Optional/stretch demo, not part of the core rehearsed
 * 6-minute flow (see docs/DEMO_DAY_6MIN_RUNBOOK.md).
 *
 * IMPORTANT — what this script is and is not:
 *   - lib/agent-reliability.ts and lib/adaptive-trust.ts themselves are
 *     real, unmocked, production code — the same functions a real caller
 *     would use.
 *   - The DATA fed into them here is SYNTHETIC FIXTURE DATA, clearly
 *     labeled as such throughout this script's output. This repository
 *     does not yet have enough real accumulated task history to show a
 *     meaningful A-vs-B difference from genuine production runs — rather
 *     than fabricate a "real" demo, this script is explicit that the
 *     agents, tasks, and outcomes below are synthetic, built only to
 *     demonstrate the algorithm's behavior.
 *   - Nothing here is historical production data. Nothing here is shown
 *     as evidence of real-world reliability for any real agent.
 *
 * Writes to and then deletes a few rows (ids prefixed `_demo_trust_`) in
 * whatever DATABASE_URL is configured — intended for the local disposable
 * Postgres container, not production.
 *
 * This script imports lib/adaptive-trust.ts, which imports lib/prisma.ts —
 * that shared singleton builds its pg.Pool from process.env.DATABASE_URL at
 * MODULE LOAD TIME, and ES module imports are hoisted above any top-level
 * code in this file. So DATABASE_URL must already be in the environment
 * BEFORE tsx starts — an in-script dotenv call here would run too late.
 * Run directly, not plain `npx tsx ...` without sourcing env first:
 *   set -a; source .env.local; set +a; npx tsx scripts/demo-adaptive-trust.ts
 *
 * `npm run demo:adaptive-trust` does the env-sourcing for you, but under
 * heavy host load `npm run`'s own process-spawning overhead can be enough
 * to push the FIRST cold Postgres connection past lib/prisma.ts's 5s
 * connectionTimeoutMillis (observed directly during development — the
 * exact same command run via bash directly, bypassing npm, connects
 * immediately every time). This script retries 3x for that reason; if it
 * still fails under `npm run`, prefer the direct bash command above.
 */

import { prisma } from "../lib/prisma";
import { selectBestAgent, type AgentCandidate } from "../lib/agent-selector";
import { getAdvisoryRecommendation } from "../lib/adaptive-trust";

const PREFIX = "_demo_trust_";
const PROJECT_ID = `${PREFIX}project`;
const SERVER_ID = `${PREFIX}server`;
const RELIABLE_AGENT_ID = `${PREFIX}agent_reliable`;
const UNRELIABLE_AGENT_ID = `${PREFIX}agent_unreliable`;

function line() {
  console.log("-".repeat(78));
}

async function seed() {
  await prisma.project.upsert({
    where: { id: PROJECT_ID },
    create: { id: PROJECT_ID, name: "[SYNTHETIC] Adaptive Trust demo", priority: "P4", status: "active" },
    update: {},
  });
  await prisma.server.upsert({
    where: { id: SERVER_ID },
    create: { id: SERVER_ID, name: "[SYNTHETIC] demo server", host: "127.0.0.1", username: "demo", sshKeyPath: "/dev/null" },
    update: {},
  });

  for (const [id, name] of [
    [RELIABLE_AGENT_ID, "[SYNTHETIC] reliable-agent"],
    [UNRELIABLE_AGENT_ID, "[SYNTHETIC] unreliable-agent"],
  ] as const) {
    await prisma.agent.upsert({
      where: { id },
      create: { id, serverId: SERVER_ID, name, slug: id, workDir: "/tmp", tmuxSession: id, status: "idle" },
      update: { status: "idle" },
    });
  }

  // Reliable agent: 5 independently-verified successes, 0 failures.
  for (let i = 0; i < 5; i++) {
    const taskId = `${PREFIX}reliable_task_${i}`;
    await prisma.task.upsert({
      where: { id: taskId },
      create: {
        id: taskId, projectId: PROJECT_ID, agentId: RELIABLE_AGENT_ID,
        title: `[SYNTHETIC] task ${i}`, priority: "P4", status: "completed",
        taskType: "coding", estimatedCostLevel: "low", isAutonomous: true,
        validationStatus: "passed",
      },
      update: {},
    });
    await prisma.auditEvent.create({
      data: { entityType: "task", entityId: taskId, eventType: "task.validation_passed", actorType: "poller", payload: {} },
    });
  }

  // Unreliable agent: 2 successes, 1 honest failure, 2 CAUGHT LIES
  // (false positives) — the exact scenario the demo is built to surface.
  const outcomes: Array<["passed"] | ["failed", string]> = [
    ["passed"], ["passed"],
    ["failed", "validation_block_reported_failed"],
    ["failed", "independent_check_disagreed"],
    ["failed", "independent_check_disagreed"],
  ];
  for (let i = 0; i < outcomes.length; i++) {
    const taskId = `${PREFIX}unreliable_task_${i}`;
    const [status, reason] = outcomes[i];
    await prisma.task.upsert({
      where: { id: taskId },
      create: {
        id: taskId, projectId: PROJECT_ID, agentId: UNRELIABLE_AGENT_ID,
        title: `[SYNTHETIC] task ${i}`, priority: "P4",
        status: status === "passed" ? "completed" : "failed",
        taskType: "coding", estimatedCostLevel: "low", isAutonomous: true,
        validationStatus: status,
      },
      update: {},
    });
    await prisma.auditEvent.create({
      data: {
        entityType: "task", entityId: taskId,
        eventType: status === "passed" ? "task.validation_passed" : "task.validation_failed",
        actorType: "poller",
        payload: reason ? { reason } : {},
      },
    });
  }
}

/** A cold local Postgres connection can occasionally miss Postgres's
 *  authentication_timeout under heavy host load (observed directly via
 *  `docker logs` during this feature's development: "FATAL: canceling
 *  authentication due to timeout") — retry once with a short backoff before
 *  giving up, since a warm connection pool recovers immediately afterward. */
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

async function cleanup() {
  await prisma.auditEvent.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } });
}

async function main() {
  console.log("=== Adaptive Trust Engine demo — SYNTHETIC FIXTURE DATA, not real production history ===\n");

  await withRetry(cleanup); // idempotent — clear any leftover from a prior interrupted run
  await seed();

  const candidates: AgentCandidate[] = [
    { id: RELIABLE_AGENT_ID, name: "reliable-agent", tags: [], status: "idle", healthScore: 100, activeTaskCount: 0, maxConcurrentTasks: 5, claudeSessionPct: 0, claudeWeekPct: 0, pausedDueToUsage: false, cooldownUntil: null },
    { id: UNRELIABLE_AGENT_ID, name: "unreliable-agent", tags: [], status: "idle", healthScore: 100, activeTaskCount: 0, maxConcurrentTasks: 5, claudeSessionPct: 0, claudeWeekPct: 0, pausedDueToUsage: false, cooldownUntil: null },
  ];

  line();
  console.log("A. EXISTING routing recommendation (lib/agent-selector.ts, unmodified):");
  const direct = selectBestAgent(candidates, { requiredTags: [] });
  console.log(`   production pick: ${direct.agentId}`);
  for (const s of direct.scores) console.log(`   - ${s.agentName}: eligible=${s.eligible} score=${s.score} (${s.reasons.join("; ")})`);
  console.log("   Note: both agents are equally healthy/idle/untagged, so the existing");
  console.log("   scorer alone cannot distinguish them — it has no reliability signal.");

  line();
  console.log("B. RELIABILITY-INFORMED advisory (lib/adaptive-trust.ts, SHADOW/ADVISORY mode):");
  const advisory = await getAdvisoryRecommendation(candidates, { requiredTags: [], taskType: "coding" });
  console.log(`   production pick (UNCHANGED from A — advisory never overrides dispatch): ${advisory.productionPick}`);
  console.log(`   flaggedForReview: ${advisory.flaggedForReview}`);
  console.log(`   advisory note: ${advisory.advisoryNote}`);
  for (const c of advisory.candidates) {
    if (!c.reliability) continue;
    console.log(`   - ${c.score.agentName}: verdict=${c.reliability.verdict} score=${c.reliability.score} n=${c.reliability.sampleSize}`);
    console.log(`     ${c.reliability.explanation}`);
  }

  line();
  console.log("Reliability detail for the UNRELIABLE synthetic agent (caught lies, not just failures):");
  const unreliableDetail = advisory.candidates.find((c) => c.score.agentId === UNRELIABLE_AGENT_ID)?.reliability;
  console.log(JSON.stringify(unreliableDetail?.counts, null, 2));

  await cleanup();
  await prisma.$disconnect();

  console.log("\n[demo-adaptive-trust] done — all synthetic fixture rows removed.");
}

main().catch(async (err) => {
  console.error("[demo-adaptive-trust] FAILED:", err);
  await cleanup().catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
