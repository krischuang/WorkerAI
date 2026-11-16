/**
 * Seeds persistent, clearly-labeled SYNTHETIC fixtures for the /demo-day
 * showcase page. Unlike the other demo-*.ts scripts (which seed, run, and
 * clean up in one script invocation for a timed terminal demo), these
 * fixtures are meant to sit in the database and be read live, repeatedly,
 * by the /demo-day page through the real, existing, already-tested APIs:
 *
 *   GET /api/tasks/[id]                          (existing route)
 *   GET /api/audit?entityType=task&entityId=...  (existing route)
 *   GET /api/agents/[id]/compare?taskType=coding (existing route — calls the
 *                                                  real compareBaselineWithEvidencePreference)
 *
 * This script contains NO business logic of its own — it only creates rows.
 * All verification/recommendation logic stays in lib/, exercised for real
 * by the real API routes above when the page loads.
 *
 * Idempotent: safe to re-run (upserts). Run with --cleanup to remove
 * everything this script created.
 *
 * Usage:
 *   set -a; source .env.local; set +a; npx tsx scripts/seed-demo-day.ts
 *   set -a; source .env.local; set +a; npx tsx scripts/seed-demo-day.ts --cleanup
 */

import { prisma } from "../lib/prisma";

const PREFIX = "_demo_day_";
export const PROJECT_ID = `${PREFIX}project`;
const SERVER_ID = `${PREFIX}server`;
export const WEAK_AGENT_ID = `${PREFIX}a_weak`; // "a_" sorts first — baseline tie-break
export const STRONG_AGENT_ID = `${PREFIX}b_strong`;
export const HERO_TASK_ID = `${PREFIX}hero_task`;
export const SAFETY_ENTITY_ID = `${PREFIX}safety`;

// These four rows restate — as read-only audit rows, not new logic — the
// exact safety assertions captured from a real run in docs/DEMO_RUN_RECORD.md
// (lib/policy-engine.ts, lib/kill-switch.ts, lib/validation-gate.ts enforced
// over a real SSH/tmux dispatch). The /demo-day page reads them live through
// the existing, generic GET /api/audit route so the live Safety & Audit
// section never needs to switch to that markdown file on stage.
const SAFETY_ASSERTIONS: Array<{
  eventType: string;
  payload: { label: string; result: string; detail: string; source: string };
}> = [
  {
    eventType: "policy.high_risk_autonomous_blocked",
    payload: {
      label: "High-risk autonomous task",
      result: "BLOCKED",
      detail: "No approval path exists for a high-risk task created in autonomous mode — refused outright before dispatch.",
      source: "lib/policy-engine.ts",
    },
  },
  {
    eventType: "policy.high_risk_human_requires_approval",
    payload: {
      label: "High-risk human-created task",
      result: "APPROVAL REQUIRED",
      detail: "Same risk tier, different code path: a human-created high-risk task is held for explicit approval instead of being blocked outright.",
      source: "lib/policy-engine.ts",
    },
  },
  {
    eventType: "policy.secret_file_edit_denied",
    payload: {
      label: "Secret-file edit",
      result: "DENIED",
      detail: "A workspace-write attempt touching a secret file (e.g. .env) is denied by the policy engine's path guard before it reaches disk.",
      source: "lib/policy-engine.ts",
    },
  },
  {
    eventType: "kill_switch.dispatch_refused",
    payload: {
      label: "Kill switch active",
      result: "DISPATCH REFUSED",
      detail: "With the kill switch on, dispatch is refused immediately; switching it off resumes normal operation. Enforced before dispatch, not logged after the fact.",
      source: "lib/kill-switch.ts",
    },
  },
];

async function cleanup() {
  await prisma.auditEvent.deleteMany({ where: { entityId: { startsWith: PREFIX } } });
  await prisma.task.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.agent.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.project.deleteMany({ where: { id: PROJECT_ID } });
}

