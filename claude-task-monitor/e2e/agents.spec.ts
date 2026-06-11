/**
 * E2E tests for agent CRUD, usage display, and launch-claude endpoint.
 *
 * All SSH-dependent operations (claude-usage, launch-claude) are expected to
 * fail at the SSH layer (TEST-NET host) and return a predictable error shape
 * rather than succeed. The tests verify the error structure, not live SSH.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

const PREFIX = `e2e-agent-${Date.now()}`;

let api: APIRequestContext;
let serverId: string;
let agentId: string;

test.describe("Agents", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });

    // Create a parent server for agents.
    const srv = await api.post("/api/servers", {
      data: {
        name: `${PREFIX}-srv`,
        host: "192.0.2.3",
        username: "e2e",
        sshKeyPath: "/tmp/e2e-key",
        claudePermissionMode: "workspace_write",
      },
    });
    expect(srv.status()).toBe(201);
    serverId = (await srv.json()).id;
  });

  test.afterAll(async () => {
    if (agentId)  await api.delete(`/api/agents/${agentId}`).catch(() => {});
    if (serverId) await api.delete(`/api/servers/${serverId}`).catch(() => {});
    await api.dispose();
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  test("POST /api/agents — creates agent under server and returns 201", async () => {
    const res = await api.post("/api/agents", {
      data: {
        serverId,
        name: `${PREFIX}-agent-1`,
        slug: `${PREFIX.replace(/_/g, "-")}-a1`,
        workDir: "/home/e2e/agent",
        tmuxSession: `${PREFIX}-session`,
        claudePermissionMode: "full_autonomous",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-agent-1`);
    expect(body.serverId).toBe(serverId);
    expect(body.claudePermissionMode).toBe("full_autonomous");
    expect(body.status).toBe("idle");
    agentId = body.id;
  });

  test("POST /api/agents — returns 400 when serverId is missing", async () => {
    const res = await api.post("/api/agents", {
      data: { name: "orphan", slug: "orphan", workDir: "/tmp", tmuxSession: "s" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/agents — returns 400 when slug is invalid format", async () => {
    const res = await api.post("/api/agents", {
      data: {
        serverId,
        name: "Bad Slug Agent",
        slug: "UPPERCASE_INVALID",
        workDir: "/tmp",
        tmuxSession: "s2",
      },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/agents — returns 404 when server does not exist", async () => {
    const res = await api.post("/api/agents", {
      data: {
        serverId: "nonexistentserverid00000000",
        name: "Ghost",
        slug: "ghost",
        workDir: "/tmp",
        tmuxSession: "ghost-session",
      },
    });
    expect(res.status()).toBe(404);
  });

  // ── List ───────────────────────────────────────────────────────────────────

  test("GET /api/agents — returns list including the new agent", async () => {
    const res = await api.get("/api/agents");
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  test("GET /api/agents?serverId= — filters agents by server", async () => {
    const res = await api.get(`/api/agents?serverId=${serverId}`);
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(agents.every((a: { serverId: string }) => a.serverId === serverId)).toBe(true);
    expect(agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  // ── Detail ─────────────────────────────────────────────────────────────────

  test("GET /api/agents/:id — returns agent with server info", async () => {
    const res = await api.get(`/api/agents/${agentId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(agentId);
    expect(body.server?.id).toBe(serverId);
    expect(body._count?.tasks).toBeGreaterThanOrEqual(0);
  });

  test("GET /api/agents/:id — returns 404 for unknown id", async () => {
    const res = await api.get("/api/agents/nonexistentid000000000000");
    expect(res.status()).toBe(404);
  });

  // ── Edit ───────────────────────────────────────────────────────────────────

  test("PUT /api/agents/:id — updates agent name and permission mode", async () => {
    const res = await api.put(`/api/agents/${agentId}`, {
      data: { name: `${PREFIX}-agent-1-renamed`, claudePermissionMode: "workspace_write" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-agent-1-renamed`);
    expect(body.claudePermissionMode).toBe("workspace_write");
  });

  // ── Usage endpoint (SSH fails gracefully) ─────────────────────────────────

  test("POST /api/agents/:id/claude-usage — fails at SSH but returns JSON error shape", async () => {
    const res = await api.post(`/api/agents/${agentId}/claude-usage`);
    // Should return a JSON response (error or success), never a 500 crash.
    expect([200, 400, 500, 502]).toContain(res.status());
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("application/json");
  });

  // ── Launch Claude endpoint (SSH fails gracefully) ─────────────────────────

  test("POST /api/agents/:id/launch-claude — returns JSON even when SSH is unavailable", async () => {
    const res = await api.post(`/api/agents/${agentId}/launch-claude`, {
      data: { mode: "workspace_write" },
    });
    expect([200, 400, 500, 502]).toContain(res.status());
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("application/json");
  });

  // ── Page render ────────────────────────────────────────────────────────────

  test("GET /agents — agents list page returns 200 with HTML", async () => {
    const res = await api.get("/agents");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /agents/:id — agent detail page returns 200 with HTML", async () => {
    const res = await api.get(`/agents/${agentId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("self.__next_f");
  });
});
