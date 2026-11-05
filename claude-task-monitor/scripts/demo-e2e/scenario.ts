/**
 * Demo Day real end-to-end scenario — the production code paths, driven
 * against a disposable local worker + disposable local database.
 *
 * This file assumes it is launched as a child process with these env vars
 * already set by run.ts: DATABASE_URL, SSH_KEY_ALLOWED_PATHS, DEMO_SSH_PORT,
 * DEMO_SSH_KEY_PATH.
 *
 * Every step below calls real production functions — lib/task-dispatch.ts,
 * lib/kill-switch.ts, lib/policy-engine.ts, lib/validation-gate.ts,
 * lib/ssh.ts — against a real SSH connection and a real (disposable)
 * Postgres database. Nothing here is mocked. The only stand-in is the
 * "claude" process inside the worker's tmux session (see fake-claude.sh),
 * which is clearly labeled wherever it shows up in this report.
 *
 * Nothing in this script touches production: the Server row points at
 * 127.0.0.1 on a disposable container, the key pair is generated fresh per
 * run, and DATABASE_URL points at a disposable local Postgres container.
 *
 * Covers the 12-scenario E2E matrix from the Demo Day security pass. Items
 * NOT covered live here (database-failure fail-closed, command timeout) are
 * unit-tested instead — see lib/__tests__/kill-switch.test.ts ("fails closed
 * when the database is unavailable") and lib/__tests__/validation-gate.test.ts
 * ("validation timeout"). Orchestrating a live mid-scenario DB outage or a
 * real multi-minute timeout inside this disposable demo was judged not worth
 * the added runtime/fragility versus the unit-level proof already in place —
 * documented as NOT VERIFIED at the live-E2E level in the final audit.
 */

import * as fs from "fs";
import * as path from "path";
import { execSSH } from "../../lib/ssh";
import { detectValidationBlock } from "../../lib/usage-parser";
import { detectTaskCompletion } from "../../lib/ssh-claude-tmux";

const SSH_PORT = parseInt(process.env.DEMO_SSH_PORT!, 10);
const SSH_KEY_PATH = process.env.DEMO_SSH_KEY_PATH!;
const REPO_DIR = "/home/demo/workspace/repo";
const TMUX_SESSION = "claude-demo";

const sshConfig = { host: "127.0.0.1", port: SSH_PORT, username: "demo", sshKeyPath: SSH_KEY_PATH };

type StepLog = { step: string; startedAt: string; finishedAt: string; detail: unknown };
const steps: StepLog[] = [];

