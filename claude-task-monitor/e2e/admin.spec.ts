/**
 * E2E tests for admin pages: audit log viewer and worker health dashboard.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

let api: APIRequestContext;

test.describe("Admin — Audit Log", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ── Audit log API ──────────────────────────────────────────────────────────

  test("GET /api/audit — returns 200 with paginated events array", async () => {
    const res = await api.get("/api/audit");
    expect(res.status()).toBe(200);
    const body = await res.json();
    // Response is { items: [...], hasMore: bool } or a plain array.
    const items = Array.isArray(body) ? body : (body.items ?? body.events ?? []);
    expect(Array.isArray(items)).toBe(true);
  });

  test("GET /api/audit — each event has entityType, eventType, and createdAt", async () => {
    const res = await api.get("/api/audit");
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items ?? []);
    for (const event of items.slice(0, 5)) {
      expect(typeof event.entityType).toBe("string");
      expect(typeof event.eventType).toBe("string");
      expect(event.createdAt).toBeTruthy();
    }
  });

  test("GET /api/audit?entityType=project — filters by entity type", async () => {
    const res = await api.get("/api/audit?entityType=project");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items ?? []);
    for (const event of items) {
      expect(event.entityType).toBe("project");
    }
  });

  test("GET /api/audit?eventType=project.created — filters by event type", async () => {
    const res = await api.get("/api/audit?eventType=project.created");
    expect(res.status()).toBe(200);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (body.items ?? []);
    for (const event of items) {
      expect(event.eventType).toBe("project.created");
    }
  });

  test("GET /api/audit — returns pagination cursor or hasMore flag", async () => {
    const res = await api.get("/api/audit");
    const body = await res.json();
    if (!Array.isArray(body)) {
      // Response is { events, nextCursor } or { items, hasMore } depending on version.
      const hasPagination =
        "nextCursor" in body ||
        "hasMore" in body ||
        "cursor" in body;
      expect(hasPagination).toBe(true);
    }
  });

  // ── Health dashboard API ───────────────────────────────────────────────────

  test("GET /api/health — returns 200 with servers and agents arrays", async () => {
    const res = await api.get("/api/health");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.servers)).toBe(true);
    expect(Array.isArray(body.agents)).toBe(true);
  });

  test("GET /api/health — server entries have status and name fields", async () => {
    const res = await api.get("/api/health");
    const { servers } = await res.json();
    for (const srv of servers) {
      expect(typeof srv.id).toBe("string");
      expect(typeof srv.name).toBe("string");
      expect(["unknown", "connected", "failed"]).toContain(srv.status);
    }
  });

  test("GET /api/health — agent entries have status and name fields", async () => {
    const res = await api.get("/api/health");
    const { agents } = await res.json();
    for (const agent of agents) {
      expect(typeof agent.id).toBe("string");
      expect(typeof agent.name).toBe("string");
      expect(["idle", "running", "offline", "error"]).toContain(agent.status);
    }
  });

  // ── Analytics API ──────────────────────────────────────────────────────────

  test("GET /api/analytics/weekly — returns array of weekly analytics rows", async () => {
    const res = await api.get("/api/analytics/weekly");
    expect(res.status()).toBe(200);
    const rows = await res.json();
    expect(Array.isArray(rows)).toBe(true);
  });

  test("GET /api/analytics/summary — returns summary KPI object", async () => {
    const res = await api.get("/api/analytics/summary");
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.totalCompleted).toBe("number");
    expect(typeof body.totalFailed).toBe("number");
    expect(typeof body.totalCreated).toBe("number");
  });

  test("POST /api/analytics/weekly — generates weekly analytics and returns 200 or 201", async () => {
    const res = await api.post("/api/analytics/weekly");
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body.weekStart).toBeTruthy();
  });

  // ── Admin page render ──────────────────────────────────────────────────────

  test("GET /admin/audit — audit log page returns 200 with HTML", async () => {
    const res = await api.get("/admin/audit");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /admin/health — health monitor page returns 200 with HTML", async () => {
    const res = await api.get("/admin/health");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /analytics — analytics dashboard page returns 200 with HTML", async () => {
    const res = await api.get("/analytics");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /admin/audit — HTML page body is a valid Next.js shell", async () => {
    const res = await api.get("/admin/audit");
    const html = await res.text();
    expect(html).toContain("self.__next_f");
  });

  test("GET /admin/health — HTML page body is a valid Next.js shell", async () => {
    const res = await api.get("/admin/health");
    const html = await res.text();
    expect(html).toContain("self.__next_f");
  });
});
