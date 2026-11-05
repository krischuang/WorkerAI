/**
 * Completion validation gate for Task.isAutonomous tasks.
 *
 * Tasks created/dispatched by the autonomous improvement pipeline (Project.autonomousMode >= 2)
 * must prove their work with evidence — a [WORKERAI_VALIDATION] block (see
 * lib/prompt-sanitiser.ts) reporting a test/build/lint result or an explicit verification note —
 * before they can be marked "completed". This module is the single place that decides whether
 * a completion marker is allowed to actually complete the task, called from every completion
 * site in instrumentation.node.ts.
 *
 * Core rule: `allowed: true` is only ever returned when verificationState is
 * INDEPENDENTLY_VERIFIED — a real re-execution of allowlisted commands
 * against the task's own workspace, with real exit codes, agreed with the
 * agent's self-report. An agent's printed success claim (AGENT_REPORTED) is
 * never, by itself, sufficient — including when independent verification is
 * mandatory but unavailable (no workspace, or the verification attempt
 * itself failed), which resolves to NOT_VERIFIED and blocks completion
 * rather than silently trusting the claim. See VerificationState below.
 */

import { prisma } from "@/lib/prisma";
import { detectValidationBlock } from "@/lib/usage-parser";
import { emitAudit } from "@/lib/audit";
import { execSSH, type CommandResult } from "@/lib/ssh";
import { posixQuote } from "@/lib/workspace-lifecycle";
import type { SSHConfig } from "@/lib/ssh-claude-tmux";
import { evaluatePolicy, getPolicyApproval, consumePolicyApproval } from "@/lib/policy-engine";
import { scrubPaneCapture } from "@/lib/pane-scrubber";
import { getDecryptedTaskSecrets } from "@/lib/task-secrets";

/**
 * Explicit verification states. These describe HOW we know what we know
 * about a task's completion claim — never conflate "the agent said so" with
 * "WorkerAI independently confirmed it."
 *
 *   NOT_VERIFIED           — independent verification was mandatory but could
 *                            not run (e.g. no workspace available). We have
 *                            no confirmed signal either way. Never treated as
 *                            success.
 *   AGENT_REPORTED         — raw, unverified input from the agent's own
 *                            output. Never a terminal/stored state by itself —
 *                            always either confirmed (-> INDEPENDENTLY_VERIFIED
 *                            / VERIFICATION_FAILED) or left unconfirmed
 *                            (-> NOT_VERIFIED).
 *   INDEPENDENTLY_VERIFIED — real allowlisted commands were re-executed
 *                            against the task's own workspace and their real
 *                            exit codes confirm success.
 *   VERIFICATION_FAILED    — either the agent explicitly reported failure, or
 *                            independent re-execution's real exit codes
 *                            disagree with a success claim.
 *
 * Invariant enforced by this module: allowed === true implies
 * verificationState === "INDEPENDENTLY_VERIFIED". There is no code path that
 * sets allowed=true from AGENT_REPORTED or NOT_VERIFIED alone.
 */
export type VerificationState =
  | "NOT_VERIFIED"
  | "AGENT_REPORTED"
  | "INDEPENDENTLY_VERIFIED"
  | "VERIFICATION_FAILED";

export interface ValidationGateResult {
  /** true = the caller may proceed to mark the task completed. Only ever
   *  true when verificationState === "INDEPENDENTLY_VERIFIED". */
  allowed: boolean;
  /** null when the task isn't isAutonomous (gate not applicable, always allowed). */
  validationStatus: "passed" | "failed" | "missing" | "not_verified" | null;
  /** null when the task isn't isAutonomous. See VerificationState for semantics. */
  verificationState: VerificationState | null;
  evidence: string | null;
}

export interface IndependentCommandResult {
  label: string;
  command: string;
  exitCode: number | null;
  stdoutSummary: string;
  stderrSummary: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
}