async function record<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const startedAt = new Date().toISOString();
  console.log(`\n--- ${step} ---`);
  const detail = await fn();
  const finishedAt = new Date().toISOString();
  steps.push({ step, startedAt, finishedAt, detail });
  return detail as T;
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // Import production modules only after env vars are confirmed set, since
  // lib/prisma.ts reads process.env.DATABASE_URL at module load time.
  const { prisma } = await import("../../lib/prisma");
  const { tryDispatchTaskToServer } = await import("../../lib/task-dispatch");
  const { activateKillSwitch, deactivateKillSwitch } = await import("../../lib/kill-switch");
  const { applyValidationGate } = await import("../../lib/validation-gate");
  const { evaluatePolicy } = await import("../../lib/policy-engine");

  // ── Step 0 — clean any previous demo run ──────────────────────────────────
  await record("Step 0: clean previous demo data", async () => {
    const prev = await prisma.project.findFirst({ where: { name: "Demo Day E2E" } }).catch(() => null);
    if (prev) {
      await prisma.executionLog.deleteMany({ where: { task: { projectId: prev.id } } });
      await prisma.task.deleteMany({ where: { projectId: prev.id } });
      await prisma.server.deleteMany({ where: { tasks: { some: { projectId: prev.id } } } });
      await prisma.project.delete({ where: { id: prev.id } });
    }
    return { cleaned: !!prev };
  });

  // ── Step 1 — real task creation ────────────────────────────────────────────
  const project = await record("Step 1a: create Project (real DB row)", () =>
    prisma.project.create({
      data: { name: "Demo Day E2E", description: "Disposable scenario for the Nov 7 demo", priority: "P1", status: "active" },
    }),
  );

  const server = await record("Step 1b: register Server + verify SSH connectivity (real SSH)", async () => {
    const created = await prisma.server.create({
      data: {
        name: "demo-worker (disposable, localhost-only)",
        host: "127.0.0.1",
        port: SSH_PORT,
        username: "demo",
        sshKeyPath: SSH_KEY_PATH,
        tmuxSession: TMUX_SESSION,
        claudePermissionMode: "workspace_write",
      },
    });
    const probe = await execSSH(sshConfig, "whoami && hostname").catch((e) => ({ stdout: "", stderr: String(e), exitCode: -1 }));
    const connected = probe.exitCode === 0 || probe.stdout.includes("demo");
    await prisma.server.update({ where: { id: created.id }, data: { status: connected ? "connected" : "failed", lastCheckedAt: new Date() } });
    return { serverId: created.id, connected, probeStdout: probe.stdout.trim() };
  });

  /** Resets the shared demo repo to a clean baseline between tasks, so each
   *  task's git diff/status is isolated rather than cumulative. */
  async function resetRepo() {
    await execSSH(sshConfig, `cd ${REPO_DIR} && git checkout -- . && git clean -fd`, 10_000);
  }

  /** Dispatches one task to the real worker, waits for real completion
   *  detection, runs the real validation gate, and captures real git
   *  evidence — the shared core of every positive/negative scenario below. */
  async function dispatchAndValidate(opts: {
    label: string;
    title: string;
    description: string;
    riskLevel: "low" | "medium" | "high";
    isAutonomous: boolean;
  }) {
    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        serverId: server.serverId,
        title: opts.title,
        description: opts.description,
        priority: "P1",
        status: "queued",
        taskType: "coding",
        isAutonomous: opts.isAutonomous,
        riskLevel: opts.riskLevel,
      },
    });

    const dispatch = await tryDispatchTaskToServer({
      taskId: task.id,
      serverId: server.serverId,
      sshConfig,
      tmuxSession: TMUX_SESSION,
      permissionMode: "workspace_write",
      task: { title: task.title, description: task.description, isAutonomous: opts.isAutonomous },
      logText: `Demo Day dispatch — ${opts.label}`,
    });

    if (!dispatch.ok) {
      return { task, dispatch, completion: null, gate: null, gitEvidence: null };
    }

    const refreshed = await prisma.task.findUnique({
      where: { id: task.id },
      select: { completionNonce: true, tmuxOutputOffset: true },
    });
    const nonce = refreshed!.completionNonce!;
    const tmuxOutputOffset = refreshed!.tmuxOutputOffset ?? undefined;

    // Reuses the exact production completion detector (offset-protected, see
    // lib/ssh-claude-tmux.ts) — never a naive full-pane text match.
    const deadline = Date.now() + 20_000;
    let result = await detectTaskCompletion(sshConfig, TMUX_SESSION, task.id, nonce, tmuxOutputOffset);
    while (!result.completed && Date.now() < deadline) {
      await sleep(1000);
      result = await detectTaskCompletion(sshConfig, TMUX_SESSION, task.id, nonce, tmuxOutputOffset);
    }
    const validation = detectValidationBlock(result.paneText, task.id, nonce);
    const completion = {
      found: result.markerFound,
      completed: result.completed,
      validation,
      paneText: result.paneText,
      paneTail: result.paneText.split("\n").slice(-25).join("\n"),
    };

    const gate = await applyValidationGate({
      taskId: task.id,
      projectId: project.id,
      title: task.title,
      isAutonomous: opts.isAutonomous,
      paneText: completion.paneText,
      expectedNonce: nonce,
      sshConfig,
      workspaceDir: REPO_DIR,
    });
    if (gate.allowed) {
      await prisma.task.update({ where: { id: task.id }, data: { status: "completed" } });
    }

    const diff = await execSSH(sshConfig, `cd ${REPO_DIR} && git diff --stat`, 10_000);
    const status = await execSSH(sshConfig, `cd ${REPO_DIR} && git status --short --ignored=matching`, 10_000);
    const gitEvidence = { diff: diff.stdout.trim(), status: status.stdout.trim() };

    return { task, dispatch, completion, gate, gitEvidence };
  }

  // ── Step 2-5 — Task 1: happy path (REAL dispatch, REAL fix, REAL independent pass) ──
  const task1 = await record("Step 2-5: Task 1 — real dispatch, real fix, independent verification", () =>
    dispatchAndValidate({
      label: "happy path",
      title: "Add subtract() to math.js with a passing test",
      description: "Implement subtract(a, b) in math.js and add a test asserting subtract(5, 3) === 2.",
      riskLevel: "low",
      isAutonomous: true,
    }),
  );

  await record("Step 5b: reset demo repo to clean baseline", resetRepo);

  // ── Step 6 — negative: agent lies about passing, independent check disagrees ──
  const task2 = await record("Step 6: Task 2 [LYING_AGENT] — self-reports passed, real test still fails", () =>
    dispatchAndValidate({
      label: "lying agent",
      title: "Add subtract() to math.js with a passing test [LYING_AGENT]",
      description: "Negative scenario — fake-claude.sh makes a broken fix but self-reports success anyway.",
      riskLevel: "low",
      isAutonomous: true,
    }),
  );

  await record("Step 6b: reset demo repo to clean baseline", resetRepo);

  // ── Step 7 — negative: agent touches a gitignored .env file ────────────────
  const task3 = await record("Step 7: Task 3 [TOUCHES_ENV] — agent writes to a gitignored .env file", () =>
    dispatchAndValidate({
      label: "touches .env",
      title: "Add subtract() to math.js with a passing test [TOUCHES_ENV]",
      description: "Negative scenario — fake-claude.sh makes a correct fix but also writes to .env, out of scope.",
      riskLevel: "low",
      isAutonomous: true,
    }),
  );

  await record("Step 7b: reset demo repo to clean baseline", resetRepo);

  // ── Step 8 — unsafe task (isAutonomous + high risk) is blocked pre-dispatch ──
  const unsafeTask = await record("Step 8: create a high-risk autonomous task and attempt dispatch", async () => {
    const created = await prisma.task.create({
      data: {
        projectId: project.id,
        serverId: server.serverId,
        title: "Rotate production database credentials",
        description: "Simulated high-risk operation for the demo — must be blocked pre-dispatch.",
        priority: "P1",
        status: "queued",
        taskType: "maintenance",
        isAutonomous: true,
        riskLevel: "high",
      },
    });
    const outcome = await tryDispatchTaskToServer({
      taskId: created.id,
      serverId: server.serverId,
      sshConfig,
      tmuxSession: TMUX_SESSION,
      permissionMode: "workspace_write",
      task: { title: created.title, description: created.description, isAutonomous: true },
      logText: "Demo Day — expected to be blocked",
    });
    return { taskId: created.id, outcome };
  });

  // ── Step 9 — a non-autonomous high-risk task requires approval instead ─────
  // The hard isAutonomous+high-risk gate in task-dispatch.ts only applies to
  // the autonomous pipeline. A human-created high-risk task reaches the
  // policy engine's own require_approval decision instead (builtin:
  // approve-high-risk) — distinct code path, distinct real assertion.
  const approvalTask = await record("Step 9: create a human-created high-risk task — requires approval, not a hard block", async () => {
    const created = await prisma.task.create({
      data: {
        projectId: project.id,
        serverId: server.serverId,
        title: "Manually-triggered high-risk maintenance",
        description: "Human-created, so the hard autonomous block does not apply — the policy engine's require_approval path does.",
        priority: "P2",
        status: "queued",
        taskType: "maintenance",
        isAutonomous: false,
        riskLevel: "high",
      },
    });
    const outcome = await tryDispatchTaskToServer({
      taskId: created.id,
      serverId: server.serverId,
      sshConfig,
      tmuxSession: TMUX_SESSION,
      permissionMode: "workspace_write",
      task: { title: created.title, description: created.description, isAutonomous: false },
      logText: "Demo Day — expected to require approval",
    });
    return { taskId: created.id, outcome };
  });

  // ── Step 10 — policy engine denies a secret-file edit directly ─────────────
  const policyDeny = await record("Step 10: policy engine — secret file edit (direct evaluatePolicy check)", async () => {
    const result = await evaluatePolicy({
      taskId: task1.task.id,
      category: "file_change",
      filePaths: [".env"],
    });
    return result;
  });

  // ── Step 11 — kill switch halts dispatch (REAL, against the disposable DB) ─
  const killSwitchTest = await record("Step 11: activate kill switch, attempt dispatch, deactivate", async () => {
    await activateKillSwitch({ reason: "manual_stop", detail: "Demo Day kill-switch test", activatedBy: "demo-script" });

    const normalTask = await prisma.task.create({
      data: {
        projectId: project.id, serverId: server.serverId,
        title: "Low-risk task dispatched while kill switch is active",
        priority: "P3", status: "queued", taskType: "maintenance",
        isAutonomous: false, riskLevel: "low",
      },
    });
    const outcomeWhileHalted = await tryDispatchTaskToServer({
      taskId: normalTask.id, serverId: server.serverId, sshConfig, tmuxSession: TMUX_SESSION,
      permissionMode: "workspace_write",
      task: { title: normalTask.title, isAutonomous: false },
      logText: "Demo Day — expected to be blocked by kill switch",
    });

    await deactivateKillSwitch({ deactivatedBy: "demo-script", detail: "Demo Day kill-switch test complete" });
    return { taskId: normalTask.id, outcomeWhileHalted };
  });

  // ── Step 12 — execution results are auditable (REAL AuditEvent rows) ───────
  const auditTrail = await record("Step 12: query real AuditEvent rows for Task 1", async () => {
    const events = await prisma.auditEvent.findMany({
      where: { entityId: task1.task.id },
      select: { eventType: true, actorType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    return { eventTypes: events.map((e) => e.eventType), count: events.length };
  });

  await writeReport({
    project, server, task1, task2, task3, unsafeTask, approvalTask, policyDeny, killSwitchTest, auditTrail, steps,
  });

  // ── Acceptance assertions — hard-fail (non-zero exit) on any mismatch ──────
  // A printed summary is not evidence by itself: these are real assertions
  // against the real captured results above, not a description of intent.
  const assertions: { name: string; pass: boolean; detail?: string }[] = [
    {
      name: "Task 1 was successfully dispatched to the selected server",
      pass: task1.dispatch.ok === true,
      detail: JSON.stringify(task1.dispatch),
    },
    {
      name: "the correct server was selected (task.serverId matches the registered demo server)",
      pass: task1.task.serverId === server.serverId,
      detail: `task.serverId=${task1.task.serverId} server.serverId=${server.serverId}`,
    },
    {
      name: "a real completion marker was detected (post-dispatch, not echoed from the prompt)",
      pass: task1.completion?.found === true,
      detail: `markerFound=${task1.completion?.found}`,
    },
    {
      name: "the task's own validation block (not an echo) reported passed",
      pass: task1.completion?.validation.found === true && task1.completion?.validation.status === "passed",
      detail: `found=${task1.completion?.validation.found} status=${task1.completion?.validation.status}`,
    },
    {
      name: "independent re-execution actually ran and passed (INDEPENDENTLY_VERIFIED, not merely AGENT_REPORTED)",
      pass: task1.gate?.verificationState === "INDEPENDENTLY_VERIFIED",
      detail: `verificationState=${task1.gate?.verificationState} validationStatus=${task1.gate?.validationStatus}`,
    },
    {
      name: "Task 1 was actually marked completed",
      pass: task1.gate?.allowed === true,
      detail: `allowed=${task1.gate?.allowed}`,
    },
    {
      name: "a non-empty, expected git diff exists for Task 1 (math.js was actually changed)",
      pass: (task1.gitEvidence?.status.length ?? 0) > 0 && !!task1.gitEvidence?.status.includes("math.js") && (task1.gitEvidence?.diff.length ?? 0) > 0,
      detail: `status="${task1.gitEvidence?.status}"`,
    },
    {
      name: "Task 2 [LYING_AGENT]: a false 'passed' self-report does NOT result in completion",
      pass: task2.gate?.allowed === false && task2.gate?.verificationState === "VERIFICATION_FAILED",
      detail: `allowed=${task2.gate?.allowed} verificationState=${task2.gate?.verificationState}`,
    },
    {
      name: "Task 3 [TOUCHES_ENV]: a gitignored .env write is detected and blocks completion (live, via git --ignored=matching)",
      pass: task3.gate?.allowed === false && !!task3.gitEvidence?.status.includes(".env"),
      detail: `allowed=${task3.gate?.allowed} status="${task3.gitEvidence?.status}"`,
    },
    {
      name: "high-risk autonomous dispatch was blocked (hard gate, no approval path)",
      pass: unsafeTask.outcome.ok === false,
      detail: JSON.stringify(unsafeTask.outcome),
    },
    {
      name: "a human-created high-risk task requires approval rather than hard-blocking (distinct code path)",
      pass: approvalTask.outcome.ok === false && (approvalTask.outcome as { detail?: string }).detail === "policy_requires_approval",
      detail: JSON.stringify(approvalTask.outcome),
    },
    {
      name: "secret-file policy violation was denied (direct evaluatePolicy check)",
      pass: policyDeny.decision === "deny",
      detail: `decision=${policyDeny.decision}`,
    },
    {
      name: "kill switch blocked dispatch while active",
      pass: killSwitchTest.outcomeWhileHalted.ok === false,
      detail: JSON.stringify(killSwitchTest.outcomeWhileHalted),
    },
    {
      name: "execution results are auditable — real AuditEvent rows exist for Task 1, including dispatch and validation",
      pass: auditTrail.count > 0 && auditTrail.eventTypes.includes("task.dispatched") && auditTrail.eventTypes.includes("task.validation_passed"),
      detail: `eventTypes=${JSON.stringify(auditTrail.eventTypes)}`,
    },
  ];

  console.log("\n================ ACCEPTANCE ASSERTIONS ================");
  let allPassed = true;
  for (const a of assertions) {
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.name}${a.detail ? ` (${a.detail})` : ""}`);
    if (!a.pass) allPassed = false;
  }
  console.log("=========================================================\n");

  await prisma.$disconnect();

  if (!allPassed) {
    console.error("[demo-e2e] FAIL — one or more acceptance assertions did not hold. See above.");
    process.exit(1);
  }
  console.log("[demo-e2e] PASS — all acceptance assertions held.");
}

async function writeReport(data: unknown) {
  const reportPath = path.join(__dirname, "last-run-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(data, null, 2));
  console.log(`\n[report] full evidence written to ${reportPath}`);
}

main().catch(async (err) => {
  console.error("[demo-e2e] FAILED:", err);
  process.exit(1);
});
