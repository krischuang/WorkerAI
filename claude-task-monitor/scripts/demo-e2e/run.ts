/**
 * Demo Day end-to-end runner.
 *
 * Spins up two disposable, localhost-only Docker containers (a worker with
 * sshd + tmux, and a throwaway Postgres), wires them together, then runs
 * scripts/demo-e2e/scenario.ts against the real production code paths
 * (lib/task-dispatch.ts, lib/kill-switch.ts, lib/policy-engine.ts,
 * lib/validation-gate.ts). No production credentials, hosts, or databases
 * are touched anywhere in this script.
 *
 * Usage:
 *   npx tsx scripts/demo-e2e/run.ts            # run the scenario, leave containers up
 *   npx tsx scripts/demo-e2e/run.ts --teardown  # run the scenario, then remove containers
 *   npx tsx scripts/demo-e2e/run.ts --clean     # just remove any leftover demo containers
 */

import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const WORKER_NAME = "workerai-demo-worker";
const DB_NAME = "workerai-demo-db";
const SSH_PORT = 2223;
const DB_PORT = 5434;
const SCRATCH_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "workerai_demo_e2e_"));
const KEY_PATH = path.join(SCRATCH_DIR, "demo_ed25519");
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function sh(cmd: string, opts: { silent?: boolean } = {}): string {
  if (!opts.silent) console.log(`$ ${cmd}`);
  return execSync(cmd, { cwd: REPO_ROOT, stdio: opts.silent ? "pipe" : "inherit" })?.toString() ?? "";
}

function shQuiet(cmd: string): { ok: boolean; out: string } {
  const res = spawnSync("bash", ["-c", cmd], { cwd: REPO_ROOT, encoding: "utf8" });
  return { ok: res.status === 0, out: (res.stdout ?? "") + (res.stderr ?? "") };
}

function cleanupContainers() {
  console.log("\n[cleanup] removing any existing demo containers...");
  spawnSync("docker", ["rm", "-f", WORKER_NAME], { stdio: "ignore" });
  spawnSync("docker", ["rm", "-f", DB_NAME], { stdio: "ignore" });
}

async function waitFor(label: string, checkCmd: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (shQuiet(checkCmd).ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--clean")) {
    cleanupContainers();
    return;
  }

  cleanupContainers();

  console.log("\n[1/6] Generating disposable SSH keypair (scratch dir, not ~/.ssh)...");
  sh(`ssh-keygen -t ed25519 -N "" -f ${KEY_PATH} -C "workerai-demo"`, { silent: true });
  const pubKey = fs.readFileSync(`${KEY_PATH}.pub`, "utf8").trim();

  console.log("\n[2/6] Building disposable worker image (sshd + tmux + git + node)...");
  sh(`docker build -q -t workerai-demo-worker -f scripts/demo-e2e/Dockerfile.worker scripts/demo-e2e`);

  console.log("\n[3/6] Starting worker + disposable Postgres (localhost-only ports)...");
  sh(`docker run -d --name ${WORKER_NAME} -p 127.0.0.1:${SSH_PORT}:22 workerai-demo-worker`);
  sh(`docker run -d --name ${DB_NAME} -e POSTGRES_PASSWORD=postgres_dev -e POSTGRES_DB=claude_task_monitor -p 127.0.0.1:${DB_PORT}:5432 postgres:16`);

  await waitFor("worker sshd", `docker exec ${WORKER_NAME} true`, 20_000);
  sh(`docker exec ${WORKER_NAME} bash -c "mkdir -p /home/demo/.ssh && echo '${pubKey}' > /home/demo/.ssh/authorized_keys && chown -R demo:demo /home/demo/.ssh && chmod 600 /home/demo/.ssh/authorized_keys"`);
  await waitFor(
    "SSH reachable on 127.0.0.1",
    `ssh -i ${KEY_PATH} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 -p ${SSH_PORT} demo@127.0.0.1 true`,
    20_000,
  );

  console.log("\n[4/6] Seeding the disposable demo repo (real git repo, real test file)...");
  sh(
    `docker exec -u demo ${WORKER_NAME} bash -c '` +
      `mkdir -p /home/demo/workspace/repo && cd /home/demo/workspace/repo && ` +
      `git init -q && git config user.email demo@workerai.local && git config user.name "WorkerAI Demo" && ` +
      `printf "%s" ${JSON.stringify(JSON.stringify({
        name: "demo-repo", private: true,
        scripts: { lint: "node -e \"process.exit(0)\"", typecheck: "node -e \"process.exit(0)\"", test: "node test.js", build: "node -e \"process.exit(0)\"" },
      }))} > package.json && ` +
      `printf "function add(a, b) { return a + b; }\\nmodule.exports = { add };\\n" > math.js && ` +
      `printf "const assert = require(\\"assert\\");\\nassert.strictEqual(require(\\"./math\\").add(2, 2), 4, \\"add(2,2) should be 4\\");\\nconsole.log(\\"add test passing\\");\\n" > test.js && ` +
      `git add -A && git commit -q -m "baseline: add() with passing test"` +
      `'`,
  );

  console.log("\n[5/6] Starting the stand-in 'claude' process in a real tmux session...");
  sh(`docker exec -u demo ${WORKER_NAME} tmux new-session -d -s claude-demo "/home/demo/fake-claude.sh"`);

  await waitFor("Postgres ready", `docker exec ${DB_NAME} pg_isready -U postgres`, 20_000);
  const databaseUrl = `postgresql://postgres:postgres_dev@127.0.0.1:${DB_PORT}/claude_task_monitor?schema=public`;
  console.log("\n[6/6] Running Prisma migrations against the disposable database...");
  console.log(`$ npx prisma migrate deploy  (DATABASE_URL -> disposable db on port ${DB_PORT})`);
  const migrate = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
  });
  if (migrate.status !== 0) throw new Error("prisma migrate deploy failed against the disposable database");

  console.log("\n================ RUNNING SCENARIO ================\n");
  const scenarioEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SSH_KEY_ALLOWED_PATHS: SCRATCH_DIR,
    DEMO_SSH_PORT: String(SSH_PORT),
    DEMO_SSH_KEY_PATH: KEY_PATH,
  };
  const result = spawnSync("npx", ["tsx", "scripts/demo-e2e/scenario.ts"], {
    cwd: REPO_ROOT,
    env: scenarioEnv,
    stdio: "inherit",
  });

  if (args.includes("--teardown")) {
    cleanupContainers();
    fs.rmSync(SCRATCH_DIR, { recursive: true, force: true });
  } else {
    console.log(`\n[done] Containers left running for inspection / the live demo.`);
    console.log(`  Worker SSH: ssh -i ${KEY_PATH} -p ${SSH_PORT} demo@127.0.0.1`);
    console.log(`  Demo DB:    ${databaseUrl}`);
    console.log(`  Tear down:  npx tsx scripts/demo-e2e/run.ts --clean`);
    console.log(`  (scratch key dir: ${SCRATCH_DIR} — delete manually after tearing down)`);
  }

  process.exit(result.status ?? 1);
}

main().catch((err) => {
  console.error("[demo-e2e] run.ts failed:", err);
  process.exit(1);
});
