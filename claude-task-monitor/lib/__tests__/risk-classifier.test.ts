import { describe, it, expect } from "vitest";
import { classifyTaskRisk } from "../risk-classifier";

describe("classifyTaskRisk — high-risk keyword categories", () => {
  it.each([
    ["Run database migration for users table", undefined],
    ["Add ALTER TABLE statement for new column", undefined],
    ["DROP TABLE legacy_sessions", undefined],
    ["Fix authentication bypass in login flow", undefined],
    ["Rotate API keys and update secrets", undefined],
    ["Deploy hotfix to production", undefined],
    ["Force-push corrected history to main", undefined],
    ["Update .env with new credentials", undefined],
  ])("classifies '%s' as high risk", (title) => {
    expect(classifyTaskRisk({ title, description: null })).toBe("high");
  });

  it("checks the description too, not just the title", () => {
    const result = classifyTaskRisk({
      title: "Improve onboarding flow",
      description: "This requires rm -rf of the old upload directory on the server.",
    });
    expect(result).toBe("high");
  });

  it("is case-insensitive", () => {
    expect(classifyTaskRisk({ title: "ROTATE the PASSWORD for the admin account" })).toBe("high");
  });
});

describe("classifyTaskRisk — default risk by taskType", () => {
  it("defaults research tasks to low", () => {
    expect(classifyTaskRisk({ title: "Investigate flaky test", taskType: "research" })).toBe("low");
  });

  it("defaults writing tasks to low", () => {
    expect(classifyTaskRisk({ title: "Write API docs", taskType: "writing" })).toBe("low");
  });

  it("defaults review tasks to low", () => {
    expect(classifyTaskRisk({ title: "Review PR #42", taskType: "review" })).toBe("low");
  });

  it("defaults maintenance tasks to medium", () => {
    expect(classifyTaskRisk({ title: "Update dependencies", taskType: "maintenance" })).toBe("medium");
  });

  it("defaults coding tasks to medium", () => {
    expect(classifyTaskRisk({ title: "Add a new button to the dashboard", taskType: "coding" })).toBe("medium");
  });

  it("defaults to medium when taskType is missing", () => {
    expect(classifyTaskRisk({ title: "Some generic task" })).toBe("medium");
  });

  it("a high-risk keyword overrides the taskType default", () => {
    expect(classifyTaskRisk({ title: "Research the production deployment process", taskType: "research" })).toBe("high");
  });
});

// ─── Server-side risk classification enforcement ──────────────────────────────
// These tests document that riskLevel is always computed server-side and cannot
// be influenced by a client-supplied value.

describe("classifyTaskRisk — server-side enforcement", () => {
  it("returns high for a task with high-risk keywords regardless of any caller intent", () => {
    // A client submitting { riskLevel: 'low' } for a migration task must NOT bypass
    // this function — the route ignores client riskLevel and always calls classifyTaskRisk.
    const result = classifyTaskRisk({ title: "Run database migration", taskType: "coding" });
    expect(result).toBe("high");
  });

  it("returns medium for a benign task — client cannot override to 'low'", () => {
    const result = classifyTaskRisk({ title: "Add a tooltip to the UI", taskType: "coding" });
    expect(result).toBe("medium");
  });

  it("high-risk description escalates a benign title to high", () => {
    const result = classifyTaskRisk({
      title: "Regular update",
      description: "Deploy the new build to production",
      taskType: "coding",
    });
    expect(result).toBe("high");
  });
});
