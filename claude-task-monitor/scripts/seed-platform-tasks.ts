import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../app/generated/prisma/client";
import pg from "pg";

const adapter = new PrismaPg(process.env.DATABASE_URL!);
const prisma = new PrismaClient({ adapter });

const PROJECT_ID = "cmq6ldsxs0000mm5uuxbgs1s8";

const tasks: {
  title: string;
  description: string;
  priority: "P1" | "P2" | "P3" | "P4";
  taskType: "coding" | "research" | "writing" | "review" | "maintenance";
  estimatedCostLevel: "low" | "medium" | "high";
}[] = [
  // ── P0 Critical Reliability ─────────────────────────────────────────────────
  {
    title: "Worker Health Monitor",
    description: `Continuously evaluate and score the health of every server and agent. Track SSH latency, tmux session presence, Claude process state, and consecutive failure streaks. Store WorkerHealth history records each cycle. Surface a 0–100 health score on server/agent cards and a /admin/health dashboard. Prerequisite for Auto Recovery.

DB: Add WorkerHealth model, healthScore + consecutiveFailures + lastHealthCheckAt to Server and Agent.
API: GET /api/health, GET /api/servers/[id]/health, GET /api/agents/[id]/health.
Scheduler: runHealthChecks() every 5 poller cycles (~5 min) using Promise.allSettled across all workers.
Health score: SSH responds +40, tmux present +30, Claude online +20, latency <500ms +10.`,
    priority: "P1",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Claude Session Auto Recovery",
    description: `When a worker's Claude session is detected offline (tmuxMissing or consecutiveFailures >= 2), automatically call launchClaudeInTmux() to relaunch it without human intervention. Log every recovery attempt to RecoveryLog. Respect maxRecoveryAttempts cap (default 3). Add manual Recover button on server/agent detail pages.

DB: Add RecoveryLog model, autoRecovery + recoveryAttempts + maxRecoveryAttempts + lastRecoveryAt to Server and Agent.
API: POST /api/servers/[id]/recover, POST /api/agents/[id]/recover, GET /api/recovery-logs.
Scheduler: After health checks — for offline workers with autoRecovery=true and attempts < max, call launchClaudeInTmux().
Safety: only recover workers with no running tasks to avoid session corruption.`,
    priority: "P1",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Zombie Task Detection",
    description: `Detect tasks stuck in running state with zero measurable progress beyond a configurable stall threshold. Compare current tmux pane line count against stored tmuxOutputOffset across two consecutive poller cycles before confirming. Auto-fail confirmed zombies and kill their per-task tmux session.

DB: Add SystemConfig model (key/value pairs for thresholds), timeoutMinutes + lastProgressAt + stallDetectedAt to Task.
API: GET /api/tasks?stalled=true, POST /api/tasks/[id]/force-fail, GET/PUT /api/admin/config.
Scheduler: detectZombieTasks() every poller cycle — two-cycle confirmation before failing.
Default thresholds: stall_threshold_minutes=30, confirm_cycles=2.`,
    priority: "P1",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Task Retry Engine",
    description: `Automatically retry failed tasks according to configurable per-task policies: maxRetries count, delay schedule (2min → 5min → 10min capped), and failure reason filtering. Non-retryable reasons (task_not_dispatchable, no_resource) excluded.

DB: Add retryCount + maxRetries + retryAfter + lastFailReason to Task; add retryNumber + failureReason to ExecutionLog.
API: POST /api/tasks/[id]/retry (manual immediate retry), maxRetries accepted in PUT /api/tasks/[id].
Worker: After writing failed status in task-service.ts — evaluate retry eligibility, reset to pending, increment counter, set retryAfter.
Queue advance: skip tasks where retryAfter > now.`,
    priority: "P1",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Task Execution Timeout",
    description: `Enforce a hard wall-clock timeout per task. Resolution order: task.timeoutMinutes → server/agent defaultTaskTimeoutMinutes → SystemConfig global default (120 min). Auto-fail tasks that exceed their timeout; log errorMessage = "Execution timeout (Xmin)"; kill the per-task tmux session.

DB: Task.timeoutMinutes (shared with Zombie Detection task), defaultTaskTimeoutMinutes on Server and Agent.
API: timeoutMinutes accepted in POST /api/tasks and PUT /api/tasks/[id]; timeoutExpiresAt computed field in GET /api/tasks/[id].
Scheduler: In running-task scan loop — read startedAt from latest ExecutionLog, compare against resolved timeout.
UI: Progress bar showing elapsed vs timeout on running task detail page. Build this task first — simplest, highest-value P0 change.`,
    priority: "P1",
    taskType: "coding",
    estimatedCostLevel: "low",
  },

  // ── P1 Queue & Capacity Management ─────────────────────────────────────────
  {
    title: "Task Dependency System",
    description: `Allow tasks to declare prerequisite tasks. Dependent tasks stay in pending until all prerequisites reach completed or archived. Use denormalized blockedByCount for fast queue filtering. Enforce DFS cycle detection on every new dependency edge before inserting.

DB: Add TaskDependency junction model (taskId + dependsOnId, unique constraint), blockedByCount to Task.
API: POST /api/tasks/[id]/dependencies (body: { dependsOnId }), DELETE /api/tasks/[id]/dependencies/[depId], GET /api/tasks/[id]/dependencies. Cycle detection returns 409.
Scheduler: After task completion — decrement blockedByCount on all dependents; auto-advance to queued when blockedByCount = 0.
Queue advance: add blockedByCount: 0 filter to findFirst.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "high",
  },
  {
    title: "Project Progress Calculation",
    description: `Compute and store each project's completion percentage and task distribution in real time. Calculate a velocity-based ETA from tasks completed in the last 7 days.

DB: Add completionPct + totalTasks + completedTasks + failedTasks + runningTasks + pendingTasks + progressUpdatedAt + estimatedCompletionAt to Project.
API: GET /api/projects/[id] returns progress fields; POST /api/projects/[id]/recalculate; GET /api/projects/[id]/velocity.
Scheduler: recalculateProjectProgress(projectId) after every task status change; full reconciliation every 10 poller cycles to prevent drift.
Formula: completionPct = (completedTasks + archivedTasks) / totalTasks * 100.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Queue Prioritization Engine",
    description: `Replace the simple priority+createdAt queue ordering with a multi-factor score. Recompute in bulk before each queue advance using a single SQL UPDATE with CASE WHEN.

Score formula:
  base = { P1:100, P2:75, P3:50, P4:25 }[priority]
  ageBonus = min(50, hoursWaiting * 1)
  costPenalty = { high:-10, medium:0, low:+5 }[estimatedCostLevel]
  depPenalty = hasDependencies ? -15 : 0
  affinityBonus = previouslyRunOnThisServer ? +15 : 0

DB: Add queueScore + queueScoreUpdatedAt to Task.
API: GET /api/queue adds queueScore field; GET /api/queue?serverId=X.
Scheduler: recomputeQueueScores(serverId) in _advanceServerQueue before findFirst; order by queueScore DESC.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Server Capacity Scoring",
    description: `Score each server's available capacity using usage headroom, active task slots, and health. Update every poller cycle. Surface as a capacity bar on server cards and in the task assignment dropdown.

Capacity formula:
  usageHeadroom = (100 - max(sessionPct, weekPct)) * 0.5   // 0-50
  taskSlotRoom  = (1 - activeTaskCount/maxConcurrentTasks) * 30  // 0-30
  healthContrib = (healthScore ?? 50) * 0.2                // 0-20

DB: Add capacityScore + activeTaskCount + maxConcurrentTasks (default 10) + capacityUpdatedAt to Server.
API: GET /api/servers/capacity (all servers), GET /api/servers/[id]/capacity (detailed breakdown).
Scheduler: Compute and persist capacity for all servers at the start of each poller cycle.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Usage-Based Auto Pause & Resume",
    description: `When a server or agent hits the 90% usage threshold, create a ScheduledResume record targeting the exact quota reset time. A poller step fires the resume the moment that time arrives — eliminating 60+ wasted dispatch skip cycles per quota period.

DB: Add ScheduledResume model (resourceType + resourceId + resumeAt + triggered); add pausedDueToUsage + pausedAt + autoPauseEnabled to Server and Agent.
API: POST /api/servers/[id]/pause, POST /api/servers/[id]/resume, POST /api/agents/[id]/pause, POST /api/agents/[id]/resume, GET /api/scheduled-resumes.
Scheduler: On usage-blocked dispatch — upsert ScheduledResume; triggerDueResumes() step every cycle queries where resumeAt <= now AND triggered=false.
UI: Resume countdown timer on server/agent cards and detail pages.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },

  // ── P2 Observability ────────────────────────────────────────────────────────
  {
    title: "Audit Timeline",
    description: `Immutable, append-only event log for every meaningful state change across tasks, projects, servers, and agents. Add emitAudit(event) helper in lib/audit.ts; call it from task-service.ts, task-dispatch.ts, instrumentation.node.ts, and API routes. Foundational data layer for analytics and the improvement engine.

DB: Add AuditEvent model (entityType + entityId + eventType + actorType + payload JSON + createdAt); composite indexes on (entityType, entityId, createdAt) and (eventType, createdAt).
Initial events: task.created/queued/dispatched/completed/failed/timeout/retried, task.review.sent/done/incomplete, agent.offline/recovered, server.status_changed.
API: GET /api/audit?entityType=X&entityId=Y, GET /api/audit?eventType=Z&since=W (cursor-paginated, 50/page).
UI: Timeline tab on task detail, activity feed on project page, /admin/audit search page.`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Execution History Storage",
    description: `Enrich ExecutionLog with structured metadata captured at completion: durationMs, exitReason, paneCapture (last 200 lines of tmux output), retryNumber, failureReason. Add PostgreSQL tsvector full-text search. Nightly archival of logs older than 90 days.

DB: Extend ExecutionLog with durationMs + exitReason (completion_marker/idle_fallback/timeout/manual/error) + paneCapture + retryNumber + failureReason + archivedAt + searchVector (tsvector); GIN index on searchVector.
API: GET /api/execution-logs?taskId&projectId&since&exitReason, GET /api/execution-logs/[id] (full detail with paneCapture), GET /api/execution-logs/search?q= (full-text).
Scheduler: Store paneCapture at completion; nightly archival step at 1 AM UTC (set archivedAt, compress logText to null, keep outputSummary and metadata).`,
    priority: "P2",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Task Template Library",
    description: `Pre-defined reusable task templates with {{variable}} placeholder substitution. Ship 5 built-in templates: Code Review, Write Tests, Fix Bug, Update Documentation, Refactor. Operators can create custom templates. Built-in templates cannot be edited or deleted.

DB: Add TaskTemplate model (name + category + taskType + estimatedCostLevel + priority + titleTemplate + descriptionTemplate + variables JSON + isBuiltIn + usageCount).
API: GET/POST /api/task-templates, GET/PUT/DELETE /api/task-templates/[id], POST /api/task-templates/[id]/use (body: { projectId, variables }) returns created Task.
Variable substitution: safe regex-based replacement — no eval or template engines.
UI: /task-templates browse page; "Create from Template" modal with variable form on project/tasks pages.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Automated Daily Reports",
    description: `Generate daily operational reports automatically via the poller at 1 AM UTC, without requiring a manual POST /api/reports/daily. Refactor existing generation logic into a shared generateDailyReport() service function used by both the poller and the manual API route.

DB: Extend DailyReport with queuedCount + retriedCount + timedOutCount + recoveryCount + avgExecutionMinutes + activeServerCount + activeAgentCount + generatedBy ("manual"|"auto") + periodStart + periodEnd.
API: GET /api/reports/daily/[date] (YYYY-MM-DD), GET /api/reports/daily/latest.
Scheduler: runDailyReportIfNeeded() in poller — if today's UTC-date report is missing and hour >= 1, generate with generatedBy="auto".
UI: "Auto" badge on auto-generated reports; today's summary widget on dashboard.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "low",
  },
  {
    title: "Weekly Productivity Analytics",
    description: `Aggregate weekly throughput, quality, performance, and infrastructure metrics into WeeklyAnalytics records. Use PostgreSQL percentile_cont() for p50/p95 execution time. Surface as charts on a new /analytics dashboard page.

Metrics: tasksCompleted/Failed/Retried/TimedOut/Created, reviewsRun/Passed/Failed, avgExecutionMinutes + p50 + p95, workerRecoveries, dispatchFailures.

DB: Add WeeklyAnalytics model (weekStart + weekEnd + metric counters); unique on weekStart.
API: GET /api/analytics/weekly (last 12 weeks), GET /api/analytics/weekly/[weekStart], GET /api/analytics/summary (rolling 30-day KPIs).
Scheduler: Every Monday 1 AM UTC — compute prior-week analytics from ExecutionLog + AuditEvent using GROUP BY and window functions (single query, not app-level loops).
UI: /analytics page with completion bar chart, failure rate trend, duration trend, KPI summary cards.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },

  // ── P3 Autonomous Improvement ───────────────────────────────────────────────
  {
    title: "AI Task Reviewer",
    description: `After a task completes, automatically queue it for a structured Claude quality review with a 5-minute grace delay. Gate progression to archived on a "done" verdict; reset to pending on "incomplete". Process max 3 reviews per poller cycle. Extends existing reviewTask() in task-service.ts to support agent sessions.

DB: Add autoReviewEnabled to Project; add autoReviewEnabled + reviewStatus + reviewScheduledAt + reviewStartedAt + reviewCompletedAt + reviewVerdictNotes to Task.
API: GET /api/tasks?reviewStatus=pending, POST /api/tasks/[id]/skip-review, PUT /api/projects/[id] accepts autoReviewEnabled.
Scheduler: After task completion with autoReviewEnabled=true — set reviewStatus=pending, reviewScheduledAt=now+5min. processReviewQueue() step: find due reviews, call reviewTask(), update reviewStatus.
Guard: do not run review if server has other running tasks.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Project Improvement Scanner",
    description: `Periodically compile all completed task summaries for a project and send them to Claude for gap analysis: unmet goals, coverage gaps, architectural patterns, and suggested next tasks. Parse structured JSON findings. Truncate to last 50 task summaries for context safety.

DB: Add ProjectScan model (scanType + status + findings JSON + findingsCount + scannedTaskCount + runOnServerId + startedAt + completedAt); add autoScanEnabled + scanFrequencyDays + lastScannedAt to Project.
API: POST /api/projects/[id]/scan (body: { scanType }), GET /api/projects/[id]/scans, GET /api/project-scans/[id].
Scheduler: Weekly runDueProjectScans() for active projects with autoScanEnabled=true, completionPct > 50%, and scan overdue.
Scan prompt: XML-fenced task summaries via prompt-sanitiser.ts; require JSON output { findings: [{ type, title, severity, description, suggestedAction }] }.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "high",
  },
  {
    title: "Technical Debt Detector",
    description: `Run a specialised debt-detection scan against a project's task history to surface TODO/FIXME patterns, deferred tests, hardcoded values, missing error handling, undocumented APIs, security shortcuts, and performance anti-patterns. Store findings as DebtItem records with severity and category.

DB: Add DebtItem model (title + description + severity: low/medium/high/critical + category: architecture/testing/documentation/security/performance + status: open/acknowledged/in_progress/resolved/wont_fix + evidence JSON + resolvedAt).
API: GET /api/projects/[id]/debt (filter by status/severity), PUT /api/debt/[id], GET /api/debt?status=open&severity=high.
UI: Debt Register tab on project detail; severity-coloured items; "Create task to resolve" button; open debt count badge; debt trend chart (open items over 8 weeks).
Reuses ProjectScan infrastructure with scanType="debt".`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Backlog Generator",
    description: `Convert scan findings, debt items, and review verdicts into structured TaskSuggestion records. Human-approval staging area before suggestions become real Tasks. Cap at 10 suggestions per scan. De-duplicate against existing open suggestions.

DB: Add TaskSuggestion model (sourceType: scan/debt/review/manual + sourceId + title + description + priority + taskType + estimatedCostLevel + rationale + status: pending_review/approved/rejected/converted + convertedTaskId + reviewNote + reviewedAt).
API: GET /api/projects/[id]/suggestions, POST /api/suggestions/[id]/approve (creates Task), POST /api/suggestions/[id]/reject, PUT /api/suggestions/[id] (edit before approving), POST /api/projects/[id]/generate-suggestions.
UI: Suggestions tab on project page with approve/reject/edit flow, bulk approve/reject, suggestion count badge.
Scheduler: After ProjectScan completes — generateSuggestionsFromScan(scanId); after DebtItem created — generateSuggestionFromDebt(debtItemId).`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "medium",
  },
  {
    title: "Continuous Improvement Engine",
    description: `Orchestrate the complete autonomous improvement cycle as an 8-state machine per project. One state transition per poller tick — non-blocking. Configurable automationLevel per project.

State machine: idle → scanning → detecting_debt → generating_suggestions → awaiting_approval → executing → reviewing → completed → (schedule next cycle)

Automation levels:
  0 = disabled
  1 = scan + detect + suggest, stops for human approval
  2 = level 1 + auto-approve low-severity suggestions
  3 = fully autonomous (auto-approve all, auto-queue, auto-execute, auto-review, auto-rescan)

Safeguards: max 10 tasks/cycle, Level 3 blocked when agent uses full_autonomous Claude permission mode, 7-day cycle hard timeout, all actions emit AuditEvent records.

DB: Add ImprovementCycle model (status + automationLevel + scanId + counters + cycleError + startedAt + completedAt + nextCycleAt); add improvementAutomationLevel + cycleFrequencyDays + lastImprovementCycleAt + nextImprovementCycleAt to Project.
API: POST /api/projects/[id]/improvement-cycle, GET /api/projects/[id]/improvement-cycles, GET /api/improvement-cycles/[id], POST /api/improvement-cycles/[id]/cancel.
Scheduler: advanceImprovementCycles() every poller cycle; start new cycles for due projects.`,
    priority: "P3",
    taskType: "coding",
    estimatedCostLevel: "high",
  },
];

async function main() {
  console.log(`Creating ${tasks.length} platform tasks in project ${PROJECT_ID}...`);
  let created = 0;
  for (const t of tasks) {
    const task = await prisma.task.create({
      data: {
        projectId: PROJECT_ID,
        title: t.title,
        description: t.description,
        priority: t.priority,
        taskType: t.taskType,
        estimatedCostLevel: t.estimatedCostLevel,
        status: "pending",
      },
    });
    console.log(`  [${t.priority}] ${t.title} → ${task.id}`);
    created++;
  }
  console.log(`\nDone. ${created} tasks created.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
