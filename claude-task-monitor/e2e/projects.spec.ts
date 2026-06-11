/**
 * E2E tests for project CRUD and task-count display.
 *
 * Creates isolated test data via API (PREFIX-namespaced) and cleans up in
 * afterAll so the suite is safe to run against a shared dev database.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

const PREFIX = `e2e-proj-${Date.now()}`;

let api: APIRequestContext;
let projectId: string;
let taskId: string;

test.describe("Projects", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });
  });

  test.afterAll(async () => {
    if (projectId) await api.delete(`/api/projects/${projectId}`).catch(() => {});
    await api.dispose();
  });

  // ── Create ─────────────────────────────────────────────────────────────────

  test("POST /api/projects — creates project with required fields", async () => {
    const res = await api.post("/api/projects", {
      data: {
        name: `${PREFIX}-alpha`,
        description: "E2E test project",
        priority: "P1",
        status: "active",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-alpha`);
    expect(body.priority).toBe("P1");
    expect(body.status).toBe("active");
    expect(body.id).toBeTruthy();
    projectId = body.id;
  });

  test("POST /api/projects — returns 400 when name is missing", async () => {
    const res = await api.post("/api/projects", {
      data: { priority: "P2", status: "active" },
    });
    expect(res.status()).toBe(400);
  });

  // ── List ───────────────────────────────────────────────────────────────────

  test("GET /api/projects — new project appears in list", async () => {
    const res = await api.get("/api/projects");
    expect(res.status()).toBe(200);
    const projects = await res.json();
    expect(Array.isArray(projects)).toBe(true);
    expect(projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
  });

  // ── Detail ─────────────────────────────────────────────────────────────────

  test("GET /api/projects/:id — returns project with tasks array", async () => {
    const res = await api.get(`/api/projects/${projectId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(projectId);
    expect(body.name).toBe(`${PREFIX}-alpha`);
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  test("GET /api/projects/:id — returns 404 for unknown id", async () => {
    const res = await api.get("/api/projects/nonexistentid000000000000");
    expect(res.status()).toBe(404);
  });

  // ── Task count ─────────────────────────────────────────────────────────────

  test("task count increments when a task is added to the project", async () => {
    // Check count before
    const before = await api.get(`/api/projects/${projectId}`);
    const beforeBody = await before.json();
    const countBefore = beforeBody.tasks.length;

    // Add a task
    const taskRes = await api.post("/api/tasks", {
      data: { projectId, title: `${PREFIX}-task-1`, priority: "P2", taskType: "coding" },
    });
    expect(taskRes.status()).toBe(201);
    taskId = (await taskRes.json()).id;

    // Check count after
    const after = await api.get(`/api/projects/${projectId}`);
    const afterBody = await after.json();
    expect(afterBody.tasks.length).toBe(countBefore + 1);
  });

  test("project task list includes the created task", async () => {
    const res = await api.get(`/api/projects/${projectId}`);
    const body = await res.json();
    expect(body.tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
  });

  // ── Edit ───────────────────────────────────────────────────────────────────

  test("PUT /api/projects/:id — updates project name and priority", async () => {
    const res = await api.put(`/api/projects/${projectId}`, {
      data: { name: `${PREFIX}-alpha-renamed`, priority: "P3" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-alpha-renamed`);
    expect(body.priority).toBe("P3");
  });

  test("PUT /api/projects/:id — updates status to paused", async () => {
    const res = await api.put(`/api/projects/${projectId}`, {
      data: { status: "paused" },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).status).toBe("paused");
  });

  // ── Page render ────────────────────────────────────────────────────────────

  test("GET /projects — page returns 200 with HTML", async () => {
    const res = await api.get("/projects");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /projects/:id — project detail page returns 200 with HTML", async () => {
    const res = await api.get(`/projects/${projectId}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  // ── Delete ─────────────────────────────────────────────────────────────────

  test("DELETE /api/projects/:id — removes project and returns 200", async () => {
    // Create a disposable project to avoid affecting the main test project.
    const create = await api.post("/api/projects", {
      data: { name: `${PREFIX}-disposable`, priority: "P4", status: "active" },
    });
    const { id } = await create.json();

    const del = await api.delete(`/api/projects/${id}`);
    expect([200, 204]).toContain(del.status());

    const check = await api.get(`/api/projects/${id}`);
    expect(check.status()).toBe(404);
  });
});
