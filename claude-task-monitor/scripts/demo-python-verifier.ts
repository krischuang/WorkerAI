/**
 * Real end-to-end demo: Node calls the standalone Python/FastAPI verifier
 * service over HTTP, proving the two independently-authored services agree
 * on both the HMAC wire format and the verification-state vocabulary.
 *
 * This is a demo/manual-verification script, not part of the automated
 * test suite, it requires the verifier-service process to actually be
 * running (see the printed instructions if it isn't reachable).
 *
 * Usage:
 *   cd verifier-service && python3 -m venv .venv && . .venv/bin/activate \
 *     && pip install -r requirements-dev.txt \
 *     && VERIFIER_SHARED_SECRET=demo-secret uvicorn app.main:app --port 8008 &
 *   cd ../claude-task-monitor
 *   VERIFIER_SERVICE_URL=http://localhost:8008 VERIFIER_SHARED_SECRET=demo-secret \
 *     npx tsx scripts/demo-python-verifier.ts
 */

import { callVerifierService } from "../lib/verifier-client";

async function main() {
  if (!process.env.VERIFIER_SERVICE_URL || !process.env.VERIFIER_SHARED_SECRET) {
    console.error(
      "Set VERIFIER_SERVICE_URL and VERIFIER_SHARED_SECRET (must match the running " +
      "verifier-service's env) before running this script. See the file header for setup steps.",
    );
    process.exit(1);
  }

  console.log(`→ calling ${process.env.VERIFIER_SERVICE_URL}/verify ...\n`);

  const scenarios = [
    {
      name: "all independent checks pass",
      request: {
        task_id: "demo-task-pass",
        agent_reported_status: "passed" as const,
        independent_results: [
          { label: "lint", command: "npm run lint", exit_code: 0 },
          { label: "test", command: "npm test", exit_code: 0 },
        ],
        changed_files: ["src/feature.ts"],
      },
    },
    {
      name: "agent claims success but build actually failed",
      request: {
        task_id: "demo-task-disagreement",
        agent_reported_status: "passed" as const,
        independent_results: [{ label: "build", command: "npm run build", exit_code: 1 }],
        changed_files: [],
      },
    },
    {
      name: "agent touched a sensitive file (.env)",
      request: {
        task_id: "demo-task-sensitive-file",
        agent_reported_status: "passed" as const,
        independent_results: [{ label: "test", command: "npm test", exit_code: 0 }],
        changed_files: [".env"],
      },
    },
  ];

  for (const scenario of scenarios) {
    const verdict = await callVerifierService(scenario.request);
    console.log(`[${scenario.name}]`);
    console.log(verdict ? JSON.stringify(verdict, null, 2) : "  null (service unreachable or auth failed)");
    console.log();
  }
}

main();
