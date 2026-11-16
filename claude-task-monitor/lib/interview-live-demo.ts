/**
 * Interview-only live demo: two REAL, separate local `claude` CLI processes
 * working a realistic backend engineering task (multi-tenant task-API
 * authorization), plus WorkerAI's own real independent verification
 * (lib/validation-gate.ts, unmodified, the exact function already wired
 * into the production completion poller).
 *
 * Flow: Agent A (Implementation Agent) fixes a real, deliberately seeded
 * tenant-isolation vulnerability in a disposable workspace, with real
 * Read/Edit/Write/Bash access. Agent B (Independent Reviewer) then
 * inspects the resulting code, not Agent A's reasoning, with Read/Bash
 * only (no Edit/Write, so it structurally cannot alter the submission).
 * WorkerAI's backend then independently re-runs the real acceptance tests
 * and that real exit code, not either agent's language, is the
 * authoritative verdict.
 *
 * Evidence hierarchy shown in the UI, matching lib/validation-gate.ts's
 * own vocabulary plus one addition for this demo's two-agent structure:
 *   SELF_REPORTED           : Agent A's own claim about its work
 *   REVIEWED                : Agent B's own claim after inspecting + running tests
 *   INDEPENDENTLY_VERIFIED  : backend's real npm test exit code is 0
 *   VERIFICATION_FAILED     : backend's real npm test exit code is non-zero
 *   NOT_VERIFIED            : backend could not run verification at all
 *
 * Safety (see docs/interview/LIVE-DEMO-README.md for the full writeup):
 *  - Runs only in a disposable OS-temp directory, created fresh per run.
 *  - Never passes --dangerously-skip-permissions. Agent A gets
 *    Read/Edit/Write/Bash (it is genuinely implementing), Agent B gets
 *    Read/Bash only (it must not edit the submission).
 *  - One run at a time, enforced by a single globalThis-held run slot
 *    (same HMR-safe pattern as lib/dispatch-lock.ts).
 *  - Hard per-agent timeout + an AbortController wired to the real child
 *    process, so Cancel and Reset actually kill the processes, not just
 *    hide them from the UI.
 */

import { spawn, execSync, type ChildProcess } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runIndependentValidation, type IndependentValidationResult } from "@/lib/validation-gate";

export type AgentId = "a" | "b";
export type RunStatus = "idle" | "running" | "done" | "cancelled" | "error";
export type AgentOutcomeStatus = "done" | "error" | "timeout" | "cancelled";
export type VerificationLabel =
  | "NOT_VERIFIED"
  | "INDEPENDENTLY_VERIFIED"
  | "VERIFICATION_FAILED";

export interface AgentEvent {
  seq: number;
  /** Which run this event belongs to. Lets a client (or a stale/zombie SSE
   *  connection left over from a previous run) detect and ignore events
   *  that no longer belong to the run it thinks it is watching. */
  runId: string;
  agent: AgentId | "system";
  kind: "status" | "text" | "tool_call" | "tool_result" | "final" | "error";
  text?: string;
  tool?: string;
  input?: unknown;
  isError?: boolean;
  costUsd?: number | null;
  durationMs?: number | null;
  timestamp: string;
}

/** The 5 explicit states requested for display: a single, always-defined
 *  value that never requires the UI to invent an ambiguous "not run"
 *  string, and never derives from either agent's own text, only from
 *  RunState.status and RunState.verificationLabel (the backend's real
 *  verdict). Pure function, exported for direct unit testing. */
export type DisplayVerificationStatus = "NOT_STARTED" | "RUNNING" | VerificationLabel;

export function deriveDisplayStatus(state: Pick<RunState, "status" | "verificationLabel">): DisplayVerificationStatus {
  if (state.status === "idle") return "NOT_STARTED";
  if (state.status === "running") return "RUNNING";
  // status is "done" | "cancelled" | "error" here. A cancelled or errored
  // run never reached independent verification, so it is NOT_VERIFIED
  // regardless of anything either agent said, same as the "done but
  // verdict missing" case.
  return state.verificationLabel ?? "NOT_VERIFIED";
}

