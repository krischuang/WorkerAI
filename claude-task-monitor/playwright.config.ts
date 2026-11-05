import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "path";

// Load env vars so AUTH_SECRET/DATABASE_URL are available to tests when
// running via CLI. .env.local must win over .env, and since this config
// process spawns the dev server (webServer below) as a child, whatever
// DATABASE_URL ends up in THIS process's env is what the dev server
// inherits and uses for its whole lifetime, regardless of Next's own
// .env.local precedence (Next's loader never overrides an already-set
// process.env value). A developer running local E2E tests against a real
// .env containing production credentials would otherwise have every
// request silently load-balanced to production instead of the local test
// database — this was caught for real while verifying this suite (see
// 2026-11-05 session notes).
//
// IMPORTANT: do NOT use `override: true` here. That was tried first and
// caused a real regression elsewhere (see prisma.config.ts) — it clobbers
// a legitimate, explicit env var a parent process (e.g. CI) sets before
// invoking this command (ci.yml sets DATABASE_URL directly). dotenv's
// default behavior (never overwrite an already-set process.env key) is
// exactly what's needed — just load .env.local FIRST so it fills the gap
// before .env gets a chance to.
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

// ".local.json" is deliberate — see e2e/global-setup.ts's header comment.
export const AUTH_STATE_PATH = path.join(__dirname, "e2e", ".auth-state.local.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  globalSetup: "./e2e/global-setup.ts",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    storageState: AUTH_STATE_PATH,
  },
  projects: [
    {
      name: "api",
      use: {},
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
