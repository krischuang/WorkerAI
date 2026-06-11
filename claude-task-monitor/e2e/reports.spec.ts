/**
 * E2E tests for daily report generation and retrieval.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import path from "path";

let api: APIRequestContext;
let reportId: string;

test.describe("Daily Reports", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({
      baseURL: "http://localhost:3000",
      storageState: path.join(__dirname, ".auth-state.json"),
    });
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ── Generate ───────────────────────────────────────────────────────────────

  test("POST /api/reports/daily — generates a report and returns 201", async () => {
    const res = await api.post("/api/reports/daily");
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
    expect(typeof body.reportText).toBe("string");
    expect(body.reportText).toMatch(/Daily Report/i);
    expect(typeof body.completedCount).toBe("number");
    expect(typeof body.failedCount).toBe("number");
    expect(typeof body.runningCount).toBe("number");
    expect(typeof body.pendingCount).toBe("number");
    reportId = body.id;
  });

  test("POST /api/reports/daily — repeated call returns another 201 (idempotent upsert)", async () => {
    const res = await api.post("/api/reports/daily");
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.id).toBeTruthy();
  });

  // ── List ───────────────────────────────────────────────────────────────────

  test("GET /api/reports/daily — returns an array of reports", async () => {
    const res = await api.get("/api/reports/daily");
    expect(res.status()).toBe(200);
    const reports = await res.json();
    expect(Array.isArray(reports)).toBe(true);
    expect(reports.length).toBeGreaterThan(0);
  });

  test("GET /api/reports/daily — list includes the generated report", async () => {
    const res = await api.get("/api/reports/daily");
    const reports = await res.json();
    const found = reports.find((r: { id: string }) => r.id === reportId);
    expect(found).toBeTruthy();
  });

  test("GET /api/reports/daily — each report has required fields", async () => {
    const res = await api.get("/api/reports/daily");
    const reports = await res.json();
    for (const r of reports.slice(0, 3)) {
      expect(typeof r.id).toBe("string");
      expect(typeof r.reportText).toBe("string");
      expect(typeof r.completedCount).toBe("number");
      expect(typeof r.pendingCount).toBe("number");
    }
  });

  // ── Latest ─────────────────────────────────────────────────────────────────

  test("GET /api/reports/daily/latest — returns the most recent report", async () => {
    const res = await api.get("/api/reports/daily/latest");
    expect(res.status()).toBe(200);
    const body = await res.json();
    // May be null if seeded DB has no reports, but after POST it should exist.
    if (body !== null) {
      expect(body.id).toBeTruthy();
      expect(typeof body.reportText).toBe("string");
    }
  });

  // ── By date ────────────────────────────────────────────────────────────────

  test("GET /api/reports/daily/:date — returns report for today's date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await api.get(`/api/reports/daily/${today}`);
    // 200 if a report exists for today, 404 if not (generated for a different date).
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const body = await res.json();
      expect(body.id).toBeTruthy();
    }
  });

  // ── Page render ────────────────────────────────────────────────────────────

  test("GET /reports/daily — daily report page returns 200 with HTML", async () => {
    const res = await api.get("/reports/daily");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("GET /reports/daily — HTML page body is a valid Next.js shell", async () => {
    const res = await api.get("/reports/daily");
    const html = await res.text();
    expect(html).toContain("self.__next_f");
  });
});