export interface AgentOutcome {
  status: AgentOutcomeStatus;
  resultText: string | null;
  isError: boolean;
  costUsd: number | null;
  durationMs: number | null;
}

export interface RunState {
  runId: string;
  status: RunStatus;
  startedAt: string | null;
  workspaceDir: string | null;
  events: AgentEvent[];
  agentA: AgentOutcome | null;
  agentB: AgentOutcome | null;
  implementationDiff: string | null;
  backendVerdict: IndependentValidationResult | null;
  verificationLabel: VerificationLabel | null;
  errorMessage: string | null;
}

// Agent A genuinely implements (read, edit, run tests, possibly iterate),
// so it gets more time than a pure review.
const AGENT_A_TIMEOUT_MS = 180_000;
const AGENT_B_TIMEOUT_MS = 120_000;

export const SEED_DISCLOSURE =
  "This is a deliberately seeded interview fixture: a synthetic multi-tenant " +
  "task API with a real, reproducible cross-tenant authorization vulnerability. " +
  "All tenants, tasks, and data here are synthetic. There is no real customer " +
  "data and no production system involved. Neither agent wrote this vulnerability.";

export const REQUIREMENTS_MD = `# Task: Fix Tenant Isolation on GET /tasks

## Context
A security review flagged that \`tasks-api.js\`'s \`getTasks(user, query)\` handler
may allow a caller to read another tenant's tasks. All data here is synthetic
fixture data created for a live interview demonstration; there are no real
tenants, customers, or production systems involved.

## Acceptance criteria
1. A caller must only ever receive tasks belonging to their own authenticated
   tenant (\`user.tenantId\`).
2. A caller must NOT be able to access another tenant's tasks by supplying a
   different \`tenantId\` in the request (for example a query parameter), even
   if they pass one explicitly.
3. The existing positive-path test (a tenant reading its own tasks) must keep
   passing.
4. The existing negative-path test (a cross-tenant access attempt) must pass:
   the caller must be denied those tasks.

Run \`node test.js\` to check your work against both the positive and negative
test cases.
`;

// Mirrors scripts/demo-independent-validation.ts's convention: lint/typecheck/
// build are instant no-ops, test runs the real check, so the backend verdict
// can call the real runIndependentValidation() with its default command set
// unmodified. That allowlist rejects any command not in this fixed set, by
// design, so there is no custom-command override here either.
const PACKAGE_JSON = JSON.stringify(
  {
    name: "interview-live-demo-fixture",
    private: true,
    scripts: {
      lint: 'node -e "process.exit(0)"',
      typecheck: 'node -e "process.exit(0)"',
      test: "node test.js",
      build: 'node -e "process.exit(0)"',
    },
  },
  null,
  2,
);

// Deliberately vulnerable starting point: trusts a caller-supplied tenantId
// instead of deriving scope only from the authenticated user, the same class
// of bug this app's own lib/resource-access.ts and lib/service-account.ts
// exist to prevent in production (see docs/architecture.md section 4).
const TASKS_API_JS = `// In-memory "database" of tasks across multiple tenants (synthetic data only).
const TASKS = [
  { id: "t1", tenantId: "tenant-a", title: "Tenant A task 1" },
  { id: "t2", tenantId: "tenant-a", title: "Tenant A task 2" },
  { id: "t3", tenantId: "tenant-b", title: "Tenant B task 1" },
];

/**
 * GET /tasks handler.
 * \`user\` is the authenticated caller (derived from a real session in
 * production; here just a plain object: { tenantId }).
 * \`query\` is the raw request query/params the caller supplied.
 */
function getTasks(user, query) {
  // VULNERABLE: trusts the tenantId from the query string instead of the
  // authenticated user's own tenantId, letting any caller pass
  // ?tenantId=tenant-b and read another tenant's tasks.
  const tenantId = query.tenantId || user.tenantId;
  return TASKS.filter((t) => t.tenantId === tenantId);
}

module.exports = { getTasks, TASKS };
`;

