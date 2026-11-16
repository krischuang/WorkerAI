/**
 * Regression tests for the live two-agent comparison orchestration
 * (lib/interview-live-demo.ts).
 *
 * These exist because of a real bug: the SSE route's "run-complete" payload
 * was a hand-picked field list that fell out of sync with RunState after
 * implementationDiff/verificationLabel were added, so the client's Final
 * Decision panel stayed stuck at null forever while the execution log
 * (built from individual event text) already showed the real verdict.
 *
 * Real `claude` CLI processes are never spawned here: startLiveComparison()
 * accepts injected `runAgent`/`runVerification` dependencies, fast and
 * deterministic in tests, the real implementations in production. Real
 * filesystem and git operations (createFixture, the implementation diff)
 * are NOT mocked, they are fast, local, and deterministic, and exercising
 * them for real is exactly the point: this is still testing whether
 * verificationLabel/implementationDiff/runId actually propagate correctly,
 * not whether a mock was called.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  startLiveComparison,
  cancelRun,
  resetRun,
  getState,
  deriveDisplayStatus,
  type AgentOutcome,
  type RunState,
} from "@/lib/interview-live-demo";
import type { IndependentValidationResult } from "@/lib/validation-gate";

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

function fakeOutcome(text: string): AgentOutcome {
  return { status: "done", resultText: text, isError: false, costUsd: 0.01, durationMs: 10 };
}

function fakeVerdict(allPassed: boolean, ran = true): IndependentValidationResult {
  return {
    ran,
    allPassed,
    commands: ran
      ? [{ label: "test", command: "npm test", exitCode: allPassed ? 0 : 1, stdoutSummary: "", stderrSummary: "", startedAt: "", finishedAt: "", durationMs: 1 }]
      : [],
    gitDiffStat: null,
    gitStatusShort: null,
    changedFiles: [],
    executedAt: new Date().toISOString(),
  };
}

afterEach(() => {
  // cancelRun() is a no-op (returns {ok:false}) if nothing is running, same
  // for resetRun() if already idle, both are safe to call unconditionally.
  cancelRun();
  resetRun();
});

describe("deriveDisplayStatus: never reads either agent's text, only status + verificationLabel", () => {
  it("idle -> NOT_STARTED", () => {
    expect(deriveDisplayStatus({ status: "idle", verificationLabel: null })).toBe("NOT_STARTED");
  });
  it("running -> RUNNING, regardless of verificationLabel", () => {
    expect(deriveDisplayStatus({ status: "running", verificationLabel: "INDEPENDENTLY_VERIFIED" })).toBe("RUNNING");
  });
  it("done + INDEPENDENTLY_VERIFIED -> INDEPENDENTLY_VERIFIED", () => {
    expect(deriveDisplayStatus({ status: "done", verificationLabel: "INDEPENDENTLY_VERIFIED" })).toBe("INDEPENDENTLY_VERIFIED");
  });
  it("done + VERIFICATION_FAILED -> VERIFICATION_FAILED", () => {
    expect(deriveDisplayStatus({ status: "done", verificationLabel: "VERIFICATION_FAILED" })).toBe("VERIFICATION_FAILED");
  });
  it("cancelled with no verificationLabel -> NOT_VERIFIED (cancellation always skips verification, so the label is null in practice)", () => {
    expect(deriveDisplayStatus({ status: "cancelled", verificationLabel: null })).toBe("NOT_VERIFIED");
  });
  it("error with no verificationLabel -> NOT_VERIFIED", () => {
    expect(deriveDisplayStatus({ status: "error", verificationLabel: null })).toBe("NOT_VERIFIED");
  });
});

describe("startLiveComparison: completion, event ordering, run ID tagging", () => {
  it("runs Agent A then Agent B then backend verification, in that order, and reaches INDEPENDENTLY_VERIFIED on a real pass", async () => {
    const calls: string[] = [];
    const result = startLiveComparison({
      runAgent: vi.fn(async (opts) => {
        calls.push(opts.agentId);
        return fakeOutcome(opts.agentId === "a" ? "STATUS: COMPLETE" : "VERDICT: SATISFIES_REQUIREMENTS");
      }),
      runVerification: vi.fn(async () => {
        calls.push("verify");
        return fakeVerdict(true);
      }),
    });
    expect(result.ok).toBe(true);

    await waitUntil(() => getState().status !== "running");

    expect(calls).toEqual(["a", "b", "verify"]);
    const state = getState();
    expect(state.status).toBe("done");
    expect(state.verificationLabel).toBe("INDEPENDENTLY_VERIFIED");
    expect(deriveDisplayStatus(state)).toBe("INDEPENDENTLY_VERIFIED");
  });

  it("every event carries a monotonically increasing seq and the run's own runId, no duplicates", async () => {
    startLiveComparison({
      runAgent: vi.fn(async (opts) => fakeOutcome(`done ${opts.agentId}`)),
      runVerification: vi.fn(async () => fakeVerdict(true)),
    });
    await waitUntil(() => getState().status !== "running");

    const state = getState();
    expect(state.events.length).toBeGreaterThan(0);
    const seqs = state.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length); // no duplicate seq
    for (const e of state.events) {
      expect(e.runId).toBe(state.runId);
    }
  });

  it("the exact bug this suite exists to catch: RunState always exposes implementationDiff and verificationLabel, a hand-picked field list can never silently drop them again", async () => {
    startLiveComparison({
      runAgent: vi.fn(async () => fakeOutcome("done")),
      runVerification: vi.fn(async () => fakeVerdict(true)),
    });
    await waitUntil(() => getState().status !== "running");

    const state = getState();
    const expectedKeys: Array<keyof RunState> = [
      "runId", "status", "startedAt", "workspaceDir", "events",
      "agentA", "agentB", "implementationDiff", "backendVerdict",
      "verificationLabel", "errorMessage",
    ];
    for (const key of expectedKeys) {
      expect(state).toHaveProperty(key);
    }
    // The specific two fields that actually regressed:
    expect(state.verificationLabel).not.toBeNull();
    expect(typeof state.implementationDiff).toBe("string");
  });
});

describe("startLiveComparison: verification failure and not-verified paths", () => {
  it("a real non-zero exit code produces VERIFICATION_FAILED, never derived from either agent's claim", async () => {
    startLiveComparison({
      // Both agents claim success; the backend disagrees. The label must
      // follow the backend, not the agents.
      runAgent: vi.fn(async () => fakeOutcome("STATUS: COMPLETE / VERDICT: SATISFIES_REQUIREMENTS")),
      runVerification: vi.fn(async () => fakeVerdict(false)),
    });
    await waitUntil(() => getState().status !== "running");

    const state = getState();
    expect(state.verificationLabel).toBe("VERIFICATION_FAILED");
    expect(deriveDisplayStatus(state)).toBe("VERIFICATION_FAILED");
  });

  it("verification that cannot run at all produces NOT_VERIFIED", async () => {
    startLiveComparison({
      runAgent: vi.fn(async () => fakeOutcome("done")),
      runVerification: vi.fn(async () => fakeVerdict(false, /* ran */ false)),
    });
    await waitUntil(() => getState().status !== "running");

    expect(getState().verificationLabel).toBe("NOT_VERIFIED");
  });
});

