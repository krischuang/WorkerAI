/**
 * Demo Day — verifies the REAL Claude CLI execution path, not a stand-in.
 *
 * scripts/demo-e2e/fake-claude.sh is explicitly a scripted replacement for
 * Claude, used only to make the SSH/tmux dispatch mechanism reproducible on
 * demand. This script is the complement: it invokes the actual `claude` CLI
 * binary (`claude -p ...`, non-interactive/"print" mode) against an isolated,
 * disposable local demo project — no Docker, no SSH, no production system,
 * no WorkerAI credentials. It uses the real `buildDispatchPrompt` (the exact
 * prompt WorkerAI pastes into a worker's tmux session) and the real
 * `detectCompletionBlock` / `detectValidationBlock` / `runIndependentValidation`
 * production functions to check what Claude actually did — not what it
 * claims to have done.
 *
 * Requires the `claude` CLI to be installed and already authenticated in
 * this environment (same auth as any local Claude Code session — nothing
 * WorkerAI-specific). If `claude` is not available, this script reports
 * NOT VERIFIED and exits non-zero rather than faking a result.
 *
 * Costs a small, real amount (a few cents) because it makes one real,
 * bounded API call to complete a trivial coding task.
 *
 * Run with: npx tsx scripts/demo-e2e/verify-real-claude.ts
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { buildDispatchPrompt } from "../../lib/prompt-sanitiser";
import { detectCompletionBlock, detectValidationBlock } from "../../lib/usage-parser";
import { runIndependentValidation } from "../../lib/validation-gate";

const TASK_ID = "real-claude-demo-1";
const NONCE = "rc-" + Math.random().toString(16).slice(2);

function section(title: string) {
  console.log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
}

function sh(cmd: string, cwd: string) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function fail(reason: string): never {
  console.error(`\n[FAIL] ${reason}`);
  process.exit(1);
}

async function main() {
  section("STEP 0 — Check the real Claude CLI is available");
  let claudeVersion: string;
  try {
    claudeVersion = execSync("claude --version", { stdio: "pipe" }).toString().trim();
  } catch {
    console.error("[NOT VERIFIED] `claude` CLI is not installed/available in this environment.");
    console.error("Refusing to substitute a stand-in and report it as real Claude execution.");
    process.exit(1);
  }
  console.log(`claude CLI: ${claudeVersion}`);

  section("STEP 1 — Create an isolated, disposable demo project");
  const demoDir = fs.mkdtempSync(path.join(os.tmpdir(), "workerai_real_claude_"));
  console.log(`demo project: ${demoDir}`);

  sh("git init -q", demoDir);
  sh('git config user.email "demo@workerai.local"', demoDir);
  sh('git config user.name "WorkerAI Demo"', demoDir);
  fs.writeFileSync(
    path.join(demoDir, "package.json"),
    JSON.stringify(
      {
        name: "real-claude-demo",
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
    path.join(demoDir, "math.js"),
    "function add(a, b) { return a + b; }\nmodule.exports = { add };\n// TODO: implement multiply(a, b)\n",
  );
  fs.writeFileSync(
    path.join(demoDir, "test.js"),
    [
      "const assert = require('assert');",
      "const math = require('./math');",
      "assert.strictEqual(math.add(2, 2), 4, 'add(2,2) should be 4');",
      "assert.strictEqual(math.multiply(3, 4), 12, 'multiply(3,4) should be 12');",
      "console.log('2 passing');",
    ].join("\n"),
  );
  sh("git add -A", demoDir);
  sh('git commit -q -m "baseline: add() works, multiply() missing, test currently fails"', demoDir);

  // Sanity check: the baseline really is broken before Claude touches it.
  const baseline = spawnSync("node", ["test.js"], { cwd: demoDir, encoding: "utf8" });
  if (baseline.status === 0) fail("baseline test unexpectedly passed before any work — fixture is wrong");
  console.log("Confirmed: test.js fails before any work (multiply is missing), as intended.");

  section("STEP 2 — Build the real dispatch prompt (lib/prompt-sanitiser.ts)");
  const prompt = buildDispatchPrompt({
    title: "Implement multiply(a, b) in math.js so the existing test passes",
    description: "Add a multiply function exported from math.js. Do not modify test.js.",
    taskId: TASK_ID,
    nonce: NONCE,
    isAutonomous: true,
  });
  console.log(`Prompt built (${prompt.length} chars) — same function used for every real WorkerAI dispatch.`);

  section("STEP 3 — Invoke the REAL Claude CLI (claude -p, non-interactive)");
  console.log("Running `claude -p ...` against the disposable project. This makes a real, billed API call.");
  const started = Date.now();
  const result = spawnSync(
    "claude",
    ["-p", prompt, "--permission-mode", "bypassPermissions", "--output-format", "json"],
    { cwd: demoDir, encoding: "utf8", maxBuffer: 50 * 1024 * 1024, timeout: 180_000 },
  );
  const durationMs = Date.now() - started;

  if (result.error) fail(`failed to spawn claude CLI: ${result.error.message}`);
  if (result.status !== 0) {
    console.error(result.stderr);
    fail(`claude CLI exited with status ${result.status}`);
  }

  let parsed: { result?: string; total_cost_usd?: number; is_error?: boolean };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fail(`could not parse claude CLI JSON output: ${result.stdout.slice(0, 500)}`);
  }
  console.log(`claude CLI finished in ${durationMs}ms, cost=$${parsed.total_cost_usd ?? "?"}, is_error=${parsed.is_error ?? "?"}`);

  const claudeOutput = parsed.result ?? "";

  section("STEP 4 — Check for the real completion/validation blocks (production detectors)");
  const completionFound = detectCompletionBlock(claudeOutput, TASK_ID, NONCE);
  const validation = detectValidationBlock(claudeOutput, TASK_ID, NONCE);
  console.log(`completion block found: ${completionFound}`);
  console.log(`validation block: found=${validation.found} status=${validation.status} evidence=${validation.evidence}`);

  section("STEP 5 — Independently re-verify (REAL commands, not Claude's word)");
  const independent = await runIndependentValidation({ sshConfig: null, workspaceDir: demoDir });
  for (const c of independent.commands) {
    console.log(`  [${c.label}] exit=${c.exitCode} (${c.durationMs}ms)`);
  }
  console.log(`independent.allPassed = ${independent.allPassed}`);
  console.log(`changed files: ${independent.changedFiles.join(", ") || "(none)"}`);

  section("STEP 6 — Real git diff");
  const diff = execSync("git diff --stat", { cwd: demoDir }).toString().trim();
  console.log(diff || "(no diff)");

  section("ACCEPTANCE ASSERTIONS");
  const assertions: { name: string; pass: boolean }[] = [
    { name: "claude CLI ran successfully (exit 0, is_error=false)", pass: result.status === 0 && parsed.is_error !== true },
    { name: "a real completion marker was produced, matching taskId+nonce", pass: completionFound },
    { name: "independent re-execution actually passes (real exit codes)", pass: independent.allPassed },
    { name: "a non-empty, expected git diff exists (math.js changed)", pass: independent.changedFiles.includes("math.js") },
  ];

  let allPassed = true;
  for (const a of assertions) {
    console.log(`  [${a.pass ? "PASS" : "FAIL"}] ${a.name}`);
    if (!a.pass) allPassed = false;
  }

  const report = {
    scenario: "real-claude-cli-execution",
    taskId: TASK_ID,
    demoDir,
    claudeVersion,
    durationMs,
    costUsd: parsed.total_cost_usd ?? null,
    claudeOutput,
    completionFound,
    validation,
    independent,
    gitDiffStat: diff,
    assertions,
    allPassed,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(demoDir, "real-claude-report.json"), JSON.stringify(report, null, 2));
  console.log(`\n[report] written to ${path.join(demoDir, "real-claude-report.json")}`);
  console.log(`[note] demo project left at ${demoDir} for inspection.`);

  if (!allPassed) {
    console.error("\n[FAIL] one or more acceptance assertions failed — see above.");
    process.exit(1);
  }
  console.log("\n[PASS] real Claude CLI completed the task; independently verified.");
}

main().catch((err) => {
  console.error("[verify-real-claude] FAILED:", err);
  process.exit(1);
});