const TEST_JS = `const assert = require("assert");
const { getTasks } = require("./tasks-api.js");

// Positive: a tenant can read its own tasks.
const ownTasks = getTasks({ tenantId: "tenant-a" }, {});
assert.ok(ownTasks.every((t) => t.tenantId === "tenant-a"), "tenant-a should only see its own tasks");
assert.strictEqual(ownTasks.length, 2, "tenant-a should see exactly its 2 tasks");

// Negative: tenant A must not be able to read tenant B's tasks by supplying
// a different tenantId, even as a query parameter.
const crossTenant = getTasks({ tenantId: "tenant-a" }, { tenantId: "tenant-b" });
assert.strictEqual(crossTenant.length, 0, "tenant-a must not be able to read tenant-b's tasks via a supplied tenantId param");

console.log("2 passing");
`;

const SCOPE_SYSTEM_PROMPT =
  "You are participating in a scoped, timed backend engineering exercise for a live " +
  "interview demo. Stay strictly within the current working directory. Do not attempt " +
  "to access, read, or modify anything outside it. Be concise.";

const AGENT_A_PROMPT =
  "You are implementing a backend fix in this directory. Read REQUIREMENTS.md for the " +
  "full acceptance criteria, then read tasks-api.js and test.js. Fix tasks-api.js so it " +
  "satisfies every acceptance criterion: tenant scope must be derived only from the " +
  "authenticated caller, never from a client-supplied value. Run the test suite yourself " +
  "with the Bash tool (node test.js) to check your work, and fix any failures you find " +
  "before finishing. Give a brief completion assessment of what you changed and why, and " +
  "end your reply with exactly one line: STATUS: COMPLETE or STATUS: INCOMPLETE.";

const AGENT_B_PROMPT =
  "You are an independent reviewer. Read REQUIREMENTS.md for the original acceptance " +
  "criteria, then independently inspect the current tasks-api.js and test.js in this " +
  "directory. You have not seen any other agent's reasoning, only the resulting code. " +
  "Check specifically whether the implementation derives tenant scope only from the " +
  "authenticated caller, or whether it still trusts any caller-supplied value. Run the " +
  "test suite yourself with the Bash tool (node test.js) to check for yourself. Do not " +
  "modify any files. End your reply with exactly one line: VERDICT: SATISFIES_REQUIREMENTS " +
  "or VERDICT: DOES_NOT_SATISFY_REQUIREMENTS.";

function freshState(): RunState {
  return {
    runId: "",
    status: "idle",
    startedAt: null,
    workspaceDir: null,
    events: [],
    agentA: null,
    agentB: null,
    implementationDiff: null,
    backendVerdict: null,
    verificationLabel: null,
    errorMessage: null,
  };
}

interface Store {
  state: RunState;
  controller: AbortController | null;
  children: ChildProcess[];
}

// globalThis-held singleton so it survives Next.js HMR module re-evaluation
// (same pattern as lib/dispatch-lock.ts's _serverDispatchLocks).
const g = globalThis as unknown as { _interviewLiveDemo?: Store };

function store(): Store {
  if (!g._interviewLiveDemo) {
    g._interviewLiveDemo = { state: freshState(), controller: null, children: [] };
  }
  return g._interviewLiveDemo;
}

export function getState(): RunState {
  return store().state;
}

/** Host-header check for this feature's "localhost only" requirement.
 *  Not a hard network boundary (Host is client-supplied), see the README's
 *  Known Limitations for what a real one would need. */
export function isLocalHost(hostHeader: string | null): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(":")[0];
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function cleanupWorkspace(dir: string | null) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

function createFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workerai_interview_"));
  fs.writeFileSync(path.join(dir, "package.json"), PACKAGE_JSON);
  fs.writeFileSync(path.join(dir, "tasks-api.js"), TASKS_API_JS);
  fs.writeFileSync(path.join(dir, "test.js"), TEST_JS);
  fs.writeFileSync(path.join(dir, "REQUIREMENTS.md"), REQUIREMENTS_MD);
  // A real git repo with a baseline commit of the vulnerable starting state,
  // so the implementation diff (git diff against that baseline) and
  // runIndependentValidation's git evidence collection both work for real,
  // same reason scripts/demo-independent-validation.ts does this.
  try {
    execSync("git init -q", { cwd: dir });
    execSync('git config user.email "interview-demo@workerai.local"', { cwd: dir });
    execSync('git config user.name "WorkerAI Interview Demo"', { cwd: dir });
    execSync("git add -A && git commit -q -m baseline-vulnerable-fixture", { cwd: dir });
  } catch {
    // best-effort; runIndependentValidation already tolerates a missing git repo
  }
  return dir;
}

/** Real `git diff` against the baseline commit, captured directly from the
 *  process, not from either agent's description of its own changes. */
function captureImplementationDiff(dir: string): string | null {
  try {
    const diff = execSync("git diff", { cwd: dir, encoding: "utf8" });
    return diff.trim() || "(no changes: the file is byte-identical to the vulnerable baseline)";
  } catch (err) {
    return `(could not capture diff: ${err instanceof Error ? err.message : String(err)})`;
  }
}

function pushEvent(partial: Omit<AgentEvent, "seq" | "timestamp" | "runId">) {
  const s = store();
  const seq = s.state.events.length;
  s.state.events.push({ ...partial, seq, runId: s.state.runId, timestamp: new Date().toISOString() });
}

export function getSourceFiles(): {
  tasksApiJs: string;
  testJs: string;
  packageJson: string;
  requirementsMd: string;
  disclosure: string;
} | null {
  const dir = store().state.workspaceDir;
  if (!dir) return null;
  try {
    return {
      tasksApiJs: fs.readFileSync(path.join(dir, "tasks-api.js"), "utf8"),
      testJs: fs.readFileSync(path.join(dir, "test.js"), "utf8"),
      packageJson: fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      requirementsMd: fs.readFileSync(path.join(dir, "REQUIREMENTS.md"), "utf8"),
      disclosure: SEED_DISCLOSURE,
    };
  } catch {
    return null;
  }
}

/** Spawns one real `claude -p` process, streams its NDJSON output into the
 *  shared event log in real time, and resolves with its final outcome.
 *  Never throws, never passes --dangerously-skip-permissions. */
