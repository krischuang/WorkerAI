/**
 * Playwright global setup — runs once before all test files.
 *
 * Authenticates against the dev server and saves the session cookie to
 * e2e/.auth-state.json so all specs can load it as `storageState` without
 * each calling POST /api/auth individually (which would exhaust the 10 req/15
 * min brute-force rate limiter).
 */

import { request } from "@playwright/test";
import path from "path";
import fs from "fs";

export const AUTH_STATE_PATH = path.join(__dirname, ".auth-state.json");

export default async function globalSetup() {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    // No auth configured — write an empty state file so specs can still load it.
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
    return;
  }

  const ctx = await request.newContext({ baseURL: "http://localhost:3000" });

  try {
    const res = await ctx.post("/api/auth", {
      data: { password: secret },
    });

    if (res.status() === 429) {
      console.warn("[global-setup] Auth endpoint rate-limited (429). Auth-gated tests may fail.");
      fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify({ cookies: [], origins: [] }));
      return;
    }

    if (!res.ok()) {
      throw new Error(`[global-setup] Auth failed: ${res.status()} ${await res.text()}`);
    }

    await ctx.storageState({ path: AUTH_STATE_PATH });
  } finally {
    await ctx.dispose();
  }
}
