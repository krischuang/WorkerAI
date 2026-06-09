/**
 * E2E tests for core user workflows.
 *
 * Requires the dev server to be running on http://localhost:3000.
 * All created records use a unique PREFIX and are deleted in afterAll.
 *
 * Tests run sequentially (fullyParallel: false) because later tests
 * depend on IDs produced by earlier ones.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const PREFIX = `e2e-${Date.now()}`;

let api: APIRequestContext;
let projectId: string;
let taskId: string;
let serverId: string;

test.describe("Core user workflows", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });
    // Authenticate — cookie is stored in the request context's cookie jar and
    // sent automatically on all subsequent requests.
    const secret = process.env.AUTH_SECRET;
    if (secret) {
      const res = await api.post("/api/auth", { data: { password: secret } });
      // 404 means this build predates auth — the server is still open, continue.
      if (!res.ok() && res.status() !== 404) {
        throw new Error(`E2E auth failed: ${res.status()} ${await res.text()}`);
      }
    }
  });

  test.afterAll(async () => {
    // Delete in dependency order — project cascade-deletes its tasks.
    if (projectId) await api.delete(`/api/projects/${projectId}`).catch(() => {});
    if (serverId)  await api.delete(`/api/servers/${serverId}`).catch(() => {});
    await api.dispose();
  });

  // ── 1. Project creation ────────────────────────────────────────────────────

  test("POST /api/projects — creates a project and returns 201", async () => {
    const res = await api.post("/api/projects", {
      data: { name: `${PREFIX}-project`, priority: "P2", status: "active" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-project`);
    expect(body.priority).toBe("P2");
    expect(body.id).toBeTruthy();
    projectId = body.id;
  });

  test("GET /api/projects — new project appears in list", async () => {
    const res = await api.get("/api/projects");
    expect(res.status()).toBe(200);
    const projects = await res.json();
    expect(projects.some((p: { id: string }) => p.id === projectId)).toBe(true);
  });

  // ── 2. Task creation ───────────────────────────────────────────────────────

  test("POST /api/tasks — creates a task under the project", async () => {
    const res = await api.post("/api/tasks", {
      data: {
        projectId,
        title: `${PREFIX}-task`,
        priority: "P2",
        taskType: "coding",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.title).toBe(`${PREFIX}-task`);
    expect(body.status).toBe("pending");
    expect(body.projectId).toBe(projectId);
    taskId = body.id;
  });

  test("GET /api/tasks?projectId= — task appears under its project", async () => {
    const res = await api.get(`/api/tasks?projectId=${projectId}`);
    expect(res.status()).toBe(200);
    const tasks = await res.json();
    expect(tasks.some((t: { id: string }) => t.id === taskId)).toBe(true);
  });

  test("POST /api/tasks — returns 400 when title is missing", async () => {
    const res = await api.post("/api/tasks", {
      data: { projectId },
    });
    expect(res.status()).toBe(400);
  });

  // ── 3. Queue view ──────────────────────────────────────────────────────────

  test("GET /api/queue — pending task appears in queue", async () => {
    const res = await api.get("/api/queue");
    expect(res.status()).toBe(200);
    const tasks = await res.json();
    const found = tasks.find((t: { id: string }) => t.id === taskId);
    expect(found).toBeTruthy();
    expect(found.status).toBe("pending");
    expect(found.project.id).toBe(projectId);
  });

  // ── 4. Server creation + task assignment ───────────────────────────────────

  test("POST /api/servers — creates a server and returns 201", async () => {
    const res = await api.post("/api/servers", {
      data: {
        name: `${PREFIX}-server`,
        host: "192.0.2.1",       // TEST-NET address — not routable
        username: "e2e",
        sshKeyPath: "/tmp/e2e-key",
        claudePermissionMode: "workspace_write",
      },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.name).toBe(`${PREFIX}-server`);
    serverId = body.id;
  });

  test("PUT /api/tasks/:id — assigning server advances task to queued", async () => {
    const res = await api.put(`/api/tasks/${taskId}`, {
      data: { serverId },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Auto-run fires but SSH fails for TEST-NET host → task stays queued.
    // If somehow it ran, running is also acceptable.
    expect(["queued", "running"]).toContain(body.status);
    expect(body.server?.id).toBe(serverId);
  });

  test("GET /api/tasks/:id — task detail shows server assignment", async () => {
    const res = await api.get(`/api/tasks/${taskId}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.serverId).toBe(serverId);
  });

  // ── 5. Daily report generation ─────────────────────────────────────────────

  test("POST /api/reports/daily — generates a report and returns 201", async () => {
    const res = await api.post("/api/reports/daily");
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(typeof body.reportText).toBe("string");
    expect(body.reportText).toMatch(/Daily Report/);
    expect(typeof body.completedCount).toBe("number");
    expect(typeof body.failedCount).toBe("number");
    expect(typeof body.runningCount).toBe("number");
    expect(typeof body.pendingCount).toBe("number");
  });

  test("GET /api/reports/daily — returns list including the new report", async () => {
    const res = await api.get("/api/reports/daily");
    expect(res.status()).toBe(200);
    const reports = await res.json();
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
  });

  // ── 6. Server terminal page navigation ────────────────────────────────────
  // Checked via HTTP rather than a headed browser so the tests run in
  // headless Linux environments that lack GTK/ATK system libraries.

  test("GET /servers/:id/terminal — page returns 200 with HTML", async () => {
    const res = await api.get(`/servers/${serverId}/terminal`);
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("text/html");
  });

  test("GET /servers/:id/terminal — HTML body references the terminal route", async () => {
    const res = await api.get(`/servers/${serverId}/terminal`);
    const html = await res.text();
    // App Router streams RSC payloads via self.__next_f.push; its presence
    // confirms a real page rendered (not a generic error shell).
    expect(html).toContain("self.__next_f");
    // The route chunk for the terminal page should be referenced.
    expect(html).toContain("terminal");
  });

  test("GET /servers/:id — server detail page returns 200", async () => {
    const res = await api.get(`/servers/${serverId}`);
    expect(res.status()).toBe(200);
    const ct = res.headers()["content-type"] ?? "";
    expect(ct).toContain("text/html");
  });
});
