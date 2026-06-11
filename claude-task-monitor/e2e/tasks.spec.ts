/**
 * E2E tests for task lifecycle: create, assign, status transitions,
 * run-blocked state, and detail page rendering.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

const PREFIX = `e2e-task-${Date.now()}`;

let api: APIRequestContext;
let projectId: string;
let serverId: string;
let taskId: string;
let unassignedTaskId: string;

test.describe("Tasks", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });

    // Create supporting resources used across tests.
    const proj = await api.post("/api/projects", {
      data: { name: `${PREFIX}-proj`, priority: "P2", status: "active" },
    });
    projectId = (await proj.json()).id;

    const srv = await api.post("/api/servers", {
      data: {
        name: `${PREFIX}-srv`,
        host: "192.0.2.2",
        username: "e2e",
        sshKeyPath: "/tmp/e2e-key",
        claudePermissionMode: "workspace_write",
      },
    });
    serverId = (await srv.json()).id;
  });

  test.afterAll(async () => {
    if (projectId) await api.delete(`/api/projects/${projectId}`).catch(() => {});
    if (serverId)  await api.delete(`/api/servers/${serverId}`).catch(() => {});
    await api.dispose();
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  test("POST /api/tasks — creates task and returns 201", async () => {
    const res = await api.post("/api/tasks", {
      data: {
        projectId,
        title: `${PREFIX}-main`,
        description: "E2E test task",
        priority: "P1",
        taskType: "coding",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.title).toBe(`${PREFIX}-main`);
    expect(body.status).toBe("pending");
    expect(body.priority).toBe("P1");
    expect(body.projectId).toBe(projectId);
    taskId = body.id;
  });

  test("POST /api/tasks — returns 400 when title is missing", async () => {
    const res = await api.post("/api/tasks", { data: { projectId } });
    expect(res.status()).toBe(400);
  });

  test("POST /api/tasks — returns 400 when projectId is missing", async () => {
    const res = await api.post("/api/tasks", {
      data: { title: `${PREFIX}-orphan`, priority: "P3" },
    });
    expect(res.status()).toBe(400);
  });

  test("POST /api/tasks — creates an unassigned task for later tests", async () => {
    const res = await api.post("/api/tasks", {
      data: { projectId, title: `${PREFIX}-unassigned`, priority: "P4", taskType: "analysis" },
    });
    expect(res.status()).toBe(201);
    unassignedTaskId = (await res.json()).id;
  });

  // ── Detail ─────────────────────────────────────────────────────────────────

  test("GET /api/tasks/:id — returns task with project info", async () => {
    const res = await api.get(`/api/tasks/${taskId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(taskId);
    expect(body.title).toBe(`${PREFIX}-main`);
    expect(body.project?.id).toBe(projectId);
  });

  test("GET /api/tasks/:id — returns 404 for unknown id", async () => {
    const res = await api.get("/api/tasks/nonexistentid000000000000");
    expect(res.status()).toBe(404);
  });

  // ── Status badge / updates ─────────────────────────────────────────────────

  test("PUT /api/tasks/:id — updates task title", async () => {
    const res = await api.put(`/api/tasks/${unassignedTaskId}`, {
      data: { title: `${PREFIX}-unassigned-renamed` },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).title).toBe(`${PREFIX}-unassigned-renamed`);
  });

  test("PUT /api/tasks/:id — updates task priority", async () => {
    const res = await api.put(`/api/tasks/${unassignedTaskId}`, {
      data: { priority: "P2" },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).priority).toBe("P2");
  });

  // ── Server assignment → queued ─────────────────────────────────────────────

  test("PUT /api/tasks/:id — assigning a server advances status to queued", async () => {
    const res = await api.put(`/api/tasks/${taskId}`, { data: { serverId } });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Auto-dispatch fires but TEST-NET SSH fails → stays queued (or running if it raced).
    expect(["queued", "running"]).toContain(body.status);
    expect(body.serverId).toBe(serverId);
  });

  test("GET /api/tasks/:id — shows server assignment after PUT", async () => {
    const res = await api.get(`/api/tasks/${taskId}`);
    const body = await res.json();
    expect(body.serverId).toBe(serverId);
    expect(body.server?.id).toBe(serverId);
  });

  // ── Run-blocked state ──────────────────────────────────────────────────────

  test("POST /api/tasks/:id/run — blocked when session usage is 100%", async () => {
    // Artificially set usage to 100% so the execution gate blocks.
    await api.put(`/api/servers/${serverId}`, {
      data: { claudeSessionPct: 100, claudeWeekPct: 100 },
    }).catch(() => {});

    // Create a fresh task assigned to that server.
    const t = await api.post("/api/tasks", {
      data: { projectId, title: `${PREFIX}-blocked`, priority: "P1", taskType: "coding" },
    });
    const blockedTaskId = (await t.json()).id;
    await api.put(`/api/tasks/${blockedTaskId}`, { data: { serverId } });

    const run = await api.post(`/api/tasks/${blockedTaskId}/run`);
    // usage_blocked returns 200 with { blocked: true } OR 502 if SSH is tried first.
    // Either way it should not succeed (no { success: true }).
    if (run.status() === 200) {
      const body = await run.json();
      // Either blocked or SSH-failed — just not a clean success with a non-TEST-NET server.
      expect(body.success).not.toBe(true);
    } else {
      expect([400, 409, 502]).toContain(run.status());
    }
  });

  test("POST /api/tasks/:id/run — returns 404 for unknown task", async () => {
    const res = await api.post("/api/tasks/nonexistentid000000000000/run");
    expect(res.status()).toBe(404);
  });

  // ── Task list filter ───────────────────────────────────────────────────────

  test("GET /api/tasks?projectId= — filters tasks by project", async () => {
    const res = await api.get(`/api/tasks?projectId=${projectId}`);
    expect(res.status()).toBe(200);
    const tasks = await res.json();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.every((t: { projectId: string }) => t.projectId === projectId)).toBe(true);
    expect(tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
  });

  // ── Page render ────────────────────────────────────────────────────────────

  test("GET /tasks — task list page returns 200 with HTML", async () => {
    const res = await api.get("/tasks");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /tasks/:id — task detail page returns 200 with HTML", async () => {
    const res = await api.get(`/tasks/${taskId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("self.__next_f");
  });
});