export interface IndependentValidationResult {
  ran: boolean;
  allPassed: boolean;
  commands: IndependentCommandResult[];
  gitDiffStat: string | null;
  gitStatusShort: string | null;
  /** File paths parsed from `git status --short --ignored=matching` (the
   *  --ignored flag is required — a gitignored file like .env would
   *  otherwise never appear here at all) — the actual files the agent
   *  touched, independent of anything it claimed. Used for file-level policy
   *  enforcement (see applyFileLevelPolicyGate below), which is a distinct
   *  check from the dispatch-time risk-level policy gate in task-dispatch.ts. */
  changedFiles: string[];
  executedAt: string;
}

/** Parse file paths out of `git status --short`/`--porcelain` output (format:
 *  two status chars, a space, then the path — or "old -> new" for renames). */
function parseChangedFiles(statusOutput: string): string[] {
  return statusOutput
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => {
      const rawPath = line.slice(3).trim();
      const renameParts = rawPath.split(" -> ");
      return renameParts[renameParts.length - 1].trim().replace(/^"|"$/g, "");
    })
    .filter(Boolean);
}

const MAX_OUTPUT_CHARS = 4000;

/** Truncates to a bounded size and scrubs common secret patterns (and any
 *  known task-secret values) before this text is ever persisted as evidence. */
function summarize(text: string, knownSecretValues?: string[]): string {
  const trimmed = text.trim();
  const bounded = trimmed.length <= MAX_OUTPUT_CHARS
    ? trimmed
    : `${trimmed.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${trimmed.length - MAX_OUTPUT_CHARS} more chars]`;
  return scrubPaneCapture(bounded, knownSecretValues);
}

/**
 * Fixed allowlist of validation commands independently re-executed against the
 * task's own workspace. These are literal strings — never built from
 * task/agent-controlled input — so there is no injection surface here; the only
 * untrusted value involved is the workspace directory path, which is shell-quoted
 * via posixQuote (SSH path) or passed as a `cwd` option (local path), never
 * concatenated into the command itself.
 */
export const INDEPENDENT_VALIDATION_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: "lint", command: "npm run lint" },
  { label: "typecheck", command: "npm run typecheck" },
  { label: "test", command: "npm test" },
  { label: "build", command: "npm run build" },
];

/** Exact-match allowlist of command strings that may ever be independently
 *  re-executed. Enforced even when a caller supplies a custom `commands`
 *  list (opts.commands below) — a caller cannot smuggle an arbitrary command
 *  through that override. */
const ALLOWLISTED_COMMANDS = new Set(INDEPENDENT_VALIDATION_COMMANDS.map((c) => c.command));

/** Hard ceiling on the per-command timeout, regardless of what a caller
 *  requests — prevents a misconfigured/malicious caller from asking for an
 *  effectively unbounded run. */
const MAX_TIMEOUT_MS = 10 * 60_000;

async function runLocalCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  const { execSync } = await import("child_process");
  try {
    const stdout = execSync(command, { cwd, timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null; message?: string };
    return {
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? e.message ?? String(err),
      exitCode: typeof e.status === "number" ? e.status : null,
    };
  }
}

async function runOneCommand(
  sshConfig: SSHConfig | null,
  workspaceDir: string,
  command: string,
  timeoutMs: number,
): Promise<CommandResult> {
  if (sshConfig) {
    return execSSH(sshConfig, `cd ${posixQuote(workspaceDir)} && ${command}`, timeoutMs);
  }
  return runLocalCommand(command, workspaceDir, timeoutMs);
}

/**
 * Independently re-run a fixed set of allowlisted validation commands against
 * the task's own workspace — real exit codes, not the agent's self-report.
 * Also captures a git diff/status snapshot as evidence of what actually changed.
 *
 * Never throws: a command or git-evidence failure is captured in the result
 * rather than raised, so a single flaky step cannot crash the completion poller.
 */
