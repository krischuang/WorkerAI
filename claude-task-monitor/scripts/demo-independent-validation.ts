/**
 * Demo Day scenario — proves the completion gate does not trust an agent's
 * self-report alone.
 *
 * What this script actually does (all real, nothing mocked):
 *   1. Creates an isolated git repo in the OS temp directory (never touches
 *      this project's repo or any production system).
 *   2. Commits a baseline, then makes a code change and an intentionally
 *      FAILING test — simulating an agent that did some work but broke
 *      something.
 *   3. Writes a tmux-pane-style [WORKERAI_VALIDATION] block claiming
 *      `result: passed` — simulating an agent that (incorrectly, or
 *      dishonestly) self-reports success.
 *   4. Calls the real `runIndependentValidation` from lib/validation-gate.ts
 *      against that repo — the same function wired into the production
 *      completion poller (instrumentation.node.ts) — and captures real exit
 *      codes, stdout/stderr, timestamps, and a git diff.
 *   5. Shows that the independent result disagrees with the agent's
 *      self-report, which is exactly the condition that flips
 *      applyValidationGate()'s verdict from "completed" to "failed" (see the
 *      "disagrees" test cases in lib/__tests__/validation-gate.test.ts for
 *      the gate decision itself, proven under real test conditions).
 *
 * What this script does NOT do: it does not connect to any real server over
 * SSH, does not touch the project's Postgres database, and does not require
 * any production credentials. The dispatch/kill-switch/policy-engine gate in
 * front of this (lib/task-dispatch.ts) is covered separately by
 * lib/__tests__/task-dispatch.test.ts.
 *
 * Run with:  npx tsx scripts/demo-independent-validation.ts
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runIndependentValidation } from "../lib/validation-gate";

const TASK_ID = "demo-task-1";
const NONCE = "demo-nonce-xyz";

function sh(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function section(title: string) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

async function main() {
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workerai_demo_"));
  console.log(`[setup] isolated demo repo: ${demoDir}`);

  section("STEP 1 — Task created, isolated workspace provisioned");
  sh("git init -q", demoDir);
  sh('git config user.email "demo@workerai.local"', demoDir);
  sh('git config user.name "WorkerAI Demo"', demoDir);

  fs.writeFileSync(
    path.join(demoDir, "package.json"),
    JSON.stringify(
      {
        name: "demo-repo",
        private: true,
        scripts: {
          lint: "node -e \"process.exit(0)\"",
          typecheck: "node -e \"process.exit(0)\"",
          test: "node test.js",
          build: "node -e \"process.exit(0)\"",
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(demoDir, "add.js"),
    "function add(a, b) { return a + b; }\nmodule.exports = { add };\n",
  );
  fs.writeFileSync(
    path.join(demoDir, "test.js"),
    [
      "const assert = require('assert');",
      "const { add } = require('./add');",
      "assert.strictEqual(add(2, 2), 4, 'add(2,2) should be 4');",
      "console.log('1 passing');",
    ].join("\n"),
  );
  sh("git add -A", demoDir);
  sh('git commit -q -m "baseline: add() with passing test"', demoDir);
  console.log("[task] title: \"Fix add() to also support strings\" — assigned to agent demo-agent-1");

  section("STEP 2 — Agent selection + SSH dispatch (simulated — no real SSH/Claude in this sandbox)");
  console.log("[dispatch] tryDispatchTaskToAgent() path: kill-switch check -> risk/policy gate -> tmux send");
  console.log("[dispatch] NOT exercised live here (no reachable worker / no production SSH credentials).");
  console.log("[dispatch] That gate logic is proven separately in lib/__tests__/task-dispatch.test.ts (real code, mocked transport).");

  section("STEP 3 — Claude execution + git changes (simulated agent edit)");
  // Simulate the agent's work: it changes add() but breaks the existing test.
  fs.writeFileSync(
    path.join(demoDir, "add.js"),
    "function add(a, b) { return `${a}${b}`; }\nmodule.exports = { add };\n",
  );
  console.log("[agent] edited add.js (introduced a regression: add() now concatenates instead of summing)");

  const paneText = [
    "[WORKERAI_VALIDATION]",
    `taskId: ${TASK_ID}`,
    `nonce: ${NONCE}`,
    "result: passed",
    "evidence: npm test: 1 passing",
    "[/WORKERAI_VALIDATION]",
  ].join("\n");
  console.log("[agent] self-reported completion:\n" + paneText.split("\n").map((l) => "    " + l).join("\n"));

  section("STEP 4 — Independent validation (REAL commands, REAL exit codes)");
  const result = await runIndependentValidation({ sshConfig: null, workspaceDir: demoDir });

  for (const c of result.commands) {
    console.log(`  [${c.label}] command="${c.command}" exitCode=${c.exitCode} duration=${c.durationMs}ms`);
    if (c.exitCode !== 0) {
      console.log(`    stdout: ${c.stdoutSummary.replace(/\n/g, "\\n")}`);
      console.log(`    stderr: ${c.stderrSummary.replace(/\n/g, "\\n")}`);
    }
  }
  console.log(`\n  git diff --stat:\n${(result.gitDiffStat ?? "").split("\n").map((l) => "    " + l).join("\n")}`);
  console.log(`  git status --short:\n${(result.gitStatusShort ?? "").split("\n").map((l) => "    " + l).join("\n")}`);

  section("STEP 5 — Verdict");
  const agentSaidPassed = true; // parsed from the [WORKERAI_VALIDATION] block above
  const independentlyPassed = result.allPassed;
  console.log(`  agent self-report:        ${agentSaidPassed ? "PASSED" : "FAILED"}`);
  console.log(`  independent re-execution: ${independentlyPassed ? "PASSED" : "FAILED"}`);

  if (agentSaidPassed && !independentlyPassed) {
    console.log(
      "\n  RESULT: independent check disagrees with the agent's self-report.\n" +
      "  applyValidationGate() would mark this task FAILED (not completed) and create\n" +
      "  an English-language follow-up task carrying this exact evidence — see the\n" +
      "  \"does not trust a passing agent report\" test in lib/__tests__/validation-gate.test.ts.",
    );
  } else {
    console.log("\n  RESULT: independent check agrees with the agent's self-report — task would complete.");
  }

  const report = {
    scenario: "independent-validation-disagrees-with-agent-self-report",
    taskId: TASK_ID,
    demoRepoPath: demoDir,
    agentSelfReport: { status: "passed", evidence: "npm test: 1 passing" },
    independentValidation: result,
    finalVerdict: agentSaidPassed && !independentlyPassed ? "failed" : "passed",
    generatedAt: new Date().toISOString(),
  };
  const reportPath = path.join(demoDir, "demo-validation-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n[report] full evidence written to ${reportPath}`);
  console.log(`[cleanup] demo repo left in place for inspection: ${demoDir}`);
}

main().catch((err) => {
  console.error("[demo] failed:", err);
  process.exit(1);
});
