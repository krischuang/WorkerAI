/**
 * One-command readiness gate for the /demo-day live presentation.
 *
 * scripts/pre-demo-check.sh only verifies the local *environment*
 * (Docker, Postgres container, .env.local, migrations). It says nothing
 * about whether /demo-day itself — the actual page the presenter clicks
 * through on stage — will render real data. That gap is what turned
 * "seed the fixture" into a manual, easy-to-forget step: nothing told you
 * if you forgot it, or if the seed ran against the wrong database, until
 * the page was already on screen.
 *
 * This script closes that gap in one command:
 *   1. Runs pre-demo-check.sh — stops here if the environment itself isn't ready.
 *   2. Confirms the dev server is reachable (does NOT start it — starting a
 *      server as a side effect of a "check" is a common source of orphaned
 *      background processes; see CLAUDE.md's docs on dev-server lifecycle).
 *   3. Authenticates with AUTH_SECRET, the same way the browser will.
 *   4. Re-seeds the /demo-day fixture (idempotent upsert — safe to re-run
 *      right before going on stage, never destroys other data).
 *   5. Hits the exact three API calls /demo-day makes and checks the
 *      response shape AND the specific values the rehearsed script and
 *      runbook assume (0/100 vs 100/100 reliability, recommendation flip) —
 *      so a drifted seed or a code change that silently changes the numbers
 *      fails here, not mid-sentence on stage.
 *   6. Fetches /demo-day itself and confirms it does not render the
 *      "fixtures not found" fallback.
 *
 * Usage:
 *   set -a; source .env.local; set +a; npx tsx scripts/demo-day-preflight.ts
 *
 * Exit code 0 = ready to present. Non-zero = fix the printed [FAIL] lines
 * before going on stage. Never destructive; safe to run as many times as
 * you want, including right before walking on stage.
 */

import { execSync } from "child_process";

const BASE_URL = process.env.DEMO_PREFLIGHT_BASE_URL ?? "http://localhost:3000";
const HERO_TASK_ID = "_demo_day_hero_task";
const WEAK_AGENT_ID = "_demo_day_a_weak";

let pass = true;
const ok = (msg: string) => console.log(`  [OK]   ${msg}`);
const fail = (msg: string) => { console.log(`  [FAIL] ${msg}`); pass = false; };
const warn = (msg: string) => console.log(`  [WARN] ${msg}`);

// The dev server closes idle keep-alive sockets after 5s (its default
// Keep-Alive: timeout=5). The seed step above runs as a blocking execSync
// subprocess that can easily take longer than that, so Node's fetch
// (undici) can try to reuse an now-dead pooled connection for the very next
// call and fail with ECONNRESET — a connection-pool artifact, not a real
// server problem (curl from a fresh process never hits this). One retry
// with a fresh connection clears it.
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return fetch(url, init);
  }
}

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}