export async function runIndependentValidation(opts: {
  sshConfig: SSHConfig | null;
  workspaceDir: string;
  commands?: ReadonlyArray<{ label: string; command: string }>;
  timeoutMs?: number;
  /** Plaintext task-secret values to additionally mask in captured output,
   *  on top of the generic secret-pattern scrubbing always applied. */
  knownSecretValues?: string[];
}): Promise<IndependentValidationResult> {
  const commands = opts.commands ?? INDEPENDENT_VALIDATION_COMMANDS;
  const timeoutMs = Math.min(opts.timeoutMs ?? 120_000, MAX_TIMEOUT_MS);
  const results: IndependentCommandResult[] = [];

  for (const { label, command } of commands) {
    const startedAt = new Date();

    if (!ALLOWLISTED_COMMANDS.has(command)) {
      const finishedAt = new Date();
      results.push({
        label,
        command,
        exitCode: null,
        stdoutSummary: "",
        stderrSummary: `rejected: "${command}" is not in the independent-validation command allowlist`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
      continue;
    }

    try {
      const res = await runOneCommand(opts.sshConfig, opts.workspaceDir, command, timeoutMs);
      const finishedAt = new Date();
      results.push({
        label,
        command,
        exitCode: res.exitCode,
        stdoutSummary: summarize(res.stdout, opts.knownSecretValues),
        stderrSummary: summarize(res.stderr, opts.knownSecretValues),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    } catch (err) {
      const finishedAt = new Date();
      results.push({
        label,
        command,
        exitCode: null,
        stdoutSummary: "",
        stderrSummary: `execution error: ${err instanceof Error ? err.message : String(err)}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    }
  }

  let gitDiffStat: string | null = null;
  let gitStatusShort: string | null = null;
  let changedFiles: string[] = [];
  try {
    const diffRes = await runOneCommand(opts.sshConfig, opts.workspaceDir, "git diff --stat", 30_000);
    gitDiffStat = summarize(diffRes.stdout || diffRes.stderr, opts.knownSecretValues);
    // --ignored=matching is mandatory here, not cosmetic: plain `git status
    // --short` never lists gitignored paths at all, and .env/.env.* are
    // gitignored by convention in virtually every project — including this
    // one. Without --ignored, an agent editing .env directly would produce
    // an EMPTY status, changedFiles would stay [], and the file-level policy
    // gate below would never even see it, let alone deny it. Confirmed by
    // direct reproduction against a real git repo while building this fix.
    const statusRes = await runOneCommand(opts.sshConfig, opts.workspaceDir, "git status --short --ignored=matching", 15_000);
    gitStatusShort = summarize(statusRes.stdout || statusRes.stderr, opts.knownSecretValues);
    changedFiles = parseChangedFiles(statusRes.stdout);
  } catch {
    // Evidence collection is best-effort — it must never block the pass/fail verdict.
  }

  return {
    ran: true,
    allPassed: results.length > 0 && results.every((r) => r.exitCode === 0),
    commands: results,
    gitDiffStat,
    gitStatusShort,
    changedFiles,
    executedAt: new Date().toISOString(),
  };
}

function formatIndependentEvidence(result: IndependentValidationResult): string {
  const lines = [`--- independent validation (executed ${result.executedAt}) ---`];
  for (const c of result.commands) {
    lines.push(`[${c.label}] exit=${c.exitCode ?? "n/a"} (${(c.durationMs / 1000).toFixed(1)}s)`);
    if (c.exitCode !== 0) {
      if (c.stdoutSummary) lines.push(`  stdout: ${c.stdoutSummary}`);
      if (c.stderrSummary) lines.push(`  stderr: ${c.stderrSummary}`);
    }
  }
  if (result.gitDiffStat) lines.push(`git diff --stat:\n${result.gitDiffStat}`);
  if (result.gitStatusShort) lines.push(`git status --short:\n${result.gitStatusShort}`);
  return lines.join("\n");
}

/**
 * Evaluate (and, when blocking, immediately apply) the validation gate for a task whose
 * completion marker was just detected.
 *
 * - validation passed → Task.validationStatus is recorded, caller proceeds to "completed".
 * - validation explicitly failed (block present, result: failed) → this function marks the
 *   task "failed" itself and creates an English-language follow-up task carrying the evidence,
 *   so a human or another autonomous cycle has something concrete to act on.
 * - validation block missing entirely → treated as a protocol violation: marked "failed" with
 *   a clear reason, no follow-up task (there is no evidence to build one from).
 *
 * Non-autonomous tasks always return { allowed: true, validationStatus: null }.
 */
export async function applyValidationGate(opts: {
  taskId: string;
  projectId: string;
  title: string;
  isAutonomous: boolean;
  paneText: string;
  expectedNonce: string | null | undefined;
  /** SSH credentials for the server/agent that ran the task — only used to
   *  independently re-run validation commands against opts.workspaceDir.
   *  Pass null for a locally-executed workspace (e.g. demo scenarios). */
  sshConfig?: SSHConfig | null;
  /** Task's isolated workspace directory (Task.workspaceDir), if any. When
   *  omitted, no independent re-execution happens and behavior is unchanged
   *  from the agent-self-report-only gate — this keeps the gate fully
   *  backward compatible for tasks that don't use an isolated workspace. */
  workspaceDir?: string | null;
}): Promise<ValidationGateResult> {
  if (!opts.isAutonomous) {
    return { allowed: true, validationStatus: null, verificationState: null, evidence: null };
  }

  const block = opts.expectedNonce
    ? detectValidationBlock(opts.paneText, opts.taskId, opts.expectedNonce)
    : { found: false, status: null as "passed" | "failed" | null, evidence: null };

  if (block.found && block.status === "passed") {
    // AGENT_REPORTED at this point — raw, unverified input. It is never
    // treated as a terminal state: every path below resolves it to either
    // NOT_VERIFIED, VERIFICATION_FAILED, or INDEPENDENTLY_VERIFIED.

    // Independent verification is mandatory for isAutonomous tasks — proving
    // work with real evidence is this gate's entire purpose, since the
    // autonomous pipeline runs unsupervised. When no workspace is available
    // to re-run real commands against, there is no way to confirm anything,
    // so we must not silently fall back to trusting the agent. This is a
    // hard requirement, not a soft downgrade: allowed stays false.
    if (!opts.workspaceDir) {
      const evidence = `AGENT_REPORTED (not independently verified — no workspace available): ${block.evidence ?? "(no evidence text provided)"}`;
      await prisma.task.update({
        where: { id: opts.taskId },
        data: {
          status: "needs_review",
          validationStatus: "not_verified",
          validationEvidence: evidence,
          lastFailReason: "Independent verification is mandatory for autonomous tasks but no workspace was available — the agent's self-report was never confirmed.",
        },
      }).catch(() => {});
      await emitAudit({
        entityType: "task",
        entityId: opts.taskId,
        eventType: "task.verification_unavailable",
        actorType: "poller",
        payload: { evidence, reason: "workspace_unavailable", agentReportedStatus: block.status },
      });
      return { allowed: false, validationStatus: "not_verified", verificationState: "NOT_VERIFIED", evidence };
    }

    const knownSecretValues = await getDecryptedTaskSecrets(opts.taskId)
      .then((s) => s.map((r) => r.value))
      .catch(() => []);

    // Do not take the agent's word for it alone: re-run the same allowlisted
    // commands against the real workspace and only honor "passed" if the
    // real exit codes agree.
    const independent = await runIndependentValidation({
      sshConfig: opts.sshConfig ?? null,
      workspaceDir: opts.workspaceDir,
      knownSecretValues,
    }).catch((): IndependentValidationResult => ({
      ran: false,
      allPassed: false,
      commands: [],
      gitDiffStat: null,
      gitStatusShort: null,
      changedFiles: [],
      executedAt: new Date().toISOString(),
    }));

    if (!independent.ran) {
      // A workspace WAS available, but the independent check itself could
      // not complete (e.g. SSH failure, timeout) — we attempted real
      // verification and got no confirmed signal. Same rule applies: never
      // treat an inconclusive attempt as success.
      const evidence = `AGENT_REPORTED (not independently verified — verification attempt failed): ${block.evidence ?? "(no evidence text provided)"}`;
      await prisma.task.update({
        where: { id: opts.taskId },
        data: {
          status: "needs_review",
          validationStatus: "not_verified",
          validationEvidence: evidence,
          lastFailReason: "Independent verification was attempted but could not complete (infrastructure failure) — the agent's self-report was never confirmed.",
        },
      }).catch(() => {});
      await emitAudit({
        entityType: "task",
        entityId: opts.taskId,
        eventType: "task.verification_unavailable",
        actorType: "poller",
        payload: { evidence, reason: "verification_attempt_failed", agentReportedStatus: block.status },
      });
      return { allowed: false, validationStatus: "not_verified", verificationState: "NOT_VERIFIED", evidence };
    }

    if (!independent.allPassed) {
      const evidence = `${block.evidence ?? ""}\n\n${formatIndependentEvidence(independent)}`.trim();
      await prisma.task.update({
        where: { id: opts.taskId },
        data: {
          status: "failed",
          validationStatus: "failed",
          validationEvidence: evidence,
          lastFailReason: "Independent validation failed despite the agent reporting success — see validationEvidence.",
        },
      }).catch(() => {});
      await emitAudit({
        entityType: "task",
        entityId: opts.taskId,
        eventType: "task.validation_failed",
        actorType: "poller",
        payload: { evidence, reason: "independent_check_disagreed", independent },
      });

      const followUp = await prisma.task.create({
        data: {
          projectId: opts.projectId,
          title: `Fix validation failure from autonomous task: ${opts.title}`.slice(0, 200),
          description:
            `The autonomous task "${opts.title}" (id: ${opts.taskId}) reported a passing validation, ` +
            `but independently re-running the same checks against its workspace disagreed.\n\n` +
            `Evidence:\n${evidence}\n\nPlease investigate and fix the underlying issue.`,
          taskType: "maintenance",
          priority: "P2",
          riskLevel: "medium",
          isAutonomous: false,
        },
      });
      await emitAudit({
        entityType: "task",
        entityId: opts.taskId,
        eventType: "task.auto_followup_created",
        actorType: "poller",
        payload: { followUpTaskId: followUp.id },
      });

      return { allowed: false, validationStatus: "failed", verificationState: "VERIFICATION_FAILED", evidence };
    }

    // File-level policy gate — distinct from task-dispatch.ts's dispatch-time
    // gate. That gate evaluates "code_execution" by riskLevel BEFORE any work
    // starts, when no files are known yet. This gate evaluates "file_change"
    // against the actual paths the agent touched (independent.changedFiles,
    // parsed from a real `git status --short`), which can only be known AFTER
    // execution. A task that was fine to dispatch can still touch a file it
    // should not have — e.g. an agent editing .env despite instructions not
    // to. The agent's self-report has no bearing on this: it is evaluated
    // purely against what actually changed on disk.
    if (independent.changedFiles.length > 0) {
      const filePolicy = await evaluatePolicy({
        taskId: opts.taskId,
        category: "file_change",
        filePaths: independent.changedFiles,
      });

      if (filePolicy.decision === "deny" || filePolicy.decision === "require_approval") {
        const approval = filePolicy.decision === "require_approval"
          ? await getPolicyApproval(opts.taskId, "file_change")
          : null;

        if (filePolicy.decision === "deny" || !approval) {
          const evidence = `${block.evidence ?? ""}\n\n${formatIndependentEvidence(independent)}\n\n` +
            `--- file-level policy ---\n${filePolicy.decision}: ${filePolicy.reason} ` +
            `(changed files: ${independent.changedFiles.join(", ")})`.trim();
          const reason = filePolicy.decision === "deny"
            ? "file_level_policy_denied"
            : "file_level_policy_requires_approval";
          const lastFailReason = filePolicy.decision === "deny"
            ? `File-level policy denied this change: ${filePolicy.reason} (${independent.changedFiles.join(", ")}).`
            : `File-level policy requires human approval before this change can complete: ${filePolicy.reason} (${independent.changedFiles.join(", ")}). Approve via POST /api/tasks/${opts.taskId}/approve-dispatch, then re-run validation.`;

          await prisma.task.update({
            where: { id: opts.taskId },
            data: { status: "failed", validationStatus: "failed", validationEvidence: evidence, lastFailReason },
          }).catch(() => {});
          await emitAudit({
            entityType: "task",
            entityId: opts.taskId,
            eventType: "task.validation_failed",
            actorType: "poller",
            payload: { evidence, reason, filePolicy, changedFiles: independent.changedFiles },
          });

          const followUp = await prisma.task.create({
            data: {
              projectId: opts.projectId,
              title: `Fix file-level policy violation from autonomous task: ${opts.title}`.slice(0, 200),
              description:
                `The autonomous task "${opts.title}" (id: ${opts.taskId}) changed file(s) that file-level ` +
                `policy does not allow without review: ${independent.changedFiles.join(", ")}.\n\n` +
                `Policy reason: ${filePolicy.reason}\n\n` +
                (filePolicy.decision === "require_approval"
                  ? "A human must review and approve this change before it can complete."
                  : "This change is denied outright and must be reverted or redone without touching those files."),
              taskType: "maintenance",
              priority: "P2",
              riskLevel: "medium",
              isAutonomous: false,
            },
          });
          await emitAudit({
            entityType: "task",
            entityId: opts.taskId,
            eventType: "task.auto_followup_created",
            actorType: "poller",
            payload: { followUpTaskId: followUp.id },
          });

          return { allowed: false, validationStatus: "failed", verificationState: "VERIFICATION_FAILED", evidence };
        }

        // Approval was granted and found — consume it (one-time use) and proceed.
        await consumePolicyApproval(opts.taskId);
        await emitAudit({
          entityType: "task",
          entityId: opts.taskId,
          eventType: "task.dispatch_approval_consumed",
          actorType: "system",
          payload: { approval, context: "file_level_policy", changedFiles: independent.changedFiles },
        });
      }
    }

    // Reaching here means: a workspace was available, independent
    // re-execution completed, every command's real exit code was 0, and
    // file-level policy allowed (or an explicit approval was consumed for)
    // the files actually changed. This is the only path that may report
    // INDEPENDENTLY_VERIFIED.
    const evidence = `${block.evidence ?? ""}\n\n${formatIndependentEvidence(independent)}`.trim();

    await prisma.task.update({
      where: { id: opts.taskId },
      data: { validationStatus: "passed", validationEvidence: evidence },
    }).catch(() => {});
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.validation_passed",
      actorType: "poller",
      payload: { evidence, independentlyVerified: true },
    });
    return { allowed: true, validationStatus: "passed", verificationState: "INDEPENDENTLY_VERIFIED", evidence };
  }

  if (block.found && block.status === "failed") {
    await prisma.task.update({
      where: { id: opts.taskId },
      data: {
        status: "failed",
        validationStatus: "failed",
        validationEvidence: block.evidence,
        lastFailReason: `Autonomous validation failed: ${block.evidence ?? "no evidence provided"}`,
      },
    }).catch(() => {});
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.validation_failed",
      actorType: "poller",
      payload: { evidence: block.evidence, reason: "validation_block_reported_failed" },
    });

    const followUp = await prisma.task.create({
      data: {
        projectId: opts.projectId,
        title: `Fix validation failure from autonomous task: ${opts.title}`.slice(0, 200),
        description:
          `The autonomous task "${opts.title}" (id: ${opts.taskId}) reported completion but failed ` +
          `its validation check.\n\nValidation evidence reported by the agent:\n` +
          `${block.evidence ?? "No evidence was provided."}\n\n` +
          `Please investigate and fix the underlying issue.`,
        taskType: "maintenance",
        priority: "P2",
        riskLevel: "medium",
        isAutonomous: false,
      },
    });
    await emitAudit({
      entityType: "task",
      entityId: opts.taskId,
      eventType: "task.auto_followup_created",
      actorType: "poller",
      payload: { followUpTaskId: followUp.id },
    });

    return { allowed: false, validationStatus: "failed", verificationState: "VERIFICATION_FAILED", evidence: block.evidence };
  }

  // Missing entirely — a protocol violation with no actionable evidence to build a follow-up
  // from, so we fail clearly rather than guessing at what went wrong. No agent report at all
  // means no signal whatsoever — NOT_VERIFIED, same as the workspace-unavailable case.
  await prisma.task.update({
    where: { id: opts.taskId },
    data: {
      status: "failed",
      validationStatus: "missing",
      lastFailReason: "Autonomous task reported completion without the required validation evidence block.",
    },
  }).catch(() => {});
  await emitAudit({
    entityType: "task",
    entityId: opts.taskId,
    eventType: "task.validation_failed",
    actorType: "poller",
    payload: { reason: "missing_validation_block" },
  });

  return { allowed: false, validationStatus: "missing", verificationState: "NOT_VERIFIED", evidence: null };
}
