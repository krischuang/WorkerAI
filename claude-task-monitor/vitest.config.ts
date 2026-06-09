import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["lib/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      // Cover only the pure-function modules that are unit-testable.
      // SSH-dependent modules (ssh.ts, ssh-claude-tmux.ts) require real
      // infrastructure and are covered by the E2E suite instead.
      include: ["lib/usage-parser.ts", "lib/exec-guards.ts", "lib/ssh-key-path.ts"],
      reporter: ["text", "lcov"],
      // Minimum thresholds — enforced on every `npm test` run.
      thresholds: {
        lines: 85,
        functions: 90,
        branches: 80,
        statements: 85,
      },
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