function runClaudeAgent(opts: {
  agentId: AgentId;
  workspaceDir: string;
  prompt: string;
  allowedTools: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<AgentOutcome> {
  return new Promise((resolve) => {
    const s = store();
    const args = [
      "-p",
      opts.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      opts.allowedTools,
      "--append-system-prompt",
      SCOPE_SYSTEM_PROMPT,
      "--no-session-persistence",
    ];

    let child: ChildProcess;
    try {
      child = spawn("claude", args, {
        cwd: opts.workspaceDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      pushEvent({
        agent: opts.agentId,
        kind: "error",
        text: `Failed to start the claude CLI: ${err instanceof Error ? err.message : String(err)}. Is it installed and on PATH?`,
      });
      resolve({ status: "error", resultText: "claude CLI could not be started", isError: true, costUsd: null, durationMs: 0 });
      return;
    }
    s.children.push(child);
    pushEvent({ agent: opts.agentId, kind: "status", text: "Started a real `claude` CLI process." });

    const startedAt = Date.now();
    let buffer = "";
    let stderrBuf = "";
    let outcome: AgentOutcome | null = null;
    let timedOut = false;
    let settled = false;

    const finish = (o: AgentOutcome) => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    const kill = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already dead */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already dead */
        }
      }, 3_000);
    };

    const onAbort = () => kill();
    opts.signal.addEventListener("abort", onAbort);

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      pushEvent({ agent: opts.agentId, kind: "error", text: `Timed out after ${opts.timeoutMs / 1000}s, cancelling this agent's process.` });
      kill();
    }, opts.timeoutMs);

    const handleLine = (line: string) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const type = obj.type as string | undefined;

      if (type === "assistant" || type === "user") {
        const message = obj.message as { content?: unknown } | undefined;
        const content = Array.isArray(message?.content) ? (message!.content as Array<Record<string, unknown>>) : [];
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
            pushEvent({ agent: opts.agentId, kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            pushEvent({ agent: opts.agentId, kind: "tool_call", tool: String(block.name ?? "tool"), input: block.input });
          } else if (block.type === "tool_result") {
            const raw = block.content;
            const text = typeof raw === "string" ? raw : JSON.stringify(raw);
            pushEvent({ agent: opts.agentId, kind: "tool_result", text: text.slice(0, 4_000) });
          }
        }
      } else if (type === "result") {
        outcome = {
          status: "done",
          resultText: typeof obj.result === "string" ? obj.result : null,
          isError: !!obj.is_error,
          costUsd: typeof obj.total_cost_usd === "number" ? obj.total_cost_usd : null,
          durationMs: typeof obj.duration_ms === "number" ? obj.duration_ms : null,
        };
        pushEvent({
          agent: opts.agentId,
          kind: "final",
          text: outcome.resultText ?? undefined,
          isError: outcome.isError,
          costUsd: outcome.costUsd,
          durationMs: outcome.durationMs,
        });
      }
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) handleLine(line);
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      opts.signal.removeEventListener("abort", onAbort);
      s.children = s.children.filter((c) => c !== child);
      const durationMs = Date.now() - startedAt;

      if (outcome) {
        finish(outcome);
        return;
      }
      if (timedOut) {
        finish({ status: "timeout", resultText: "Agent process timed out and was cancelled.", isError: true, costUsd: null, durationMs });
        return;
      }
      if (opts.signal.aborted) {
        finish({ status: "cancelled", resultText: "Run was cancelled.", isError: true, costUsd: null, durationMs });
        return;
      }
      // Process exited without ever emitting a "result" line, likely a CLI
      // startup/auth/rate-limit failure. Surface the real stderr, never
      // invent a success.
      const reason = stderrBuf.trim() || `claude exited with code ${code} and produced no output.`;
      pushEvent({ agent: opts.agentId, kind: "error", text: reason });
      finish({ status: "error", resultText: reason, isError: true, costUsd: null, durationMs });
    });
  });
}

export interface StartResult {
  ok: boolean;
  error?: string;
}

/** Injectable dependencies, real implementations by default. Tests pass
 *  fast, deterministic fakes here instead of spawning the real `claude`
 *  CLI or running real npm scripts, so the orchestration's event ordering,
 *  state transitions, and race-condition guards can be exercised directly. */
export interface LiveComparisonDeps {
  runAgent: typeof runClaudeAgent;
  runVerification: typeof runIndependentValidation;
}

const defaultDeps: LiveComparisonDeps = {
  runAgent: runClaudeAgent,
  runVerification: runIndependentValidation,
};