describe("startLiveComparison: cancellation", () => {
  it("cancelling mid-Agent-A skips Agent B and backend verification entirely", async () => {
    let releaseAgentA!: () => void;
    const agentAGate = new Promise<void>((resolve) => {
      releaseAgentA = resolve;
    });
    const runAgent = vi.fn(async (opts: { agentId: string; signal: AbortSignal }) => {
      if (opts.agentId === "a") {
        await agentAGate;
        return { status: opts.signal.aborted ? "cancelled" : "done", resultText: "x", isError: true, costUsd: null, durationMs: 1 } as AgentOutcome;
      }
      throw new Error("Agent B must never run after a mid-Agent-A cancel");
    });
    const runVerification = vi.fn(async () => {
      throw new Error("Backend verification must never run after a mid-Agent-A cancel");
    });

    startLiveComparison({ runAgent, runVerification });
    await waitUntil(() => getState().status === "running" && getState().events.length > 0);

    const cancelResult = cancelRun();
    expect(cancelResult.ok).toBe(true);
    expect(getState().status).toBe("cancelled");

    releaseAgentA();
    await new Promise((r) => setTimeout(r, 50)); // let the orchestration's continuation run

    const state = getState();
    expect(state.status).toBe("cancelled");
    expect(state.agentB).toBeNull();
    expect(state.backendVerdict).toBeNull();
    expect(runVerification).not.toHaveBeenCalled();
  });
});

describe("startLiveComparison: stale-run race condition (the async race this task asked to check for)", () => {
  it("a Cancel followed immediately by Reset must not let the cancelled run's late-arriving continuation corrupt the new, reset state", async () => {
    let releaseAgentA!: () => void;
    const agentAGate = new Promise<void>((resolve) => {
      releaseAgentA = resolve;
    });
    const runAgent = vi.fn(async (opts: { agentId: string }) => {
      if (opts.agentId === "a") {
        await agentAGate;
        return fakeOutcome("late arrival after cancel+reset");
      }
      return fakeOutcome("b");
    });
    const runVerification = vi.fn(async () => fakeVerdict(true));

    startLiveComparison({ runAgent, runVerification });
    await waitUntil(() => getState().status === "running");
    const firstRunId = getState().runId;

    cancelRun();
    const resetResult = resetRun(); // succeeds: status is "cancelled", not "running"
    expect(resetResult.ok).toBe(true);
    expect(getState().status).toBe("idle");
    expect(getState().runId).toBe("");

    // Now let the first run's Agent A promise resolve, late, after the reset.
    releaseAgentA();
    await new Promise((r) => setTimeout(r, 50));

    const state = getState();
    // The stale continuation must have bailed out via the runId guard
    // instead of writing agentA onto the freshly-reset state.
    expect(state.runId).not.toBe(firstRunId);
    expect(state.status).toBe("idle");
    expect(state.agentA).toBeNull();
  });
});

describe("page refresh: GET-equivalent snapshot is always the complete, authoritative state", () => {
  it("getState() after a completed run returns the full RunState, same object the stream route now sends instead of a hand-picked subset", async () => {
    startLiveComparison({
      runAgent: vi.fn(async () => fakeOutcome("done")),
      runVerification: vi.fn(async () => fakeVerdict(true)),
    });
    await waitUntil(() => getState().status !== "running");

    // Simulates a browser refresh: a fresh caller reads getState() with no
    // prior knowledge, same as GET /api/interview/live-comparison does.
    const snapshot = getState();
    expect(snapshot.status).toBe("done");
    expect(snapshot.verificationLabel).toBe("INDEPENDENTLY_VERIFIED");
    expect(snapshot.backendVerdict?.allPassed).toBe(true);
    expect(snapshot.events.length).toBeGreaterThan(0);
  });
});
