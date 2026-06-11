import { defineConfig } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import path from "path";

// Load .env so AUTH_SECRET is available to tests when running via CLI.
loadEnv();

export const AUTH_STATE_PATH = path.join(__dirname, "e2e", ".auth-state.json");

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
