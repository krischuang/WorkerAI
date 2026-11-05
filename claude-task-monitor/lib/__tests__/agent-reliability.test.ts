/**
 * Tests for lib/agent-reliability.ts — the Adaptive Trust Engine's
 * deterministic, evidence-based reliability computation.
 *
 * Every scenario here is designed to catch the exact failure modes the
 * feature is required to avoid: inventing data, treating infrastructure
 * failures as code-quality signals, scoring on too little evidence, and
 * crashing on malformed records instead of degrading safely.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    task: { findMany: vi.fn() },
    auditEvent: { findMany: vi.fn() },
  },
}));

import { computeAgentReliability, MIN_SAMPLE_SIZE } from "../agent-reliability";
import { prisma } from "@/lib/prisma";

const mockTask = vi.mocked(prisma.task);
const mockAuditEvent = vi.mocked(prisma.auditEvent);

function task(id: string) {
  return { id };
}

function event(entityId: string, eventType: string, reason?: string, at = new Date("2026-11-01T00:00:00Z")) {
  return { entityId, eventType, createdAt: at, payload: reason ? { reason } : {} };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("computeAgentReliability — verified success", () => {
  it("scores a clean record near 100 once the sample minimum is met", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_passed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.verdict).toBe("RELIABLE");
    expect(result.score).toBe(100);
    expect(result.sampleSize).toBe(3);
    expect(result.counts.verifiedSuccess).toBe(3);
    expect(result.method).toBe("deterministic_evidence_aggregation");
  });
});

describe("computeAgentReliability — verified (honest) failure", () => {
  it("counts an honest self-reported failure without penalizing it as a lie", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_failed", "validation_block_reported_failed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.verifiedFailureHonest).toBe(1);
    expect(result.counts.verifiedFailureFalsePositive).toBe(0);
    expect(result.sampleSize).toBe(3);
    // 2 success vs 1 honest failure (weight 1): 2/3 ≈ 67
    expect(result.score).toBe(67);
  });
});

describe("computeAgentReliability — false agent success report", () => {
  it("weights a caught lie (false positive) more heavily than an honest failure", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_failed", "independent_check_disagreed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.verifiedFailureFalsePositive).toBe(1);
    // 2 success vs 1 false-positive at 2x weight: 2/(2+2) = 50
    expect(result.score).toBe(50);
    // A confirmed lie caps the verdict below RELIABLE regardless of score.
    expect(result.verdict).not.toBe("RELIABLE");
  });

  it("never classifies a caught lie as RELIABLE even with an otherwise-perfect score", async () => {
    const tasks = Array.from({ length: 20 }, (_, i) => task(`t${i}`));
    const events = tasks.map((t, i) =>
      i === 0
        ? event(t.id, "task.validation_failed", "independent_check_disagreed")
        : event(t.id, "task.validation_passed"),
    );
    mockTask.findMany.mockResolvedValue(tasks as never);
    mockAuditEvent.findMany.mockResolvedValue(events as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.verifiedFailureFalsePositive).toBe(1);
    expect(result.verdict).not.toBe("RELIABLE");
  });
});

describe("computeAgentReliability — infrastructure-only failure is never a code-quality signal", () => {
  it("excludes a task that never produced any validation event at all (pure dispatch/SSH failure)", async () => {
    // t1/t2/t3 have validation events; t4 is a pure infra failure — no
    // completion marker ever appeared, so lib/validation-gate.ts never ran
    // and never emitted ANY of the three relevant event types for it.
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3"), task("t4")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_passed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    // t4 contributes to neither the sample nor any excluded bucket — it's
    // simply absent, which is the correct behavior: it was never evidence
    // about code quality in the first place.
    expect(result.sampleSize).toBe(3);
    expect(result.score).toBe(100);
  });

  it("excludes file-level policy blocks — not a code-quality signal", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_failed", "file_level_policy_denied"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.excludedPolicy).toBe(1);
    expect(result.sampleSize).toBe(2); // t3 not counted toward the score at all
  });
});

describe("computeAgentReliability — insufficient evidence", () => {
  it("returns INSUFFICIENT_EVIDENCE and a null score below the minimum sample size", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(MIN_SAMPLE_SIZE).toBeGreaterThan(2);
    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.score).toBeNull();
  });

  it("returns INSUFFICIENT_EVIDENCE when the agent has no tasks at all", async () => {
    mockTask.findMany.mockResolvedValue([] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.sampleSize).toBe(0);
    expect(mockAuditEvent.findMany).not.toHaveBeenCalled();
  });

  it("excludes NOT_VERIFIED outcomes from the sample rather than guessing", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.verification_unavailable", "workspace_unavailable"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.excludedNotVerified).toBe(1);
    expect(result.sampleSize).toBe(2);
  });
});

describe("computeAgentReliability — different task categories", () => {
  it("passes the taskType filter through to the query and reflects it on the result", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_passed"),
    ] as never);

    const result = await computeAgentReliability("agent-1", { taskType: "coding" });

    expect(result.taskType).toBe("coding");
    const callArgs = mockTask.findMany.mock.calls[0][0] as { where: { taskType?: string } };
    expect(callArgs.where.taskType).toBe("coding");
  });
});

describe("computeAgentReliability — missing and malformed records", () => {
  it("excludes an unrecognized reason string instead of guessing success or failure", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_failed", "some_future_reason_not_yet_mapped"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.excludedAmbiguous).toBe(1);
    expect(result.sampleSize).toBe(2);
  });

  it("excludes an event with a missing/malformed payload instead of crashing", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      event("t1", "task.validation_passed"),
      event("t2", "task.validation_passed"),
      { entityId: "t3", eventType: "task.validation_failed", createdAt: new Date(), payload: null },
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.counts.excludedAmbiguous).toBe(1);
    expect(result.sampleSize).toBe(2);
  });

  it("degrades to INSUFFICIENT_EVIDENCE rather than throwing when the database errors", async () => {
    mockTask.findMany.mockRejectedValue(new Error("connection refused"));

    const result = await computeAgentReliability("agent-1");

    expect(result.verdict).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.score).toBeNull();
  });

  it("only counts the latest validation event when a task was retried multiple times", async () => {
    mockTask.findMany.mockResolvedValue([task("t1"), task("t2"), task("t3")] as never);
    mockAuditEvent.findMany.mockResolvedValue([
      // t1 failed on first attempt, then passed on retry — only the latest (passed) should count.
      event("t1", "task.validation_failed", "validation_block_reported_failed", new Date("2026-11-01T00:00:00Z")),
      event("t1", "task.validation_passed", undefined, new Date("2026-11-01T01:00:00Z")),
      event("t2", "task.validation_passed"),
      event("t3", "task.validation_passed"),
    ] as never);

    const result = await computeAgentReliability("agent-1");

    expect(result.sampleSize).toBe(3);
    expect(result.counts.verifiedSuccess).toBe(3);
    expect(result.counts.verifiedFailureHonest).toBe(0);
  });
});
