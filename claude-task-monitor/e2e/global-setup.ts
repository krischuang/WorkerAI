/**
 * Playwright global setup — runs once before all test files.
 *
 * Authenticates against the dev server and saves the session cookie to
 * e2e/.auth-state.local.json so all specs can load it as `storageState`
 * without each calling POST /api/auth individually (which would exhaust the
 * 10 req/15 min brute-force rate limiter).
 *
 * Filename deliberately ends in `.local.json`, not `.json` — this file holds
 * a real, currently-valid session cookie every time the suite runs. The
 * `.local.` segment makes it unambiguous at a glance that this path is
 * machine-local and must never be committed (see claude-task-monitor's
 * .gitignore, which matches on this exact pattern), distinct from the old
 * `e2e/.auth-state.json` name this replaces (found tracked in git history,
 * though only ever committed as an empty placeholder — see
 * docs/PENDING_CHANGES_INVENTORY.md).
 */

import { request } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";

export const AUTH_STATE_PATH = path.join(__dirname, ".auth-state.local.json");

// core-workflows.spec.ts, agents.spec.ts, and tasks.spec.ts each create a
// Server with this sshKeyPath. lib/ssh-key-path.ts's validateSshKeyPath
// rejects any path outside the app process's home directory (a deliberate
// anti-traversal control, not a bug) before even checking whether the file
// exists — so a path like /tmp/e2e-key can never pass POST /api/servers,
// no matter what's written there. Must live under os.homedir().
export const E2E_SSH_KEY_PATH = path.join(os.homedir(), ".e2e-fixtures", "e2e-key");

export default async function globalSetup() {
  // instrumentation.node.ts loads the rate_limit_enabled SystemConfig flag
  // asynchronously at server boot (a DB round-trip), and the global
  // write-rate-limit bucket (10 req/min, shared across all write endpoints)
  // is otherwise easy to exhaust within the first second or two of a
  // sequential test suite. Playwright's webServer health check only confirms
  // the HTTP server is listening, not that this async init has settled — give
  // it a moment before the suite starts hammering the API.
  await new Promise((r) => setTimeout(r, 2000));

  // Provision the shared SSH-key fixture (see E2E_SSH_KEY_PATH above). Nothing
  // previously created this file at a path that could pass validation, so the
  // very first "creates a server" test 400'd and every later test in the same
  // file that depended on its serverId cascaded into unrelated-looking 500s.
  fs.mkdirSync(path.dirname(E2E_SSH_KEY_PATH), { recursive: true });
  fs.writeFileSync(E2E_SSH_KEY_PATH, "-----BEGIN OPENSSH PRIVATE KEY-----\ne2e-fixture-not-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n", { mode: 0o600 });

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
