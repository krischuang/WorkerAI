/**
 * Tests for lib/task-transitions.ts
 *
 * Covers TICKET-002: "No tests verify that invalid transitions are blocked
 * or that auto-advance logic fires correctly."
 *
 * Three test groups:
 *   1. isValidTransition — every cell of the transition table
 *   2. validateTransition — error message shape and content
 *   3. Dispatch & auto-advance invariants — rules that route handlers rely on
 */

import { describe, it, expect } from "vitest";
import {
  ALLOWED_TRANSITIONS,
  DISPATCHABLE_STATUSES,
  QUEUE_AUTO_ADVANCE_FROM,
  isValidTransition,
  isDispatchable,
  validateTransition,
} from "../task-transitions";
import type { TaskStatus } from "@/app/generated/prisma/client";

const ALL_STATUSES: TaskStatus[] = [
  "pending",
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "archived",
];

// ─── isValidTransition ────────────────────────────────────────────────────────

describe("isValidTransition — no-ops", () => {
  it.each(ALL_STATUSES)("allows %s → %s (same state)", (s) => {
    expect(isValidTransition(s, s)).toBe(true);
  });
});

describe("isValidTransition — valid forward paths", () => {
  const VALID: Array<[TaskStatus, TaskStatus]> = [
    // Assignment advances pending to queued
    ["pending", "queued"],
    // User can pause a pending task
    ["pending", "paused"],
    // Dispatch advances queued to running
    ["queued", "running"],
    // De-queue (remove assignment)
    ["queued", "pending"],
    // User can pause a queued task
    ["queued", "paused"],
    // Claude finishes → completed
    ["running", "completed"],
    // SSH / execution error → failed
    ["running", "failed"],
    // User pauses mid-run
    ["running", "paused"],
    // Resume with resource still assigned → re-queue
    ["paused", "queued"],
    // Resume without resource → back to pending
    ["paused", "pending"],
    // Review verdict = done → archive
    ["completed", "archived"],
    // Review verdict = incomplete → retry from pending
    ["completed", "pending"],
    // User retries a failed task
    ["failed", "pending"],
  ];

  it.each(VALID)("allows %s → %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });
});

describe("isValidTransition — blocked transitions", () => {
  // Cross-check: every status pair NOT in the valid list above should be false.
  // We only list the non-trivially-wrong ones to keep the test readable.
  const BLOCKED: Array<[TaskStatus, TaskStatus]> = [
    // Can't skip states backwards
    ["running",   "pending"],
    ["running",   "queued"],
    ["completed", "running"],
    ["completed", "queued"],
    ["completed", "failed"],
    ["completed", "paused"],
    ["archived",  "pending"],
    ["archived",  "queued"],
    ["archived",  "running"],
    ["archived",  "completed"],
    ["archived",  "failed"],
    ["archived",  "paused"],
    ["failed",    "queued"],
    ["failed",    "running"],
    ["failed",    "completed"],
    ["failed",    "archived"],
    ["failed",    "paused"],
    // Can't dispatch directly to completed/archived/failed
    ["pending",   "completed"],
    ["pending",   "archived"],
    ["pending",   "failed"],
    ["pending",   "running"],
    ["queued",    "completed"],
    ["queued",    "archived"],
    ["queued",    "failed"],
    ["paused",    "running"],
    ["paused",    "completed"],
    ["paused",    "archived"],
    ["paused",    "failed"],
  ];

  it.each(BLOCKED)("blocks %s → %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });
});

describe("isValidTransition — archived is a terminal state", () => {
  it("has no outbound transitions from archived", () => {
    const outbound = ALL_STATUSES.filter((to) => to !== "archived" && isValidTransition("archived", to));
    expect(outbound).toHaveLength(0);
  });

  it("ALLOWED_TRANSITIONS[archived] is an empty set", () => {
    expect(ALLOWED_TRANSITIONS["archived"].size).toBe(0);
  });
});

// ─── validateTransition ───────────────────────────────────────────────────────

describe("validateTransition — allowed moves return null", () => {
  it("returns null for pending → queued", () => {
    expect(validateTransition("pending", "queued")).toBeNull();
  });

  it("returns null for running → completed", () => {
    expect(validateTransition("running", "completed")).toBeNull();
  });

  it("returns null for completed → archived", () => {
    expect(validateTransition("completed", "archived")).toBeNull();
  });

  it("returns null for a no-op (same state)", () => {
    expect(validateTransition("running", "running")).toBeNull();
  });
});

describe("validateTransition — invalid moves return an error", () => {
  it("returns a non-null error for running → pending", () => {
    const err = validateTransition("running", "pending");
    expect(err).not.toBeNull();
  });

  it("error has field = 'status'", () => {
    const err = validateTransition("running", "queued");
    expect(err?.field).toBe("status");
  });

  it("error message names both states", () => {
    const err = validateTransition("running", "pending");
    expect(err?.message).toMatch(/running/);
    expect(err?.message).toMatch(/pending/);
  });

  it("error message lists allowed next states for the from state", () => {
    const err = validateTransition("running", "pending");
    // running can go to completed, failed, paused
    expect(err?.message).toMatch(/completed/);
    expect(err?.message).toMatch(/failed/);
    expect(err?.message).toMatch(/paused/);
  });

  it("terminal-state error mentions 'terminal state'", () => {
    const err = validateTransition("archived", "pending");
    expect(err?.message).toMatch(/terminal state/i);
  });

  it("blocks archived → any other status", () => {
    for (const to of ALL_STATUSES) {
      if (to === "archived") continue; // no-op is fine
      expect(validateTransition("archived", to)).not.toBeNull();
    }
  });
});

// ─── Dispatch invariants ──────────────────────────────────────────────────────

describe("DISPATCHABLE_STATUSES — which states allow a new dispatch", () => {
  it("includes queued", () => {
    expect(DISPATCHABLE_STATUSES.has("queued")).toBe(true);
  });

  it("includes pending", () => {
    expect(DISPATCHABLE_STATUSES.has("pending")).toBe(true);
  });

  it("does NOT include running (double-dispatch prevention)", () => {
    expect(DISPATCHABLE_STATUSES.has("running")).toBe(false);
  });

  it("does NOT include completed, failed, archived, or paused", () => {
    for (const s of ["completed", "failed", "archived", "paused"] as TaskStatus[]) {
      expect(DISPATCHABLE_STATUSES.has(s)).toBe(false);
    }
  });
});

describe("isDispatchable", () => {
  it("returns true for queued", () => {
    expect(isDispatchable("queued")).toBe(true);
  });

  it("returns true for pending", () => {
    expect(isDispatchable("pending")).toBe(true);
  });

  it.each(["running", "paused", "completed", "failed", "archived"] as TaskStatus[])(
    "returns false for %s",
    (s) => {
      expect(isDispatchable(s)).toBe(false);
    },
  );
});

// ─── Auto-advance invariants ──────────────────────────────────────────────────

describe("QUEUE_AUTO_ADVANCE_FROM", () => {
  it("is 'pending'", () => {
    expect(QUEUE_AUTO_ADVANCE_FROM).toBe("pending");
  });

  it("pending → queued is a valid transition (auto-advance is a legal move)", () => {
    expect(isValidTransition(QUEUE_AUTO_ADVANCE_FROM, "queued")).toBe(true);
  });

  it("no other status auto-advances to queued (prevents double-queuing)", () => {
    // Only 'pending' should be the auto-advance source.
    // All others must NOT be equal to QUEUE_AUTO_ADVANCE_FROM.
    const otherStatuses = ALL_STATUSES.filter((s) => s !== "pending");
    for (const s of otherStatuses) {
      expect(s).not.toBe(QUEUE_AUTO_ADVANCE_FROM);
    }
  });
});

describe("Auto-advance: task assignment triggers pending → queued transition", () => {
  // These tests encode the rule from tasks/[id]/route.ts:
  //   if (current.status === "pending" && assigning server/agent) → set status = "queued"
  // They verify the transition table supports this flow.

  it("pending → queued is allowed (resource assignment advances the queue)", () => {
    expect(isValidTransition("pending", "queued")).toBe(true);
  });

  it("queued task stays queueable if already queued (idempotent re-assignment)", () => {
    // queued → queued is a no-op, always valid
    expect(isValidTransition("queued", "queued")).toBe(true);
  });

  it("running task must NOT be re-queued by re-assignment", () => {
    // running → queued is invalid; re-assigning a running task should not overwrite its state
    expect(isValidTransition("running", "queued")).toBe(false);
  });

  it("completed task must NOT be auto-advanced to queued", () => {
    expect(isValidTransition("completed", "queued")).toBe(false);
  });

  it("archived task must NOT be auto-advanced to queued", () => {
    expect(isValidTransition("archived", "queued")).toBe(false);
  });
});

// ─── Completion detection invariant ──────────────────────────────────────────

describe("Completion detection: running → completed is the only valid path", () => {
  it("running → completed is allowed", () => {
    expect(isValidTransition("running", "completed")).toBe(true);
  });

  it("queued task cannot jump directly to completed", () => {
    expect(isValidTransition("queued", "completed")).toBe(false);
  });

  it("pending task cannot jump directly to completed", () => {
    expect(isValidTransition("pending", "completed")).toBe(false);
  });

  it("paused task cannot jump directly to completed (must resume first)", () => {
    expect(isValidTransition("paused", "completed")).toBe(false);
  });
});

// ─── Review flow invariants ───────────────────────────────────────────────────

describe("Review flow: completed → archived or pending", () => {
  it("completed → archived (verdict: done)", () => {
    expect(isValidTransition("completed", "archived")).toBe(true);
  });

  it("completed → pending (verdict: incomplete — retry)", () => {
    expect(isValidTransition("completed", "pending")).toBe(true);
  });

  it("completed cannot be set to running again without going through pending/queued", () => {
    expect(isValidTransition("completed", "running")).toBe(false);
  });
});

// ─── Full transition-table coverage ──────────────────────────────────────────

describe("ALLOWED_TRANSITIONS — structural invariants", () => {
  it("every status has an entry in the transition table", () => {
    for (const s of ALL_STATUSES) {
      expect(ALLOWED_TRANSITIONS).toHaveProperty(s);
    }
  });

  it("every allowed destination is itself a valid status", () => {
    const validSet = new Set(ALL_STATUSES);
    for (const [, destinations] of Object.entries(ALLOWED_TRANSITIONS)) {
      for (const dest of destinations as Set<TaskStatus>) {
        expect(validSet.has(dest)).toBe(true);
      }
    }
  });

  it("no status can transition to itself via the table (no-ops handled separately)", () => {
    for (const [from, destinations] of Object.entries(ALLOWED_TRANSITIONS)) {
      expect((destinations as Set<TaskStatus>).has(from as TaskStatus)).toBe(false);
    }
  });
});
