import { describe, it, expect } from "vitest";
import { scoreAgent, selectBestAgent, type AgentCandidate } from "../agent-selector";
import { USAGE_THRESHOLD } from "../constants";

const NOW = new Date("2026-06-16T00:00:00Z");

function baseAgent(overrides: Partial<AgentCandidate> = {}): AgentCandidate {
  return {
    id: "agent-1",
    name: "Agent One",
    tags: [],
    status: "idle",
    healthScore: 100,
    activeTaskCount: 0,
    maxConcurrentTasks: 3,
    claudeSessionPct: 10,
    claudeWeekPct: 10,
    pausedDueToUsage: false,
    cooldownUntil: null,
    ...overrides,
  };
}

const NO_TAGS = { requiredTags: [] };

describe("scoreAgent — rejection rules", () => {
  it("rejects an offline agent", () => {
    const result = scoreAgent(baseAgent({ status: "offline" }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/offline/);
  });

  it("rejects an agent in error status", () => {
    const result = scoreAgent(baseAgent({ status: "error" }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/error/);
  });

  it("rejects an agent paused due to usage", () => {
    const result = scoreAgent(baseAgent({ pausedDueToUsage: true }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/paused/);
  });

  it("rejects an agent at or above the usage threshold", () => {
    const result = scoreAgent(baseAgent({ claudeSessionPct: USAGE_THRESHOLD }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/threshold/);
  });

  it("rejects an agent below the health floor", () => {
    const result = scoreAgent(baseAgent({ healthScore: 10 }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/health score/);
  });

  it("does not reject an agent with unknown (null) health score", () => {
    const result = scoreAgent(baseAgent({ healthScore: null }), NO_TAGS, NOW);
    expect(result.eligible).toBe(true);
  });

  it("rejects an agent at full capacity", () => {
    const result = scoreAgent(baseAgent({ activeTaskCount: 3, maxConcurrentTasks: 3 }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/capacity/);
  });

  it("rejects an agent missing required tags", () => {
    const result = scoreAgent(baseAgent({ tags: ["nodejs"] }), { requiredTags: ["gpu", "has-browser"] }, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/missing required tags/);
    expect(result.reasons[0]).toMatch(/gpu/);
    expect(result.reasons[0]).toMatch(/has-browser/);
  });

  it("respects cooldownUntil in the future", () => {
    const future = new Date(NOW.getTime() + 60_000);
    const result = scoreAgent(baseAgent({ cooldownUntil: future }), NO_TAGS, NOW);
    expect(result.eligible).toBe(false);
    expect(result.reasons[0]).toMatch(/cooldown/);
  });

  it("allows an agent whose cooldown has already passed", () => {
    const past = new Date(NOW.getTime() - 60_000);
    const result = scoreAgent(baseAgent({ cooldownUntil: past }), NO_TAGS, NOW);
    expect(result.eligible).toBe(true);
  });

  it("accepts an agent that has all required tags (plus extras)", () => {
    const result = scoreAgent(baseAgent({ tags: ["gpu", "has-browser", "extra"] }), { requiredTags: ["gpu", "has-browser"] }, NOW);
    expect(result.eligible).toBe(true);
  });
});

describe("scoreAgent — scoring preferences among eligible agents", () => {
  it("prefers lower usage", () => {
    const low = scoreAgent(baseAgent({ id: "low", claudeSessionPct: 5, claudeWeekPct: 5 }), NO_TAGS, NOW);
    const high = scoreAgent(baseAgent({ id: "high", claudeSessionPct: 80, claudeWeekPct: 80 }), NO_TAGS, NOW);
    expect(low.score).toBeGreaterThan(high.score);
  });

  it("prefers higher health score", () => {
    const healthy = scoreAgent(baseAgent({ id: "healthy", healthScore: 100 }), NO_TAGS, NOW);
    const unhealthy = scoreAgent(baseAgent({ id: "unhealthy", healthScore: 40 }), NO_TAGS, NOW);
    expect(healthy.score).toBeGreaterThan(unhealthy.score);
  });

  it("prefers lower active task count", () => {
    const idle = scoreAgent(baseAgent({ id: "idle", activeTaskCount: 0 }), NO_TAGS, NOW);
    const busy = scoreAgent(baseAgent({ id: "busy", activeTaskCount: 2 }), NO_TAGS, NOW);
    expect(idle.score).toBeGreaterThan(busy.score);
  });

  it("gives a bonus for matching required tags over an agent that didn't need to match any", () => {
    const matched = scoreAgent(baseAgent({ id: "matched", tags: ["gpu"] }), { requiredTags: ["gpu"] }, NOW);
    const unmatched = scoreAgent(baseAgent({ id: "unmatched" }), NO_TAGS, NOW);
    expect(matched.score).toBeGreaterThan(unmatched.score);
  });
});

describe("selectBestAgent", () => {
  it("returns null when no agents are eligible", () => {
    const agents = [baseAgent({ id: "a", status: "offline" }), baseAgent({ id: "b", pausedDueToUsage: true })];
    const result = selectBestAgent(agents, NO_TAGS, NOW);
    expect(result.agentId).toBeNull();
    expect(result.scores.every((s) => !s.eligible)).toBe(true);
  });

  it("picks the highest-scoring eligible agent, skipping rejected ones", () => {
    const agents = [
      baseAgent({ id: "offline-agent", status: "offline" }),
      baseAgent({ id: "busy-agent", activeTaskCount: 2, claudeSessionPct: 50 }),
      baseAgent({ id: "best-agent", activeTaskCount: 0, claudeSessionPct: 1, healthScore: 100 }),
    ];
    const result = selectBestAgent(agents, NO_TAGS, NOW);
    expect(result.agentId).toBe("best-agent");
  });

  it("breaks exact ties deterministically by agent id, regardless of input order", () => {
    const a = baseAgent({ id: "b-agent" });
    const b = baseAgent({ id: "a-agent" });
    const result1 = selectBestAgent([a, b], NO_TAGS, NOW);
    const result2 = selectBestAgent([b, a], NO_TAGS, NOW);
    expect(result1.agentId).toBe("a-agent");
    expect(result2.agentId).toBe("a-agent");
  });

  it("prefers an agent matching required tags over one that does not, even if otherwise equal", () => {
    const tagged = baseAgent({ id: "tagged", tags: ["gpu"] });
    const untagged = baseAgent({ id: "untagged", tags: [] });
    const result = selectBestAgent([tagged, untagged], { requiredTags: ["gpu"] }, NOW);
    expect(result.agentId).toBe("tagged");
  });
});