async function main() {
  section("Environment (scripts/pre-demo-check.sh)");
  try {
    execSync("bash scripts/pre-demo-check.sh", { stdio: "inherit" });
    ok("Environment checks passed");
  } catch {
    fail("Environment is not ready — fix the [FAIL] lines above before continuing");
    printVerdictAndExit();
    return;
  }

  section("Dev server reachability");
  let serverUp = false;
  try {
    const res = await fetchRetry(`${BASE_URL}/login`, { redirect: "manual" });
    serverUp = res.status < 500;
  } catch {
    serverUp = false;
  }
  if (serverUp) {
    ok(`Dev server responding at ${BASE_URL}`);
  } else {
    fail(`Dev server not reachable at ${BASE_URL} — start it with: npm run dev`);
    printVerdictAndExit();
    return;
  }

  section("Authentication");
  const secret = process.env.AUTH_SECRET;
  let cookie = "";
  if (!secret) {
    warn("AUTH_SECRET not set in this shell — assuming an open (pre-auth) build; skipping login");
  } else {
    const res = await fetchRetry(`${BASE_URL}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: secret }),
    });
    if (res.status === 429) {
      fail("Auth endpoint is rate-limited (429) — wait for the window to clear, do not retry rapidly");
      printVerdictAndExit();
      return;
    }
    if (!res.ok) {
      fail(`Login failed (${res.status}) — check AUTH_SECRET matches .env.local`);
      printVerdictAndExit();
      return;
    }
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) {
      fail("Login succeeded but no session cookie was returned");
      printVerdictAndExit();
      return;
    }
    cookie = setCookie.split(";")[0];
    ok("Logged in with AUTH_SECRET");
  }

  section("Seeding /demo-day fixtures (idempotent — safe to re-run)");
  try {
    execSync("npx tsx scripts/seed-demo-day.ts", { stdio: "inherit" });
    ok("Seed script completed");
  } catch {
    fail("Seed script failed — see output above");
    printVerdictAndExit();
    return;
  }

  section("Live API contract (the exact calls /demo-day makes)");
  const headers: Record<string, string> = cookie ? { Cookie: cookie } : {};

  const taskRes = await fetchRetry(`${BASE_URL}/api/tasks/${HERO_TASK_ID}`, { headers });
  if (taskRes.ok) {
    const task = await taskRes.json();
    if (task.status === "failed" && task.validationStatus === "failed") {
      ok("Hero task present with status=failed, validationStatus=failed");
    } else {
      fail(`Hero task found but status/validationStatus drifted: status=${task.status}, validationStatus=${task.validationStatus}`);
    }
  } else {
    fail(`GET /api/tasks/${HERO_TASK_ID} returned ${taskRes.status} — fixtures missing or API broken`);
  }

  const auditRes = await fetchRetry(`${BASE_URL}/api/audit?entityType=task&entityId=${HERO_TASK_ID}`, { headers });
  if (auditRes.ok) {
    const audit = await auditRes.json();
    const events = audit?.events ?? [];
    if (Array.isArray(events) && events.length > 0) {
      ok(`Audit trail present (${events.length} event(s))`);
    } else {
      fail("Audit trail is empty — Section 2's verification timeline will render blank");
    }
  } else {
    fail(`GET /api/audit returned ${auditRes.status}`);
  }

  const compareRes = await fetchRetry(`${BASE_URL}/api/agents/${WEAK_AGENT_ID}/compare?taskType=coding`, { headers });
  if (compareRes.ok) {
    const cmp = await compareRes.json();
    const baseline = cmp?.baselineReliability?.score;
    const preferred = cmp?.preferredReliability?.score;
    if (cmp?.recommendationChanged === true && baseline === 0 && preferred === 100) {
      ok("Recommendation flips as rehearsed: baseline 0/100 vs evidence-preferred 100/100");
    } else {
      fail(
        `Comparison drifted from the rehearsed numbers — recommendationChanged=${cmp?.recommendationChanged}, ` +
        `baseline=${baseline}, preferred=${preferred}. Update the script/runbook or re-check scripts/seed-demo-day.ts.`,
      );
    }
  } else {
    fail(`GET /api/agents/${WEAK_AGENT_ID}/compare returned ${compareRes.status}`);
  }

  section("/demo-day page render");
  const pageRes = await fetchRetry(`${BASE_URL}/demo-day`, { headers });
  if (pageRes.ok) {
    const html = await pageRes.text();
    if (html.includes("Demo Day fixtures not found")) {
      fail("/demo-day rendered the fallback — the page will show 'fixtures not found' on stage");
    } else {
      ok("/demo-day responded 200 without the fallback marker");
    }
  } else {
    fail(`GET /demo-day returned ${pageRes.status}`);
  }

  printVerdictAndExit();
}

function printVerdictAndExit() {
  console.log("");
  if (pass) {
    console.log("=== READY — open http://localhost:3000/demo-day and go ===");
    process.exit(0);
  } else {
    console.log("=== NOT READY — fix the [FAIL] items above before presenting ===");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[demo-day-preflight] unexpected error:", err);
  process.exit(1);
});
