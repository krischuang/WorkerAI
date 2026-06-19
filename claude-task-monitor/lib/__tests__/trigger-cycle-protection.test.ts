/**
 * TC-1 — Trigger Cycle Abuse Protection Tests
 *
 * Verifies that POST /api/projects/[id]/trigger-cycle enforces:
 *   1. Rate limiting (max 3 requests per 60 s per project)
 *   2. autoImprovementPaused guard (rejects with 409 when paused)
 *
 * Tests cover:
 *   - paused project returns 409
 *   - rate limit returns 429 after threshold
 *   - normal trigger cycle succeeds when not paused and within rate limit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    project: { findUnique: vi.fn(), update: vi.fn() },
  },
}));

vi.mock("@/lib/improvement-cycle-service", () => ({
  startDueImprovementCycles: vi.fn(),
}));

vi.mock("@/lib/api-error", () => ({
  serverError: vi.fn((_tag: string, err: unknown) => {
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }),
}));

// Use real api-rate-limit but with an isolated store so tests don't share state.
// We reset the global store between tests via the exported accessor.
import { getApiRateLimitStore } from "../api-rate-limit";

import { POST } from "../../app/api/projects/[id]/trigger-cycle/route";
import { prisma } from "@/lib/prisma";
import { startDueImprovementCycles } from "@/lib/improvement-cycle-service";

const mockProjectFindUnique = vi.mocked(prisma.project.findUnique);
const mockProjectUpdate = vi.mocked(prisma.project.update);
const mockStartCycles = vi.mocked(startDueImprovementCycles);

function makeRequest() {
  return {
    json: async () => ({}),
    cookies: { get: () => undefined },
    headers: { get: () => null },
  } as never;
}

function makeCtx(id = "proj-1") {
  return { params: Promise.resolve({ id }) };
}

function activeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj-1",
    improvementAutomationLevel: 2,
    autoImprovementPaused: false,
    nextImprovementCycleAt: null,
    lastImprovementCycleAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Clear the rate-limit store so tests are independent
  getApiRateLimitStore().clear();

  mockProjectUpdate.mockResolvedValue({} as never);
  mockStartCycles.mockResolvedValue(undefined);
  mockProjectFindUnique
    .mockResolvedValueOnce(activeProject() as never)   // first call in POST (pre-check)
    .mockResolvedValueOnce(activeProject() as never);  // second call (return updated state)
});

afterEach(() => {
  getApiRateLimitStore().clear();
});

// ── Paused project ────────────────────────────────────────────────────────────

describe("trigger-cycle — autoImprovementPaused guard", () => {
  it("returns 409 when autoImprovementPaused is true", async () => {
    mockProjectFindUnique.mockReset();
    mockProjectFindUnique.mockResolvedValue(activeProject({ autoImprovementPaused: true }) as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body.error).toMatch(/paused/i);
  });

  it("does not start a cycle when project is paused", async () => {
    mockProjectFindUnique.mockReset();
    mockProjectFindUnique.mockResolvedValue(activeProject({ autoImprovementPaused: true }) as never);

    await POST(makeRequest(), makeCtx());
    expect(mockStartCycles).not.toHaveBeenCalled();
  });

  it("does not update nextImprovementCycleAt when project is paused", async () => {
    mockProjectFindUnique.mockReset();
    mockProjectFindUnique.mockResolvedValue(activeProject({ autoImprovementPaused: true }) as never);

    await POST(makeRequest(), makeCtx());
    expect(mockProjectUpdate).not.toHaveBeenCalled();
  });

  it("returns 400 when automation is disabled (level 0)", async () => {
    mockProjectFindUnique.mockReset();
    mockProjectFindUnique.mockResolvedValue(activeProject({ improvementAutomationLevel: 0, autoImprovementPaused: false }) as never);

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toMatch(/disabled/i);
  });
});

// ── Rate limit ────────────────────────────────────────────────────────────────

describe("trigger-cycle — rate limiting", () => {
  it("allows the first request through", async () => {
    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).not.toBe(429);
  });

  it("returns 429 after the rate limit is exhausted (3 per 60s)", async () => {
    // The rate limit key is `project:trigger-cycle:${id}`, max 3 per 60_000 ms.
    // Exhaust the limit with 3 successful requests, then the 4th must be blocked.
    for (let i = 0; i < 3; i++) {
      // Reset prisma mock for each call so all 3 succeed
      mockProjectFindUnique
        .mockResolvedValueOnce(activeProject() as never)
        .mockResolvedValueOnce(activeProject() as never);
      await POST(makeRequest(), makeCtx());
    }

    // 4th request should be rate-limited
    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(429);
  });

  it("rate-limited response includes Retry-After header", async () => {
    for (let i = 0; i < 3; i++) {
      mockProjectFindUnique
        .mockResolvedValueOnce(activeProject() as never)
        .mockResolvedValueOnce(activeProject() as never);
      await POST(makeRequest(), makeCtx());
    }

    const res = await POST(makeRequest(), makeCtx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  it("rate limits are per-project — different project IDs have independent limits", async () => {
    // Exhaust limit for proj-1
    for (let i = 0; i < 3; i++) {
      mockProjectFindUnique
        .mockResolvedValueOnce(activeProject({ id: "proj-1" }) as never)
        .mockResolvedValueOnce(activeProject({ id: "proj-1" }) as never);
      await POST(makeRequest(), makeCtx("proj-1"));
    }

    // proj-2 should still be allowed
    mockProjectFindUnique
      .mockResolvedValueOnce(activeProject({ id: "proj-2" }) as never)
      .mockResolvedValueOnce(activeProject({ id: "proj-2" }) as never);
    const res = await POST(makeRequest(), makeCtx("proj-2"));
    expect(res.status).not.toBe(429);
  });

  it("rate-limited request does not trigger a cycle", async () => {
    for (let i = 0; i < 3; i++) {
      mockProjectFindUnique
        .mockResolvedValueOnce(activeProject() as never)
        .mockResolvedValueOnce(activeProject() as never);
      await POST(makeRequest(), makeCtx());
    }

    vi.clearAllMocks();
    await POST(makeRequest(), makeCtx());
    expect(mockStartCycles).not.toHaveBeenCalled();
  });
});

// ── Normal trigger cycle ──────────────────────────────────────────────────────

describe("trigger-cycle — successful trigger", () => {
  it("returns 200 with triggered: true on success", async () => {
    const res = await POST(makeRequest(), makeCtx());
    // Not 429, 409, 400, or 404
    expect([200, 201]).toContain(res.status);

    const body = await res.json();
    expect(body.triggered).toBe(true);
  });

  it("calls startDueImprovementCycles to begin the cycle", async () => {
    await POST(makeRequest(), makeCtx());
    expect(mockStartCycles).toHaveBeenCalledOnce();
  });

  it("updates nextImprovementCycleAt to the past so the cycle runs immediately", async () => {
    await POST(makeRequest(), makeCtx());

    expect(mockProjectUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "proj-1" },
      data: expect.objectContaining({
        nextImprovementCycleAt: expect.any(Date),
      }),
    }));

    const updatedDate = mockProjectUpdate.mock.calls[0][0].data.nextImprovementCycleAt as Date;
    expect(updatedDate.getTime()).toBeLessThan(Date.now());
  });

  it("returns 404 for a non-existent project", async () => {
    mockProjectFindUnique.mockReset();
    mockProjectFindUnique.mockResolvedValue(null);

    const res = await POST(makeRequest(), makeCtx("does-not-exist"));
    expect(res.status).toBe(404);
  });
});