async function main() {
  const doCleanup = process.argv.includes("--cleanup");
  if (doCleanup) {
    await cleanup();
    console.log("[seed-demo-day] cleanup complete — all synthetic fixture rows removed.");
    await prisma.$disconnect();
    return;
  }

  console.log("=== Seeding /demo-day fixtures — SYNTHETIC DEMO DATA ===\n");

  await prisma.project.upsert({
    where: { id: PROJECT_ID },
    create: { id: PROJECT_ID, name: "[SYNTHETIC] Demo Day Showcase", priority: "P4", status: "active" },
    update: {},
  });
  await prisma.server.upsert({
    where: { id: SERVER_ID },
    create: { id: SERVER_ID, name: "[SYNTHETIC] demo-day server", host: "127.0.0.1", username: "demo", sshKeyPath: "/dev/null" },
    update: {},
  });
  await prisma.agent.upsert({
    where: { id: WEAK_AGENT_ID },
    create: { id: WEAK_AGENT_ID, serverId: SERVER_ID, name: "[SYNTHETIC] agent-weak", slug: WEAK_AGENT_ID, workDir: "/tmp", tmuxSession: WEAK_AGENT_ID, status: "idle" },
    update: { status: "idle" },
  });
  await prisma.agent.upsert({
    where: { id: STRONG_AGENT_ID },
    create: { id: STRONG_AGENT_ID, serverId: SERVER_ID, name: "[SYNTHETIC] agent-strong", slug: STRONG_AGENT_ID, workDir: "/tmp", tmuxSession: STRONG_AGENT_ID, status: "idle" },
    update: { status: "idle" },
  });

  // Hero task — the lying-agent scenario shown in Sections 1 and 2. Assigned
  // to the weak agent, so Section 3's reliability gap is the direct,
  // visible consequence of exactly this kind of caught lie, not an
  // unrelated number.
  const heroEvidence = [
    "[WORKERAI_VALIDATION]",
    `taskId: ${HERO_TASK_ID}`,
    "nonce: demo-day-nonce",
    "result: passed",
    "evidence: npm test: 1 passing",
    "[/WORKERAI_VALIDATION]",
    "",
    "Independent re-execution (real commands, not the agent's word):",
    "  [test] npm test — exit 1",
    "    AssertionError: subtract(5, 3) should be 2",
    "    '53' !== 2",
    "",
    "Verdict: independent check disagrees with the agent's self-report.",
    "Completion blocked; a follow-up task is created carrying this exact evidence.",
  ].join("\n");

  await prisma.task.upsert({
    where: { id: HERO_TASK_ID },
    create: {
      id: HERO_TASK_ID,
      projectId: PROJECT_ID,
      agentId: WEAK_AGENT_ID,
      title: "[SYNTHETIC] Add subtract() to math.js with a passing test",
      description: "Demo Day showcase fixture — the agent claims success; independent re-execution disagrees.",
      priority: "P3",
      status: "failed",
      taskType: "coding",
      estimatedCostLevel: "low",
      isAutonomous: true,
      validationStatus: "failed",
      validationEvidence: heroEvidence,
    },
    update: {
      status: "failed",
      validationStatus: "failed",
      validationEvidence: heroEvidence,
    },
  });

  // Two more tasks for the weak agent (false positives — caught lies, same
  // shape as scripts/demo-evidence-preference.ts) and five for the strong
  // agent (clean verified completions) — this is what
  // compareBaselineWithEvidencePreference actually reads when Section 3's
  // real API call runs.
  const weakOutcomes: Array<["passed"] | ["failed", string]> = [
    ["failed", "independent_check_disagreed"],
    ["failed", "independent_check_disagreed"],
  ];
  for (let i = 0; i < weakOutcomes.length; i++) {
    const [status, reason] = weakOutcomes[i];
    const taskId = `${WEAK_AGENT_ID}_extra_${i}`;
    await prisma.task.upsert({
      where: { id: taskId },
      create: {
        id: taskId, projectId: PROJECT_ID, agentId: WEAK_AGENT_ID,
        title: `[SYNTHETIC] ${taskId}`, priority: "P4", status: "failed",
        taskType: "coding", estimatedCostLevel: "low", isAutonomous: true,
        validationStatus: status,
      },
      update: {},
    });
    await prisma.auditEvent.upsert({
      where: { id: `${taskId}_audit` },
      create: {
        id: `${taskId}_audit`, entityType: "task", entityId: taskId,
        eventType: "task.validation_failed", actorType: "poller",
        payload: reason ? { reason } : {},
      },
      update: {},
    });
  }
  await prisma.auditEvent.upsert({
    where: { id: `${HERO_TASK_ID}_audit` },
    create: {
      id: `${HERO_TASK_ID}_audit`, entityType: "task", entityId: HERO_TASK_ID,
      eventType: "task.validation_failed", actorType: "poller",
      payload: { reason: "independent_check_disagreed" },
    },
    update: {},
  });
  await prisma.auditEvent.upsert({
    where: { id: `${HERO_TASK_ID}_dispatch_audit` },
    create: {
      id: `${HERO_TASK_ID}_dispatch_audit`, entityType: "task", entityId: HERO_TASK_ID,
      eventType: "task.dispatched", actorType: "system", payload: {},
    },
    update: {},
  });

  for (let i = 0; i < 5; i++) {
    const taskId = `${STRONG_AGENT_ID}_extra_${i}`;
    await prisma.task.upsert({
      where: { id: taskId },
      create: {
        id: taskId, projectId: PROJECT_ID, agentId: STRONG_AGENT_ID,
        title: `[SYNTHETIC] ${taskId}`, priority: "P4", status: "completed",
        taskType: "coding", estimatedCostLevel: "low", isAutonomous: true,
        validationStatus: "passed",
      },
      update: {},
    });
    await prisma.auditEvent.upsert({
      where: { id: `${taskId}_audit` },
      create: {
        id: `${taskId}_audit`, entityType: "task", entityId: taskId,
        eventType: "task.validation_passed", actorType: "poller", payload: {},
      },
      update: {},
    });
  }

  // Safety & Audit section — read-only restatement of the real captured
  // assertions in docs/DEMO_RUN_RECORD.md, exposed through the existing
  // generic GET /api/audit route (entityType=task, entityId=SAFETY_ENTITY_ID).
  for (let i = 0; i < SAFETY_ASSERTIONS.length; i++) {
    const { eventType, payload } = SAFETY_ASSERTIONS[i];
    await prisma.auditEvent.upsert({
      where: { id: `${SAFETY_ENTITY_ID}_${i}` },
      create: {
        id: `${SAFETY_ENTITY_ID}_${i}`, entityType: "task", entityId: SAFETY_ENTITY_ID,
        eventType, actorType: "system", payload,
      },
      update: { payload },
    });
  }

  console.log(`Project:     ${PROJECT_ID}`);
  console.log(`Weak agent:  ${WEAK_AGENT_ID} (1 caught lie shown + 2 more = 3 total, matches demo-evidence-preference.ts's shape)`);
  console.log(`Strong agent: ${STRONG_AGENT_ID} (5 verified successes)`);
  console.log(`Hero task:   ${HERO_TASK_ID}`);
  console.log(`Safety:      ${SAFETY_ASSERTIONS.length} assertions under entityId=${SAFETY_ENTITY_ID}`);
  console.log("\n[seed-demo-day] done. Fixtures left in place for the /demo-day page.");
  console.log("Run with --cleanup to remove them when no longer needed.");
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[seed-demo-day] FAILED:", err);
  await prisma.$disconnect();
  process.exit(1);
});