export function startLiveComparison(deps: LiveComparisonDeps = defaultDeps): StartResult {
  const s = store();
  if (s.state.status === "running") {
    return { ok: false, error: "A run is already in progress. Cancel it first." };
  }

  cleanupWorkspace(s.state.workspaceDir);
  const dir = createFixture();
  const thisRunId = `run_${Date.now()}`;
  s.state = { ...freshState(), runId: thisRunId, status: "running", startedAt: new Date().toISOString(), workspaceDir: dir };
  s.children = [];
  const controller = new AbortController();
  s.controller = controller;

  // True for as long as, and only as long as, s.state is still the exact
  // object this run created. Cancel() does not reassign s.state (it only
  // flips status on the same object), but Reset() and a later Start() both
  // do, which would otherwise let this closure's later `await` continuations
  // keep writing agentB/backendVerdict/status onto a run that has already
  // moved on, the actual race condition this guard exists to prevent. Every
  // checkpoint below must re-check this before touching s.state.
  const stillCurrent = () => s.state.runId === thisRunId;

  pushEvent({ agent: "system", kind: "status", text: SEED_DISCLOSURE });

  void (async () => {
    try {
      pushEvent({ agent: "system", kind: "status", text: "Agent A (Implementation Agent) starting: fix the tenant-isolation vulnerability." });
      const a = await deps.runAgent({
        agentId: "a",
        workspaceDir: dir,
        prompt: AGENT_A_PROMPT,
        allowedTools: "Read,Edit,Write,Bash",
        timeoutMs: AGENT_A_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (!stillCurrent()) return;
      s.state.agentA = a;

      if ((s.state.status as RunStatus) === "cancelled") {
        pushEvent({ agent: "system", kind: "status", text: "Run cancelled; skipping review and backend verification." });
        return;
      }

      s.state.implementationDiff = captureImplementationDiff(dir);
      pushEvent({ agent: "system", kind: "status", text: "Captured a real git diff of Agent A's changes (or lack thereof)." });

      pushEvent({ agent: "system", kind: "status", text: "Agent B (Independent Reviewer) starting: reviewing the resulting code, not Agent A's reasoning." });
      const b = await deps.runAgent({
        agentId: "b",
        workspaceDir: dir,
        prompt: AGENT_B_PROMPT,
        allowedTools: "Read,Bash",
        timeoutMs: AGENT_B_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (!stillCurrent()) return;
      s.state.agentB = b;

      if ((s.state.status as RunStatus) === "cancelled") {
        pushEvent({ agent: "system", kind: "status", text: "Run cancelled; skipping backend verification." });
        return;
      }

      pushEvent({ agent: "system", kind: "status", text: "Running WorkerAI's own independent verification against the real acceptance tests (not either agent's words)..." });

      const verdict = await deps.runVerification({ sshConfig: null, workspaceDir: dir });
      if (!stillCurrent()) return;
      s.state.backendVerdict = verdict;
      const label: VerificationLabel = !verdict.ran ? "NOT_VERIFIED" : verdict.allPassed ? "INDEPENDENTLY_VERIFIED" : "VERIFICATION_FAILED";
      s.state.verificationLabel = label;
      pushEvent({
        agent: "system",
        kind: "final",
        text:
          label === "INDEPENDENTLY_VERIFIED"
            ? "Backend verdict: INDEPENDENTLY_VERIFIED, real npm test exit code 0."
            : label === "VERIFICATION_FAILED"
              ? "Backend verdict: VERIFICATION_FAILED, real non-zero exit code from an independently re-run test."
              : "Backend verdict: NOT_VERIFIED, independent verification could not run.",
        isError: label !== "INDEPENDENTLY_VERIFIED",
      });
      s.state.status = "done";
    } catch (err) {
      if (!stillCurrent()) return;
      s.state.errorMessage = err instanceof Error ? err.message : String(err);
      s.state.status = "error";
      pushEvent({ agent: "system", kind: "error", text: s.state.errorMessage });
    }
  })();

  return { ok: true };
}

export function cancelRun(): StartResult {
  const s = store();
  if (s.state.status !== "running") {
    return { ok: false, error: "No run is currently in progress." };
  }
  pushEvent({ agent: "system", kind: "status", text: "Cancelling, terminating any in-flight agent process..." });
  s.controller?.abort();
  for (const child of s.children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  }
  s.state.status = "cancelled";
  return { ok: true };
}

export function resetRun(): StartResult {
  const s = store();
  if (s.state.status === "running") {
    return { ok: false, error: "A run is in progress. Cancel it first." };
  }
  cleanupWorkspace(s.state.workspaceDir);
  s.state = freshState();
  s.children = [];
  s.controller = null;
  return { ok: true };
}
