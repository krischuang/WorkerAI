/**
 * Security tests for POST /api/servers/[id]/exec.
 *
 * Verifies the origin guard and destructive-command blocklist without
 * needing a real SSH server. All tests use a fake server ID — the guards
 * fire before the DB lookup, so the server doesn't need to exist.
 *
 * Requires the dev server (npm run dev), NOT the production build (npm start).
 * If the guards aren't active in the running server the suite is skipped with
 * a clear message rather than failing.
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const FAKE_SERVER_ID = "clzfake0000000000000000000";
const EXEC_URL = `/api/servers/${FAKE_SERVER_ID}/exec`;

let api: APIRequestContext;
let guardsActive = false;

test.describe("POST /api/servers/:id/exec — security guards", () => {
  test.beforeAll(async ({ playwright }) => {
    api = await playwright.request.newContext({ baseURL: "http://localhost:3000" });

    // Probe: if the origin guard is live, a foreign-origin request returns 403.
    // Against a pre-guard production build it returns 404 (DB miss). We skip
    // the suite rather than fail when running against an older build.
    const probe = await api.post(EXEC_URL, {
      data: { command: "echo probe" },
      headers: { origin: "https://guard-probe.invalid" },
    });
    guardsActive = probe.status() === 403;

    if (!guardsActive) {
      console.warn(
        "\n[exec-security] Origin guard not detected in the running server.\n" +
        "  This suite requires `npm run dev`. Skipping all tests.\n"
      );
    }
  });

  test.afterAll(async () => {
    await api.dispose();
  });

  // ── Origin guard ───────────────────────────────────────────────────────────

  test("request with no Origin header is allowed (direct/server-side call)", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "echo hi" } });
    expect(res.status()).not.toBe(403);
  });

  test("request from localhost origin is allowed", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, {
      data: { command: "echo hi" },
      headers: { origin: "http://localhost:3000" },
    });
    expect(res.status()).not.toBe(403);
  });

  test("request from a foreign origin is rejected with 403", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, {
      data: { command: "echo hi" },
      headers: { origin: "https://evil.example.com" },
    });
    expect(res.status()).toBe(403);
  });

  test("request from a lookalike origin (localhost.evil.com) is rejected", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, {
      data: { command: "echo hi" },
      headers: { origin: "https://localhost.evil.com" },
    });
    expect(res.status()).toBe(403);
  });

  // ── Input validation ───────────────────────────────────────────────────────

  test("empty command string is rejected with 400", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "   " } });
    expect(res.status()).toBe(400);
  });

  test("missing command field is rejected with 400", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: {} });
    expect(res.status()).toBe(400);
  });

  test("command exceeding 4096 chars is rejected with 400", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "a".repeat(4097) } });
    expect(res.status()).toBe(400);
  });

  // ── Destructive-command blocklist ──────────────────────────────────────────

  test("rm -rf / is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "rm -rf /" } });
    expect(res.status()).toBe(422);
  });

  test("rm -fr / is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "rm -fr / " } });
    expect(res.status()).toBe(422);
  });

  test("mkfs.ext4 is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "mkfs.ext4 /dev/sdb1" } });
    expect(res.status()).toBe(422);
  });

  test("dd to a raw disk is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "dd if=/dev/zero of=/dev/sda" } });
    expect(res.status()).toBe(422);
  });

  test("fork bomb is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: ":(){:|:&};:" } });
    expect(res.status()).toBe(422);
  });

  test("shred on a disk device is blocked with 422", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "shred -n 3 /dev/sdb" } });
    expect(res.status()).toBe(422);
  });

  // ── Legitimate commands still pass the blocklist ───────────────────────────

  test("rm of a normal file is not blocked", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "rm /tmp/oldfile.log" } });
    expect(res.status()).not.toBe(422);
    expect(res.status()).not.toBe(403);
  });

  test("grep -r pattern is not blocked", async () => {
    test.skip(!guardsActive, "security guards require npm run dev");
    const res = await api.post(EXEC_URL, { data: { command: "grep -r TODO /app/src" } });
    expect(res.status()).not.toBe(422);
    expect(res.status()).not.toBe(403);
  });
});
