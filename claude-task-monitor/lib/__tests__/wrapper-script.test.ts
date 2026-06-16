import { describe, it, expect } from "vitest";
import {
  buildWrapperScript,
  doneFilePath,
  promptFilePath,
  wrapperScriptPath,
  logFilePath,
} from "../wrapper-script";
import { RUN_DIR } from "../constants";

const OPTS = {
  taskId: "task-abc",
  agentId: "agent-xyz",
  runId: "run-123",
  claudeFlags: "",
};

// ── Path helpers ──────────────────────────────────────────────────────────────

describe("path helpers", () => {
  it("doneFilePath returns <RUN_DIR>/<runId>.done.json", () => {
    expect(doneFilePath("run-123")).toBe(`${RUN_DIR}/run-123.done.json`);
  });

  it("promptFilePath returns <RUN_DIR>/<runId>.prompt", () => {
    expect(promptFilePath("run-123")).toBe(`${RUN_DIR}/run-123.prompt`);
  });

  it("wrapperScriptPath returns <RUN_DIR>/wrapper_<runId>.sh", () => {
    expect(wrapperScriptPath("run-123")).toBe(`${RUN_DIR}/wrapper_run-123.sh`);
  });

  it("logFilePath returns <RUN_DIR>/<runId>.log", () => {
    expect(logFilePath("run-123")).toBe(`${RUN_DIR}/run-123.log`);
  });
});

// ── Script structure ──────────────────────────────────────────────────────────

describe("buildWrapperScript", () => {
  it("starts with bash shebang", () => {
    const script = buildWrapperScript(OPTS);
    expect(script.startsWith("#!/usr/bin/env bash")).toBe(true);
  });

  it("includes set -euo pipefail", () => {
    expect(buildWrapperScript(OPTS)).toContain("set -euo pipefail");
  });

  it("includes trap cleanup EXIT for done-file guarantee", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain("trap cleanup EXIT");
    expect(script).toContain("cleanup()");
  });

  it("writes done-file atomically via tmp → mv rename", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain(".tmp");
    expect(script).toContain("mv ");
    // tmp file and final done file are on the same line
    const donePath = doneFilePath(OPTS.runId);
    expect(script).toContain(`"${donePath}.tmp"`);
    expect(script).toContain(`"$DONE_FILE"`);
  });

  it("captures PIPESTATUS[0] as exit code", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain("PIPESTATUS[0]");
  });

  it("uses claude --print for non-interactive execution", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain("claude");
    expect(script).toContain("--print");
  });

  it("pipes output to tee <logFile>", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain("tee");
    expect(script).toContain(logFilePath(OPTS.runId));
  });

  it("embeds taskId, agentId, runId in the done-file JSON template", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).toContain(OPTS.taskId);
    expect(script).toContain(OPTS.agentId);
    expect(script).toContain(OPTS.runId);
  });

  it("includes no extra flags when claudeFlags is empty", () => {
    const script = buildWrapperScript({ ...OPTS, claudeFlags: "" });
    // Should not have --dangerously-skip-permissions or --allowedTools
    expect(script).not.toContain("--dangerously-skip-permissions");
    expect(script).not.toContain("--allowedTools");
  });

  it("includes --dangerously-skip-permissions for full_autonomous flags", () => {
    const script = buildWrapperScript({ ...OPTS, claudeFlags: "--dangerously-skip-permissions" });
    expect(script).toContain("--dangerously-skip-permissions");
  });

  it("includes --allowedTools for read_only flags", () => {
    const flags = '--allowedTools "Read,Grep,Glob,LS,WebSearch,WebFetch"';
    const script = buildWrapperScript({ ...OPTS, claudeFlags: flags });
    expect(script).toContain("--allowedTools");
  });

  it("exports HOME when workDir is provided", () => {
    const script = buildWrapperScript({ ...OPTS, workDir: "/home/worker" });
    expect(script).toContain('export HOME="/home/worker"');
  });

  it("does not export HOME when workDir is absent", () => {
    const script = buildWrapperScript(OPTS);
    expect(script).not.toContain("export HOME");
  });
});
