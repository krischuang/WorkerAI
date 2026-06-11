/**
 * E2E tests for queue ordering and priority display.
 *
 * Creates a small project with tasks at different priorities and verifies that
 * GET /api/queue returns them in project-priority → task-priority → created-at
 * order (highest priority first).
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

const PREFIX = `e2e-queue-${Date.now()}`;

let api: APIRequestContext;
let highProjId: string;
let lowProjId: string;
const createdTaskIds: string[] = [];

test.describe("Queue", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });

    // P1 project with two tasks (P1 + P3)
    const high = await api.post("/api/projects", {
      data: { name: `${PREFIX}-high`, priority: "P1", status: "active" },
    });
    highProjId = (await high.json()).id;

    // P4 project with one task (P1)
    const low = await api.post("/api/projects", {
      data: { name: `${PREFIX}-low`, priority: "P4", status: "active" },
    });
    lowProjId = (await low.json()).id;

    // Create tasks — all stay pending (no server assigned) so they appear in queue.
    for (const [projectId, title, priority] of [
      [highProjId, `${PREFIX}-high-p1`, "P1"],
      [highProjId, `${PREFIX}-high-p3`, "P3"],
      [lowProjId,  `${PREFIX}-low-p1`,  "P1"],
    ] as [string, string, string][]) {
      const t = await api.post("/api/tasks", {
        data: { projectId, title, priority, taskType: "coding" },
      });
      createdTaskIds.push((await t.json()).id);
    }
  });

  test.afterAll(async () => {
    if (highProjId) await api.delete(`/api/projects/${highProjId}`).catch(() => {});
    if (lowProjId)  await api.delete(`/api/projects/${lowProjId}`).catch(() => {});
    await api.dispose();
  });

  // ── Queue contents ─────────────────────────────────────────────────────────

  test("GET /api/queue — returns 200 with an array", async () => {
    const res = await api.get("/api/queue");
    expect(res.status()).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  test("GET /api/queue — all created tasks appear in queue as pending", async () => {
    const res = await api.get("/api/queue");
    const tasks = await res.json();
    for (const id of createdTaskIds) {
      const found = tasks.find((t: { id: string }) => t.id === id);
      expect(found).toBeTruthy();
      expect(found.status).toBe("pending");
    }
  });

  test("GET /api/queue — each task includes project info", async () => {
    const res = await api.get("/api/queue");
    const tasks = await res.json();
    const ourTasks = tasks.filter((t: { id: string }) => createdTaskIds.includes(t.id));
    for (const t of ourTasks) {
      expect(t.project?.id).toBeTruthy();
      expect(t.project?.priority).toBeTruthy();
    }
  });

  test("GET /api/queue — P1 project tasks precede P4 project tasks", async () => {
    const res = await api.get("/api/queue");
    const tasks = await res.json();
    const ourTasks = tasks.filter((t: { id: string }) => createdTaskIds.includes(t.id));

    // Find first occurrence of each project in the ordered list.
    const highIdx = ourTasks.findIndex((t: { project: { id: string } }) => t.project.id === highProjId);
    const lowIdx  = ourTasks.findIndex((t: { project: { id: string } }) => t.project.id === lowProjId);

    expect(highIdx).toBeGreaterThan(-1);
    expect(lowIdx).toBeGreaterThan(-1);
    expect(highIdx).toBeLessThan(lowIdx);
  });

  test("GET /api/queue — within the same project, P1 task precedes P3 task", async () => {
    const res = await api.get("/api/queue");
    const tasks = await res.json();
    const highTasks = tasks.filter(
      (t: { id: string; project: { id: string } }) =>
        t.project.id === highProjId && createdTaskIds.includes(t.id)
    );

    expect(highTasks.length).toBe(2);
    expect(highTasks[0].priority).toBe("P1");
    expect(highTasks[1].priority).toBe("P3");
  });

  // ── Priority display ───────────────────────────────────────────────────────

  test("GET /api/queue — all tasks have a priority field", async () => {
    const res = await api.get("/api/queue");
    const tasks = await res.json();
    const validPriorities = new Set(["P1", "P2", "P3", "P4"]);
    for (const t of tasks) {
      expect(validPriorities.has(t.priority)).toBe(true);
    }
  });

  // ── Page render ────────────────────────────────────────────────────────────

  test("GET /queue — queue page returns 200 with HTML", async () => {
    const res = await api.get("/queue");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });
});
