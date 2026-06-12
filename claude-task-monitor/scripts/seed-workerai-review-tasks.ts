/**
 * Inserts 20 practical WorkerAI improvement tasks into the WorkerAI project.
 * Source: auto_project_review (2026-06-11)
 *
 * Run with: npx tsx scripts/seed-workerai-review-tasks.ts
 * Safe to re-run — skips tasks whose title already exists in the project.
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const SOURCE_TAG = "[source: auto_project_review]";

const tasks: {
  title: string;
  description: string;
  priority: "P1" | "P2" | "P3" | "P4";
  taskType: "coding" | "research" | "writing" | "review" | "maintenance";
  estimatedCostLevel: "low" | "medium" | "high";
}[] = [
  // ── Task Monitoring ──────────────────────────────────────────────────────────
  {
    title: "Persist poller heartbeat to SystemConfig for liveness monitoring",
    description: `${SOURCE_TAG}

The background poller (instrumentation.node.ts) uses a globalThis._pollerRunning flag to prevent overlapping cycles, but there is no persistent record of when the poller last ran successfully. If Next.js crashes and restarts without re-executing instrumentation.node.ts, tasks silently stop advancing.

Changes required:
1. At the end of each successful runCheck() call in instrumentation.node.ts, upsert a SystemConfig row: key="poller_last_heartbeat_at", value=new Date().toISOString().
2. Extend GET /api/admin/health to read poller_last_heartbeat_at and return { pollerAlive: boolean, lastHeartbeatAt: string | null, secondsSinceHeartbeat: number }.
3. In the admin health page (app/admin/health/page.tsx), add a "Poller" status row that turns red when secondsSinceHeartbeat > 180 (3 missed cycles).
4. No schema migration needed — SystemConfig is already a key/value store.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Show live elapsed-time counter on running tasks in task list",
    description: `${SOURCE_TAG}

The task list currently shows the task status badge but gives no indication of how long a running task has been executing. Operators must navigate to the task detail page to see timing information.

Changes required:
1. In GET /api/tasks, include the startedAt from the most recent ExecutionLog (where status='running') for running tasks.
2. In the task list UI (app/tasks/page.tsx), for tasks with status='running', show a live counter "Xm Ys" that ticks up using a setInterval (1 s) from the returned startedAt timestamp.
3. The counter should auto-stop when the task transitions away from 'running' (poll refresh handles this).
4. Style: small monospace text in blue-600, placed below the status badge.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Stuck Task Detection ─────────────────────────────────────────────────────
  {
    title: "Webhook alert for tasks stuck in running state beyond stall threshold",
    description: `${SOURCE_TAG}

The zombie detection system (lib/zombie-detection.ts) auto-fails tasks confirmed stalled over two poller cycles. However, operators have no external notification when this happens — they only discover it by checking the UI. If the webhook is configured, critical stuck-task events should fire it.

Changes required:
1. In task-service.ts, after marking a task as failed with lastFailReason containing "stall" or "zombie", call the existing fireWebhook() from lib/notification.ts with event type "task.stalled".
2. Extend the webhook payload to include stallDetectedAt, lastProgressAt, and timeStuckMinutes alongside the standard task fields.
3. Add a "task.stalled" case to the Discord embed and Slack Block formatters in notification.ts so the alert renders distinctively (amber colour / warning emoji).
4. Write a unit test in lib/__tests__/ verifying the payload shape.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Timeout Recovery ─────────────────────────────────────────────────────────
  {
    title: "Per-TaskType default timeout configuration in admin SystemConfig",
    description: `${SOURCE_TAG}

Task timeouts resolve via: task.timeoutMinutes → server/agent default → SystemConfig global (120 min). There is no way to set different defaults for different task types — a short 'review' task and a long 'coding' task both fall back to the same global default.

Changes required:
1. Add SystemConfig keys: timeout_coding_minutes, timeout_research_minutes, timeout_writing_minutes, timeout_review_minutes, timeout_maintenance_minutes. Seed defaults: coding=120, research=60, writing=45, review=30, maintenance=90.
2. In lib/task-timeout.ts, extend the timeout resolution chain to check the taskType-specific key before falling back to the global default.
3. In app/admin/config/page.tsx (or create it if absent), add a "Task Timeouts" section with a form to edit each taskType default.
4. Add a GET /api/admin/config route that returns all SystemConfig rows as { key, value }[] and a PUT /api/admin/config route that accepts { key, value } to update one entry.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Claude Session Health ────────────────────────────────────────────────────
  {
    title: "Webhook alert when agent or server consecutive failures exceed threshold",
    description: `${SOURCE_TAG}

The consecutiveFailures counter is incremented on each failed health check for servers and agents, but it only affects internal dispatch decisions (dispatch backoff). Operators are not alerted when a worker enters a prolonged failure state.

Changes required:
1. In the health-check loop inside instrumentation.node.ts, after incrementing consecutiveFailures, check if the value equals exactly 3 (threshold) to fire a single alert (not on every subsequent failure).
2. Call fireWebhook() with a new event type "worker.unhealthy" containing: resourceType ("server"|"agent"), resourceId, name, consecutiveFailures, lastErrorMessage.
3. Add Discord embed / Slack Block formatting for "worker.unhealthy" in notification.ts (red colour).
4. Add an optional SystemConfig key "worker_failure_alert_threshold" (default 3) so operators can tune sensitivity without a code change.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Retry Logic ──────────────────────────────────────────────────────────────
  {
    title: "One-click Retry button for failed tasks in the task list",
    description: `${SOURCE_TAG}

Retrying a failed task currently requires: navigate to task detail → click Retry. For operators managing many failed tasks, this is slow. The retry API (POST /api/tasks/[id]/retry) already exists.

Changes required:
1. In the task list table/card (app/tasks/page.tsx), add a small "Retry" ghost button that appears only when status='failed'.
2. On click, call POST /api/tasks/[id]/retry and optimistically update the row status to 'pending' while showing a brief loading state on the button.
3. On error (e.g., maxRetries already reached), show a toast or inline error message "Max retries reached".
4. The button should not appear if retryCount >= maxRetries (read both fields from the task list API response, extending it if necessary).`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── UI Visibility ────────────────────────────────────────────────────────────
  {
    title: "Task clone (duplicate) API endpoint and UI button",
    description: `${SOURCE_TAG}

There is no way to duplicate an existing task. Operators frequently need to re-run a task with slightly different parameters or create a batch of similar tasks. An export/import round-trip is too slow for this common use case.

Changes required:
1. Add POST /api/tasks/[id]/clone route that reads the source task and creates a new Task with: same projectId, title + " (copy)", description, priority, taskType, estimatedCostLevel, timeoutMinutes, maxRetries, disablePaneCapture — and status='pending'. Does not copy serverId, agentId, executionLogs, or any runtime state.
2. Return the newly created task as { id, title }.
3. In the task detail page (app/tasks/[id]/page.tsx), add a "Duplicate" ghost button in the actions area.
4. After successful clone, show a brief banner "Task duplicated — #newId" with a link to the new task.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Usage quota reset countdown widget on dashboard",
    description: `${SOURCE_TAG}

The Claude session and week quota reset timers (claudeSessionResetsAt, claudeWeekResetsAt) are visible on individual server/agent detail pages, but the dashboard gives no overview. Operators must click into each worker to check when quota will free up.

Changes required:
1. Extend GET /api/dashboard to include a 'quotaResets' array: [{ resourceType, resourceId, name, sessionResetsAt, weekResetsAt, sessionPct, weekPct }] sorted by nearest reset time.
2. On app/dashboard/page.tsx, add a "Quota Resets" widget that lists the next 3–5 upcoming resets with live H:MM:SS countdowns (same countdown logic as the task detail usage gate).
3. Highlight any resource currently paused (pausedDueToUsage=true) in amber.
4. Widget should be collapsible and hidden when no workers have quota data (claudeSessionResetsAt is null for all).`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Logs and Storage Control ─────────────────────────────────────────────────
  {
    title: "Configurable execution log retention policy via admin UI",
    description: `${SOURCE_TAG}

The execution log archival service (lib/execution-log-archival.ts) has a hardcoded 90-day retention window. Operators running the system long-term or on constrained storage may need to adjust this without a code change.

Changes required:
1. Read the retention period from SystemConfig key "execution_log_retention_days" (default: 90) in archiveOldExecutionLogs() instead of the hardcoded constant.
2. Add a "Storage" section in the admin config page showing: current retention setting (editable), estimated log row count from the DB (SELECT COUNT(*) FROM ExecutionLog WHERE archivedAt IS NULL AND createdAt < cutoff), and the date of the oldest unarchived log.
3. Add a "Run archival now" button that calls a new POST /api/admin/archival endpoint which triggers archiveOldExecutionLogs() on-demand and returns { archived: number }.
4. Log archival runs to the console with a count of rows archived each cycle.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Task Prioritisation ──────────────────────────────────────────────────────
  {
    title: "Inherit project priority as default when creating tasks via API",
    description: `${SOURCE_TAG}

When POST /api/tasks is called without an explicit priority, the Task model defaults to P3. If the parent project is P1, new tasks silently downgrade to P3 — inconsistent with operator intent.

Changes required:
1. In POST /api/tasks route handler, if priority is not in the request body, look up project.priority via prisma.project.findUnique and use it as the task priority.
2. Add a query param or body field skipPriorityInherit=true for callers that genuinely want P3 regardless (e.g., seed scripts).
3. Expose this behaviour in the new-task modal/form: pre-populate the priority dropdown with the project's priority, keeping it editable.
4. Document the inheritance in a brief comment in the route handler.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Approval Workflow ────────────────────────────────────────────────────────
  {
    title: "Bulk approve and reject for TaskSuggestions in the Suggestions tab",
    description: `${SOURCE_TAG}

The Suggestions tab (app/_components/SuggestionsTab.tsx) shows TaskSuggestion records with individual Approve/Reject buttons. When an improvement scan generates 10 suggestions, approving them one-by-one is tedious.

Changes required:
1. Add checkboxes to each suggestion row in SuggestionsTab.tsx with a "Select all" header checkbox.
2. When one or more are selected, show a toolbar: "Approve selected (N)" and "Reject selected (N)" buttons.
3. Add POST /api/projects/[id]/suggestions/bulk-approve and POST /api/projects/[id]/suggestions/bulk-reject endpoints accepting { ids: string[] }. Each converts (approve) or rejects the suggestions atomically in a $transaction.
4. Bulk approve creates Task records for each approved suggestion in the same transaction (reuse the existing single-approve logic).
5. Refresh the suggestion list after bulk action completes.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Security ─────────────────────────────────────────────────────────────────
  {
    title: "SSH private key file validation before saving server credentials",
    description: `${SOURCE_TAG}

When a Server is created or updated, sshKeyPath is saved without verifying the file exists or is readable. A typo or wrong path silently passes validation and only surfaces as an SSH error at dispatch time, which can be confusing.

Changes required:
1. In POST /api/servers and PUT /api/servers/[id], after resolving the SSH key path with resolveSSHKeyPath(), call fs.access(resolvedPath, fs.constants.R_OK) to verify the file is readable.
2. Return HTTP 400 with { error: "SSH key file not found or not readable: <path>" } if the check fails — before any DB write.
3. In the new-server and server-edit forms, surface this 400 message directly next to the sshKeyPath input field.
4. Skip this check if the path is unchanged in an update (compare against the existing DB value to avoid the check on irrelevant field updates).`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Database Reliability ─────────────────────────────────────────────────────
  {
    title: "Expose pg.Pool connection metrics in admin health endpoint",
    description: `${SOURCE_TAG}

The Prisma adapter uses a pg.Pool (lib/prisma.ts) with default settings (max 10 connections). Under load, the pool can exhaust and requests queue or time out — but there is no visibility into pool state. Adding pool metrics to the admin health endpoint would allow early detection of exhaustion.

Changes required:
1. Export the pg.Pool instance from lib/prisma.ts alongside the prisma client: export { pool }.
2. In GET /api/health (or a new GET /api/admin/db-health), read pool.totalCount, pool.idleCount, pool.waitingCount from the Pool object.
3. Return these as { dbPool: { total: number, idle: number, waiting: number, utilisation: number } } in the response.
4. In the admin health page, add a "Database Pool" row showing a utilisation bar (total-idle / total) that turns amber at 70% and red at 90%.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Worker Scalability ───────────────────────────────────────────────────────
  {
    title: "Support maxConcurrentTasks per agent for parallel multi-task dispatch",
    description: `${SOURCE_TAG}

The background poller dispatches at most one task per agent per cycle. Agents with sufficient Claude quota and a large workDir could handle multiple independent tasks in parallel (each in its own per-task tmux session). Server-direct tasks already have maxConcurrentTasks, but Agent does not.

Changes required:
1. Add maxConcurrentTasks Int @default(1) field to the Agent model in schema.prisma and generate a migration.
2. In the agent queue-advance loop inside instrumentation.node.ts, replace the single tryDispatchTaskToAgent call with a loop: while (runningCount < maxConcurrentTasks) dispatch the next queued task, breaking if no queued tasks remain.
3. Expose maxConcurrentTasks in PUT /api/agents/[id] and in the agent edit form (number input, min 1 max 5).
4. Show active task count vs max on the agent card (e.g., "2/3 tasks").`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },

  // ── Observability ────────────────────────────────────────────────────────────
  {
    title: "Prisma slow query logging and top-10 slow queries in admin panel",
    description: `${SOURCE_TAG}

There is no instrumentation for slow database queries. As the tasks and execution logs tables grow, unindexed or inefficient queries will cause latency spikes that are invisible until they cause user-facing errors.

Changes required:
1. In lib/prisma.ts, add a Prisma query event listener: prisma.$on('query', (e) => { if (e.duration > 500) logSlowQuery(e) }). Note: Prisma 7 uses log: [{ level: 'query', emit: 'event' }] in constructor options.
2. Implement logSlowQuery() to store the top 50 slow queries in an in-memory circular buffer (globalThis._slowQueryLog) with fields: query (truncated to 500 chars), duration, timestamp.
3. Add GET /api/admin/slow-queries that returns the buffer sorted by duration desc, limited to 10.
4. Add a "Slow Queries" tab or section in app/admin/health/page.tsx that lists the results and refreshes every 30 s.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Documentation ────────────────────────────────────────────────────────────
  {
    title: "Generate and serve OpenAPI 3.0 specification for all REST API routes",
    description: `${SOURCE_TAG}

WorkerAI has ~40 REST API routes with no machine-readable specification. This makes it hard to build integrations, write external clients, or auto-generate typed SDKs. A static OpenAPI spec served at /api/docs.json would enable tooling without requiring code generation in the build.

Changes required:
1. Create scripts/generate-openapi.ts that hand-authors an OpenAPI 3.0 JSON object covering all routes in app/api/ (paths, methods, request bodies, response schemas). Use existing TypeScript types as the source of truth for schemas.
2. Write the output to public/api-docs.json so it is served statically by Next.js.
3. Add a GET /api/docs route that returns the static file with Content-Type: application/json.
4. Add an npm script "docs:generate": "npx tsx scripts/generate-openapi.ts" to package.json.
5. Add a link to the admin panel pointing to /api/docs.json (downloadable) and optionally embed Swagger UI via CDN on /admin/api-docs page.`,
    priority: "P4",
    taskType: "writing",
    estimatedCostLevel: "medium",
  },

  // ── Deployment Stability ─────────────────────────────────────────────────────
  {
    title: "Create docker-compose.yml for one-command local development setup",
    description: `${SOURCE_TAG}

The project has a Dockerfile but no docker-compose.yml. Setting up the full local environment requires manually starting PostgreSQL, running migrations, configuring .env, and starting the app. A Compose file would reduce onboarding friction from ~20 steps to one command.

Changes required:
1. Create docker-compose.yml at the repo root (claude-task-monitor/) with two services: 'db' (postgres:16, named volume, healthcheck) and 'app' (build from Dockerfile, depends_on db, env_file .env, ports 3000 and 3099).
2. Add an 'app' entrypoint script (scripts/docker-entrypoint.sh) that runs: wait for db healthy → npx prisma migrate deploy → exec npm start.
3. Add docker-compose.override.yml.example showing how to mount a local workDir for hot-reload development (volume mount of . → /app, command override to npm run dev).
4. Document the one-command setup in README.md: docker compose up --build.`,
    priority: "P2",
    taskType: "maintenance",
    estimatedCostLevel: "low",
  },
  {
    title: "Graceful poller shutdown on SIGTERM to prevent mid-cycle DB corruption",
    description: `${SOURCE_TAG}

When the Next.js process receives SIGTERM (e.g., Docker stop, k8s pod eviction), the poller's runCheck() may be mid-cycle writing to the DB — partially updating task status, creating ExecutionLog records, or dispatching tasks. This can leave tasks in an inconsistent state (e.g., status='running' with no active SSH session).

Changes required:
1. In instrumentation.node.ts, register a process.on('SIGTERM') handler that sets globalThis._shutdownRequested = true.
2. In the tick() function, check _shutdownRequested before starting a new cycle and skip it.
3. If a cycle is already running (_pollerRunning=true) when SIGTERM fires, wait up to 30 s for it to finish (poll every 500 ms) before calling process.exit(0).
4. Log "Poller: SIGTERM received, waiting for current cycle to finish..." and "Poller: shutdown complete" at each stage.
5. Extend the type declaration for globalThis in instrumentation.node.ts to include _shutdownRequested.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Webhook Reliability ───────────────────────────────────────────────────────
  {
    title: "Webhook delivery retry with exponential backoff and failure logging",
    description: `${SOURCE_TAG}

The current webhook delivery in lib/notification.ts is fire-and-forget: a single fetch() call with no retry on network error or non-2xx response. A transient network blip causes silent notification loss with no record of the failure.

Changes required:
1. Wrap the fetch() call in fireWebhook() with a retry loop: up to 3 attempts with delays of 2 s, 8 s, 20 s (exponential, base 2×).
2. On final failure (all 3 attempts fail), log the failure via console.error and upsert a SystemConfig row key="webhook_last_failure" value=JSON.stringify({ timestamp, eventType, statusCode, error }).
3. Expose GET /api/admin/webhook-status that returns: configured (bool), lastDelivery (timestamp + status), lastFailure (timestamp + error).
4. Surface this in the admin notifications page (app/admin/notifications/page.tsx) to give operators visibility without tailing logs.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── Task Import ───────────────────────────────────────────────────────────────
  {
    title: "Task import from CSV to complement existing CSV export",
    description: `${SOURCE_TAG}

The export endpoint (GET /api/tasks/export) generates a CSV of tasks. There is no import counterpart — operators who maintain task lists in spreadsheets or want to migrate from another project must create tasks one-by-one.

Changes required:
1. Add POST /api/tasks/import accepting multipart/form-data with a 'file' field (CSV). Parse with the built-in node:stream/promises + csv-parse (install if not present) or a manual split-line approach to avoid heavy dependencies.
2. Expected columns (case-insensitive): title (required), description, priority (P1-P4, default P3), taskType, estimatedCostLevel, timeoutMinutes. Unknown columns are ignored.
3. Body also requires projectId (query param or JSON field alongside the file).
4. Validate each row; collect errors with row numbers; return { created: N, skipped: N, errors: [{ row, message }] }.
5. Add an "Import CSV" button on the task list page that opens a file picker and posts to this endpoint, displaying the result summary.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
];

async function main() {
  const project = await prisma.project.findFirst({ where: { name: "WorkerAI" } });
  if (!project) {
    console.error("ERROR: WorkerAI project not found. Run prisma/seed-workerai.ts first.");
    process.exit(1);
  }
  console.log(`Found project: ${project.name} (${project.id})`);

  let created = 0;
  let skipped = 0;

  for (const t of tasks) {
    const exists = await prisma.task.findFirst({
      where: { projectId: project.id, title: t.title },
      select: { id: true },
    });

    if (exists) {
      console.log(`  ~ skipped (exists): ${t.title}`);
      skipped++;
      continue;
    }

    const task = await prisma.task.create({
      data: {
        projectId: project.id,
        title: t.title,
        description: t.description,
        priority: t.priority,
        taskType: t.taskType,
        estimatedCostLevel: t.estimatedCostLevel,
        status: "pending",
      },
    });
    console.log(`  + [${t.priority}] ${t.title} → ${task.id}`);
    created++;
  }

  console.log(`\nDone — created ${created} task(s), skipped ${skipped} duplicate(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
