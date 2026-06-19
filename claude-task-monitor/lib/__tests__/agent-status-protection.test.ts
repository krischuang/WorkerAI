/**
 * SH-3 — Agent Status Manipulation Tests
 *
 * Verifies that the PUT /api/agents/[id] handler does not allow user-supplied
 * status values to be written to the database. Agent status must be system-
 * controlled only (managed by the background poller and dispatch layer).
 *
 * Tests cover:
 *   - status field is ignored even when provided in the request body
 *   - normal agent update fields (name, workDir, tmuxSession, etc.) still work
 *   - the Prisma update call never contains the status field from user input
 *   - lifecycle transitions via the API are not possible
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Next.js server primitives before importing the route handler
vi.mock("next/server", () => {
  class MockNextResponse {
    static json(data: unknown, init?: { status?: number }) {
      return { _data: data, _status: init?.status ?? 200, json: async () => data };
    }
  }
  return { NextRequest: class {}, NextResponse: MockNextResponse };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    agent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/admin-audit-log", () => ({ logAdminAction: vi.fn() }));

vi.mock("@/lib/task-validation", () => ({
  validateTmuxSession: vi.fn(() => null),
  validateWorkDir: vi.fn(() => null),
}));

vi.mock("@/lib/sanitize-response", () => ({
  sanitizeAgentServer: vi.fn((a: unknown) => a),
}));

vi.mock("@/lib/json-response", () => ({
  jsonResponse: vi.fn((data: unknown) => ({ _data: data })),
}));

vi.mock("@/lib/api-error", () => ({
  serverError: vi.fn((_tag: string, err: unknown) => {
    throw err;
  }),
}));

import { PUT } from "../../app/api/agents/[id]/route";
import { prisma } from "@/lib/prisma";

const mockAgentUpdate = vi.mocked(prisma.agent.update);

function makeRequest(body: Record<string, unknown>) {
  return {
    json: async () => body,
    cookies: { get: () => undefined },
    headers: { get: () => null },
    url: "http://localhost/api/agents/agent-1",
  } as never;
}

const CTX = { params: Promise.resolve({ id: "agent-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  mockAgentUpdate.mockResolvedValue({
    id: "agent-1",
    name: "Agent",
    workDir: "/work",
    tmuxSession: "session",
    status: "idle",
    claudePermissionMode: "workspace_write",
    maxConcurrentTasks: 1,
    tags: [],
    server: { id: "srv1", name: "Server", host: "h", username: "u", port: 22, sshKeyPath: "/k" },
    _count: { tasks: 0 },
  } as never);
});

// ── Status field ignored ──────────────────────────────────────────────────────

describe("agent PUT — status field is system-controlled", () => {
  it("does not forward status to prisma.agent.update", async () => {
    await PUT(makeRequest({ name: "Updated Agent", status: "offline" }), CTX);

    expect(mockAgentUpdate).toHaveBeenCalledOnce();
    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("does not forward status: 'error' to the database", async () => {
    await PUT(makeRequest({ status: "error" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("does not forward status: 'running' (fake stuck-agent injection attempt)", async () => {
    await PUT(makeRequest({ status: "running" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("ignores status even when combined with legitimate fields", async () => {
    await PUT(makeRequest({ name: "New Name", status: "offline", tags: ["gpu"] }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
    expect(updateCall.data).toHaveProperty("name", "New Name");
    expect(updateCall.data).toHaveProperty("tags");
  });
});

// ── Normal agent updates ──────────────────────────────────────────────────────

describe("agent PUT — legitimate fields are still accepted", () => {
  it("forwards name to prisma.agent.update", async () => {
    await PUT(makeRequest({ name: "Renamed Agent" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).toMatchObject({ name: "Renamed Agent" });
  });

  it("forwards workDir to prisma.agent.update", async () => {
    await PUT(makeRequest({ workDir: "/home/user/projects" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty("workDir", "/home/user/projects");
  });

  it("forwards tmuxSession to prisma.agent.update", async () => {
    await PUT(makeRequest({ tmuxSession: "claude-2" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty("tmuxSession", "claude-2");
  });

  it("forwards claudePermissionMode to prisma.agent.update", async () => {
    await PUT(makeRequest({ claudePermissionMode: "full_autonomous" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty("claudePermissionMode", "full_autonomous");
  });

  it("forwards maxConcurrentTasks to prisma.agent.update", async () => {
    await PUT(makeRequest({ maxConcurrentTasks: 3 }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).toHaveProperty("maxConcurrentTasks", 3);
  });

  it("normalises tags to lowercase trimmed strings", async () => {
    await PUT(makeRequest({ tags: [" GPU ", "Fast"] }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data.tags).toEqual(["gpu", "fast"]);
  });
});

// ── Lifecycle transitions via API ─────────────────────────────────────────────

describe("agent PUT — lifecycle transitions are not user-controllable", () => {
  it("cannot transition agent from idle to running via the API", async () => {
    await PUT(makeRequest({ status: "running" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("cannot transition agent from running to idle via the API", async () => {
    await PUT(makeRequest({ status: "idle" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });

  it("cannot mark agent as offline to kill its running tasks via the API", async () => {
    await PUT(makeRequest({ status: "offline" }), CTX);

    const updateCall = mockAgentUpdate.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty("status");
  });
});
