/**
 * scripts/generate-openapi.ts
 *
 * Hand-authored OpenAPI 3.0 specification for all WorkerAI REST API routes.
 * Run via:  npx tsx scripts/generate-openapi.ts
 * Output:   public/api-docs.json
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ── Reusable schema components ────────────────────────────────────────────────

const IdParam = {
  name: "id",
  in: "path",
  required: true,
  schema: { type: "string" },
  description: "Resource cuid identifier",
};

const PageParam = {
  name: "page",
  in: "query",
  schema: { type: "integer", default: 1 },
};

const LimitParam = {
  name: "limit",
  in: "query",
  schema: { type: "integer", default: 50, maximum: 200 },
};

const ok200 = (description = "Success") => ({
  "200": { description },
});

const ok201 = (description = "Created") => ({
  "201": { description },
});

const err400 = { "400": { description: "Bad request" } };
const err401 = { "401": { description: "Unauthorised" } };
const err404 = { "404": { description: "Not found" } };
const err500 = { "500": { description: "Internal server error" } };

const commonErrors = { ...err400, ...err401, ...err404, ...err500 };

// ── Common schema definitions ─────────────────────────────────────────────────

const schemas = {
  Project: {
    type: "object",
    properties: {
      id:          { type: "string" },
      name:        { type: "string" },
      description: { type: "string", nullable: true },
      priority:    { type: "string", enum: ["P1", "P2", "P3", "P4"] },
      status:      { type: "string", enum: ["active", "paused", "archived"] },
      createdAt:   { type: "string", format: "date-time" },
      updatedAt:   { type: "string", format: "date-time" },
    },
  },

  Task: {
    type: "object",
    properties: {
      id:                 { type: "string" },
      projectId:          { type: "string" },
      title:              { type: "string" },
      description:        { type: "string", nullable: true },
      priority:           { type: "string", enum: ["P1", "P2", "P3", "P4"] },
      status:             { type: "string", enum: ["pending", "queued", "running", "paused", "completed", "failed", "archived"] },
      taskType:           { type: "string", enum: ["coding", "research", "writing", "review", "maintenance"] },
      estimatedCostLevel: { type: "string", enum: ["low", "medium", "high"] },
      serverId:           { type: "string", nullable: true },
      agentId:            { type: "string", nullable: true },
      timeoutMinutes:     { type: "integer", nullable: true },
      maxRetries:         { type: "integer", nullable: true },
      retryCount:         { type: "integer" },
      scheduledFor:       { type: "string", format: "date-time", nullable: true },
      createdAt:          { type: "string", format: "date-time" },
      updatedAt:          { type: "string", format: "date-time" },
    },
  },

  Server: {
    type: "object",
    properties: {
      id:                   { type: "string" },
      name:                 { type: "string" },
      host:                 { type: "string" },
      port:                 { type: "integer" },
      username:             { type: "string" },
      sshKeyPath:           { type: "string" },
      tmuxSession:          { type: "string" },
      status:               { type: "string", enum: ["unknown", "connected", "failed"] },
      claudePermissionMode: { type: "string", enum: ["read_only", "workspace_write", "full_autonomous"] },
      claudeSessionPct:     { type: "number", nullable: true },
      claudeWeekPct:        { type: "number", nullable: true },
      healthScore:          { type: "number", nullable: true },
      createdAt:            { type: "string", format: "date-time" },
    },
  },

  Agent: {
    type: "object",
    properties: {
      id:                   { type: "string" },
      serverId:             { type: "string" },
      name:                 { type: "string" },
      slug:                 { type: "string" },
      workDir:              { type: "string" },
      tmuxSession:          { type: "string" },
      status:               { type: "string", enum: ["idle", "running", "offline", "error"] },
      claudePermissionMode: { type: "string", enum: ["read_only", "workspace_write", "full_autonomous"] },
      claudeSessionPct:     { type: "number", nullable: true },
      claudeWeekPct:        { type: "number", nullable: true },
      healthScore:          { type: "number", nullable: true },
      createdAt:            { type: "string", format: "date-time" },
    },
  },

  ExecutionLog: {
    type: "object",
    properties: {
      id:            { type: "string" },
      taskId:        { type: "string" },
      status:        { type: "string", enum: ["running", "completed", "failed"] },
      logText:       { type: "string", nullable: true },
      outputSummary: { type: "string", nullable: true },
      errorMessage:  { type: "string", nullable: true },
      actualCostUsd: { type: "number", nullable: true },
      durationMs:    { type: "integer", nullable: true },
      startedAt:     { type: "string", format: "date-time" },
      finishedAt:    { type: "string", format: "date-time", nullable: true },
    },
  },

  DailyReport: {
    type: "object",
    properties: {
      id:             { type: "string" },
      date:           { type: "string", format: "date" },
      completedCount: { type: "integer" },
      failedCount:    { type: "integer" },
      runningCount:   { type: "integer" },
      pendingCount:   { type: "integer" },
      reportText:     { type: "string", nullable: true },
      generatedAt:    { type: "string", format: "date-time" },
    },
  },

  TaskTemplate: {
    type: "object",
    properties: {
      id:                 { type: "string" },
      name:               { type: "string" },
      description:        { type: "string", nullable: true },
      titleTemplate:      { type: "string" },
      descriptionTemplate:{ type: "string", nullable: true },
      priority:           { type: "string", enum: ["P1", "P2", "P3", "P4"] },
      taskType:           { type: "string" },
      estimatedCostLevel: { type: "string" },
    },
  },

  ImportResult: {
    type: "object",
    properties: {
      created: { type: "integer" },
      skipped: { type: "integer" },
      errors: {
        type: "array",
        items: {
          type: "object",
          properties: {
            row:     { type: "integer" },
            message: { type: "string" },
          },
        },
      },
    },
  },

  WebhookPayload: {
    type: "object",
    properties: {
      event:       { type: "string", enum: ["task.completed", "task.failed", "task.stalled"] },
      taskId:      { type: "string" },
      title:       { type: "string" },
      status:      { type: "string" },
      projectId:   { type: "string" },
      projectName: { type: "string", nullable: true },
      agentId:     { type: "string", nullable: true },
      serverId:    { type: "string", nullable: true },
      errorMessage:{ type: "string", nullable: true },
      durationMs:  { type: "integer", nullable: true },
      timestamp:   { type: "string", format: "date-time" },
      stallDetectedAt:  { type: "string", format: "date-time", nullable: true },
      lastProgressAt:   { type: "string", format: "date-time", nullable: true },
      timeStuckMinutes: { type: "integer", nullable: true },
    },
  },

  Error: {
    type: "object",
    properties: {
      error: { type: "string" },
    },
  },
};

// ── Schema helpers ────────────────────────────────────────────────────────────

function ref(name: string) {
  return { $ref: `#/components/schemas/${name}` };
}

function arrayOf(name: string) {
  return { type: "array", items: ref(name) };
}

function jsonBody(schemaName: string, properties?: Record<string, unknown>) {
  return {
    required: true,
    content: {
      "application/json": {
        schema: properties
          ? { type: "object", properties }
          : ref(schemaName),
      },
    },
  };
}

function jsonResponse(schemaOrRef: unknown, description = "Success") {
  return {
    description,
    content: { "application/json": { schema: schemaOrRef } },
  };
}

// ── OpenAPI document ──────────────────────────────────────────────────────────

const spec = {
  openapi: "3.0.3",
  info: {
    title: "WorkerAI – Claude Task Monitor API",
    version: "1.0.0",
    description:
      "REST API for WorkerAI, a task management platform for tracking AI-assisted work across projects. " +
      "All endpoints require session authentication (cookie set via POST /api/auth) unless otherwise noted. " +
      "Webhook delivery uses HMAC-SHA256 signing via X-Webhook-Signature header.",
    contact: { name: "WorkerAI" },
  },
  servers: [{ url: "/api", description: "Current host" }],
  tags: [
    { name: "Auth",              description: "Session authentication" },
    { name: "Projects",          description: "Project CRUD and analytics" },
    { name: "Tasks",             description: "Task lifecycle management" },
    { name: "Servers",           description: "Worker server management" },
    { name: "Agents",            description: "Named Claude agent management" },
    { name: "Execution Logs",    description: "Task execution log access" },
    { name: "Queue",             description: "Dispatch queue" },
    { name: "Reports",           description: "Daily / weekly / monthly reports" },
    { name: "Analytics",         description: "Cost and velocity analytics" },
    { name: "Dashboard",         description: "Aggregate dashboard stats" },
    { name: "Health",            description: "Worker health monitoring" },
    { name: "Templates",         description: "Task templates" },
    { name: "Suggestions",       description: "AI-generated improvement suggestions" },
    { name: "Audit",             description: "Audit log" },
    { name: "Admin",             description: "Admin configuration" },
    { name: "Search",            description: "Full-text search" },
    { name: "Webhooks",          description: "Webhook integration" },
    { name: "Debt",              description: "Technical debt tracking" },
  ],
  components: { schemas },
  paths: {

    // ── Auth ──────────────────────────────────────────────────────────────────

    "/auth": {
      post: {
        tags: ["Auth"],
        summary: "Log in",
        description: "Validates the password and sets a session cookie.",
        requestBody: jsonBody("", { password: { type: "string" } }),
        responses: {
          ...ok200("Session cookie set"),
          ...err400,
          "401": { description: "Wrong password" },
        },
      },
      delete: {
        tags: ["Auth"],
        summary: "Log out",
        description: "Clears the session cookie.",
        responses: ok200("Logged out"),
      },
    },

    // ── Projects ─────────────────────────────────────────────────────────────

    "/projects": {
      get: {
        tags: ["Projects"],
        summary: "List all projects",
        parameters: [
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "paused", "archived"] } },
        ],
        responses: {
          "200": jsonResponse(arrayOf("Project")),
          ...err401,
        },
      },
      post: {
        tags: ["Projects"],
        summary: "Create a project",
        requestBody: jsonBody("", {
          name:        { type: "string" },
          description: { type: "string" },
          priority:    { type: "string", enum: ["P1", "P2", "P3", "P4"] },
        }),
        responses: {
          ...ok201("Project created"),
          ...err400,
          ...err401,
        },
      },
    },

    "/projects/{id}": {
      get: {
        tags: ["Projects"],
        summary: "Get a project",
        parameters: [IdParam],
        responses: {
          "200": jsonResponse(ref("Project")),
          ...commonErrors,
        },
      },
      put: {
        tags: ["Projects"],
        summary: "Update a project",
        parameters: [IdParam],
        requestBody: jsonBody("Project"),
        responses: { ...ok200(), ...commonErrors },
      },
      delete: {
        tags: ["Projects"],
        summary: "Delete a project",
        parameters: [IdParam],
        responses: { ...ok200("Deleted"), ...commonErrors },
      },
    },

    "/projects/{id}/debt": {
      get: {
        tags: ["Projects", "Debt"],
        summary: "Get technical debt items for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/projects/{id}/graph": {
      get: {
        tags: ["Projects"],
        summary: "Get task dependency graph for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/projects/{id}/velocity": {
      get: {
        tags: ["Projects", "Analytics"],
        summary: "Get velocity metrics for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/projects/{id}/suggestions": {
      get: {
        tags: ["Projects", "Suggestions"],
        summary: "List AI suggestions for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...commonErrors },
      },
    },

    "/projects/{id}/generate-suggestions": {
      post: {
        tags: ["Projects", "Suggestions"],
        summary: "Trigger AI suggestion generation for a project",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/projects/{id}/scan": {
      post: {
        tags: ["Projects"],
        summary: "Trigger a project scan",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/projects/{id}/scans": {
      get: {
        tags: ["Projects"],
        summary: "List scans for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...commonErrors },
      },
    },

    "/projects/{id}/improvement-cycle": {
      post: {
        tags: ["Projects"],
        summary: "Start an improvement cycle for a project",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/projects/{id}/improvement-cycles": {
      get: {
        tags: ["Projects"],
        summary: "List improvement cycles for a project",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...commonErrors },
      },
    },

    "/projects/{id}/trigger-cycle": {
      post: {
        tags: ["Projects"],
        summary: "Manually trigger an improvement cycle",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/projects/{id}/improvement/recover": {
      post: {
        tags: ["Projects"],
        summary: "Recover a stalled improvement cycle",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/projects/{id}/recalculate": {
      post: {
        tags: ["Projects"],
        summary: "Recalculate project progress metrics",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    // ── Tasks ─────────────────────────────────────────────────────────────────

    "/tasks": {
      get: {
        tags: ["Tasks"],
        summary: "List tasks",
        parameters: [
          PageParam, LimitParam,
          { name: "projectId",    in: "query", schema: { type: "string" } },
          { name: "status",       in: "query", schema: { type: "string" } },
          { name: "agentId",      in: "query", schema: { type: "string" } },
          { name: "serverId",     in: "query", schema: { type: "string" } },
          { name: "stalled",      in: "query", schema: { type: "boolean" } },
          { name: "reviewStatus", in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              tasks:          { type: "array", items: ref("Task") },
              total:          { type: "integer" },
              page:           { type: "integer" },
              limit:          { type: "integer" },
              completedCount: { type: "integer" },
            },
          }),
          ...err401,
        },
      },
      post: {
        tags: ["Tasks"],
        summary: "Create a task",
        requestBody: jsonBody("", {
          projectId:          { type: "string" },
          title:              { type: "string" },
          description:        { type: "string" },
          priority:           { type: "string", enum: ["P1", "P2", "P3", "P4"], default: "P3" },
          taskType:           { type: "string", enum: ["coding", "research", "writing", "review", "maintenance"], default: "coding" },
          estimatedCostLevel: { type: "string", enum: ["low", "medium", "high"], default: "medium" },
          timeoutMinutes:     { type: "integer" },
          maxRetries:         { type: "integer" },
        }),
        responses: {
          "201": jsonResponse(ref("Task"), "Task created"),
          ...err400, ...err401,
        },
      },
      delete: {
        tags: ["Tasks"],
        summary: "Bulk-delete tasks by status",
        parameters: [
          { name: "status", in: "query", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": jsonResponse({ type: "object", properties: { deleted: { type: "integer" } } }),
          ...commonErrors,
        },
      },
    },

    "/tasks/{id}": {
      get: {
        tags: ["Tasks"],
        summary: "Get a task",
        parameters: [IdParam],
        responses: {
          "200": jsonResponse(ref("Task")),
          ...commonErrors,
        },
      },
      put: {
        tags: ["Tasks"],
        summary: "Update a task (title, description, priority, serverId, agentId, etc.)",
        parameters: [IdParam],
        requestBody: jsonBody("Task"),
        responses: { ...ok200(), ...commonErrors },
      },
      delete: {
        tags: ["Tasks"],
        summary: "Delete a task",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/status": {
      put: {
        tags: ["Tasks"],
        summary: "Update task status only",
        parameters: [IdParam],
        requestBody: jsonBody("", { status: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/run": {
      post: {
        tags: ["Tasks"],
        summary: "Dispatch a task to its assigned server or agent",
        parameters: [IdParam],
        responses: {
          "200": jsonResponse({ type: "object", properties: { ok: { type: "boolean" }, blocked: { type: "boolean" } } }),
          ...commonErrors,
        },
      },
    },

    "/tasks/{id}/logs": {
      get: {
        tags: ["Tasks", "Execution Logs"],
        summary: "List execution logs for a task",
        parameters: [IdParam],
        responses: {
          "200": jsonResponse(arrayOf("ExecutionLog")),
          ...commonErrors,
        },
      },
    },

    "/tasks/{id}/retry": {
      post: {
        tags: ["Tasks"],
        summary: "Retry a failed task",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/review": {
      post: {
        tags: ["Tasks"],
        summary: "Trigger an AI review of a completed task",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/skip-review": {
      post: {
        tags: ["Tasks"],
        summary: "Skip the review step for a completed task",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/force-fail": {
      post: {
        tags: ["Tasks"],
        summary: "Force-fail a running task",
        parameters: [IdParam],
        requestBody: jsonBody("", { reason: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/check-completion": {
      post: {
        tags: ["Tasks"],
        summary: "Manually check whether a running task has completed",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/{id}/dependencies": {
      get: {
        tags: ["Tasks"],
        summary: "List task dependencies",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...commonErrors },
      },
      post: {
        tags: ["Tasks"],
        summary: "Add a task dependency",
        parameters: [IdParam],
        requestBody: jsonBody("", { dependsOnId: { type: "string" } }),
        responses: { ...ok201(), ...commonErrors },
      },
    },

    "/tasks/{id}/dependencies/{depId}": {
      delete: {
        tags: ["Tasks"],
        summary: "Remove a task dependency",
        parameters: [IdParam, { name: "depId", in: "path", required: true, schema: { type: "string" } }],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/tasks/bulk": {
      post: {
        tags: ["Tasks"],
        summary: "Bulk action on multiple tasks",
        requestBody: jsonBody("", {
          ids:    { type: "array", items: { type: "string" } },
          action: { type: "string", enum: ["assign_server", "assign_agent", "mark_completed", "archive"] },
          payload: {
            type: "object",
            properties: {
              serverId: { type: "string" },
              agentId:  { type: "string" },
            },
          },
        }),
        responses: {
          "200": jsonResponse({ type: "object", properties: { updated: { type: "integer" } } }),
          ...commonErrors,
        },
      },
    },

    "/tasks/export": {
      get: {
        tags: ["Tasks"],
        summary: "Export tasks as CSV or JSON",
        parameters: [
          { name: "format",    in: "query", schema: { type: "string", enum: ["csv", "json"], default: "json" } },
          { name: "projectId", in: "query", schema: { type: "string" } },
          { name: "status",    in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "File download",
            content: {
              "text/csv":         { schema: { type: "string" } },
              "application/json": { schema: { type: "array", items: ref("Task") } },
            },
          },
          ...commonErrors,
        },
      },
    },

    "/tasks/import": {
      post: {
        tags: ["Tasks"],
        summary: "Import tasks from a CSV file",
        description:
          "Accepts multipart/form-data with a 'file' field (CSV). " +
          "Expected columns (case-insensitive): title (required), description, priority, taskType, estimatedCostLevel, timeoutMinutes.",
        parameters: [
          { name: "projectId", in: "query", required: true, schema: { type: "string" } },
        ],
        requestBody: {
          required: true,
          content: {
            "multipart/form-data": {
              schema: {
                type: "object",
                properties: {
                  file: { type: "string", format: "binary" },
                },
                required: ["file"],
              },
            },
          },
        },
        responses: {
          "200": jsonResponse(ref("ImportResult"), "Import result summary"),
          ...commonErrors,
        },
      },
    },

    // ── Servers ───────────────────────────────────────────────────────────────

    "/servers": {
      get: {
        tags: ["Servers"],
        summary: "List servers",
        responses: { "200": jsonResponse(arrayOf("Server")), ...err401 },
      },
      post: {
        tags: ["Servers"],
        summary: "Create a server",
        requestBody: jsonBody("Server"),
        responses: { ...ok201(), ...commonErrors },
      },
    },

    "/servers/{id}": {
      get: {
        tags: ["Servers"],
        summary: "Get a server",
        parameters: [IdParam],
        responses: { "200": jsonResponse(ref("Server")), ...commonErrors },
      },
      put: {
        tags: ["Servers"],
        summary: "Update a server",
        parameters: [IdParam],
        requestBody: jsonBody("Server"),
        responses: { ...ok200(), ...commonErrors },
      },
      delete: {
        tags: ["Servers"],
        summary: "Delete a server",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/{id}/connect": {
      post: {
        tags: ["Servers"],
        summary: "Test SSH connectivity to a server",
        parameters: [IdParam],
        responses: {
          "200": jsonResponse({ type: "object", properties: { ok: { type: "boolean" }, error: { type: "string" } } }),
          ...commonErrors,
        },
      },
    },

    "/servers/{id}/run": {
      post: {
        tags: ["Servers"],
        summary: "Run an environment check command on a server",
        parameters: [IdParam],
        requestBody: jsonBody("", { command: { type: "string" } }),
        responses: {
          "200": jsonResponse({ type: "object", properties: { stdout: { type: "string" }, stderr: { type: "string" } } }),
          ...commonErrors,
        },
      },
    },

    "/servers/{id}/exec": {
      post: {
        tags: ["Servers"],
        summary: "Execute an arbitrary SSH command on a server (terminal use)",
        parameters: [IdParam],
        requestBody: jsonBody("", { command: { type: "string" } }),
        responses: {
          "200": jsonResponse({ type: "object", properties: { stdout: { type: "string" }, stderr: { type: "string" }, exitCode: { type: "integer" } } }),
          ...commonErrors,
        },
      },
    },

    "/servers/{id}/claude-usage": {
      post: {
        tags: ["Servers"],
        summary: "Refresh Claude usage statistics for a server",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/{id}/launch-claude": {
      post: {
        tags: ["Servers"],
        summary: "Kill and relaunch Claude CLI in the server's tmux session",
        parameters: [IdParam],
        requestBody: jsonBody("", { mode: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/{id}/health": {
      get: {
        tags: ["Servers", "Health"],
        summary: "Get the latest health check record for a server",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/servers/{id}/logs": {
      get: {
        tags: ["Servers"],
        summary: "Get SSH command logs for a server",
        parameters: [IdParam, PageParam, LimitParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/servers/{id}/capacity": {
      get: {
        tags: ["Servers"],
        summary: "Get capacity metrics for a server",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/servers/{id}/pause": {
      post: {
        tags: ["Servers"],
        summary: "Pause auto-dispatch for a server",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/{id}/resume": {
      post: {
        tags: ["Servers"],
        summary: "Resume auto-dispatch for a server",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/{id}/recover": {
      post: {
        tags: ["Servers"],
        summary: "Attempt auto-recovery for a failed server",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/servers/capacity": {
      get: {
        tags: ["Servers"],
        summary: "Get aggregate capacity across all servers",
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
    },

    // ── Agents ────────────────────────────────────────────────────────────────

    "/agents": {
      get: {
        tags: ["Agents"],
        summary: "List agents",
        parameters: [
          { name: "serverId", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": jsonResponse(arrayOf("Agent")), ...err401 },
      },
      post: {
        tags: ["Agents"],
        summary: "Create an agent",
        requestBody: jsonBody("Agent"),
        responses: { ...ok201(), ...commonErrors },
      },
    },

    "/agents/{id}": {
      get: {
        tags: ["Agents"],
        summary: "Get an agent",
        parameters: [IdParam],
        responses: { "200": jsonResponse(ref("Agent")), ...commonErrors },
      },
      put: {
        tags: ["Agents"],
        summary: "Update an agent",
        parameters: [IdParam],
        requestBody: jsonBody("Agent"),
        responses: { ...ok200(), ...commonErrors },
      },
      delete: {
        tags: ["Agents"],
        summary: "Delete an agent",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/agents/{id}/claude-usage": {
      post: {
        tags: ["Agents"],
        summary: "Refresh Claude usage statistics for an agent",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/agents/{id}/launch-claude": {
      post: {
        tags: ["Agents"],
        summary: "Kill and relaunch Claude CLI in the agent's tmux session",
        parameters: [IdParam],
        requestBody: jsonBody("", { mode: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/agents/{id}/health": {
      get: {
        tags: ["Agents", "Health"],
        summary: "Get the latest health check record for an agent",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/agents/{id}/pause": {
      post: {
        tags: ["Agents"],
        summary: "Pause auto-dispatch for an agent",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/agents/{id}/resume": {
      post: {
        tags: ["Agents"],
        summary: "Resume auto-dispatch for an agent",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/agents/{id}/recover": {
      post: {
        tags: ["Agents"],
        summary: "Attempt auto-recovery for a failed agent",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    // ── Execution Logs ────────────────────────────────────────────────────────

    "/execution-logs": {
      get: {
        tags: ["Execution Logs"],
        summary: "List execution logs",
        parameters: [
          PageParam, LimitParam,
          { name: "taskId", in: "query", schema: { type: "string" } },
        ],
        responses: { "200": jsonResponse(arrayOf("ExecutionLog")), ...err401 },
      },
    },

    "/execution-logs/{id}": {
      get: {
        tags: ["Execution Logs"],
        summary: "Get an execution log",
        parameters: [IdParam],
        responses: { "200": jsonResponse(ref("ExecutionLog")), ...commonErrors },
      },
      put: {
        tags: ["Execution Logs"],
        summary: "Update an execution log",
        parameters: [IdParam],
        requestBody: jsonBody("ExecutionLog"),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/execution-logs/search": {
      get: {
        tags: ["Execution Logs", "Search"],
        summary: "Search execution log text",
        parameters: [
          { name: "q", in: "query", required: true, schema: { type: "string" } },
          LimitParam,
        ],
        responses: { "200": jsonResponse(arrayOf("ExecutionLog")), ...commonErrors },
      },
    },

    // ── Queue ─────────────────────────────────────────────────────────────────

    "/queue": {
      get: {
        tags: ["Queue"],
        summary: "List queued tasks sorted by priority",
        parameters: [LimitParam],
        responses: {
          "200": jsonResponse({ type: "array", items: ref("Task") }),
          ...err401,
        },
      },
    },

    // ── Dashboard ─────────────────────────────────────────────────────────────

    "/dashboard": {
      get: {
        tags: ["Dashboard"],
        summary: "Aggregate dashboard statistics",
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              pendingCount:   { type: "integer" },
              runningCount:   { type: "integer" },
              completedCount: { type: "integer" },
              failedCount:    { type: "integer" },
              projectCount:   { type: "integer" },
              serverCount:    { type: "integer" },
              agentCount:     { type: "integer" },
            },
          }),
          ...err401,
        },
      },
    },

    // ── Health ────────────────────────────────────────────────────────────────

    "/health": {
      get: {
        tags: ["Health"],
        summary: "Health status for all servers and agents",
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              servers: { type: "array", items: ref("Server") },
              agents:  { type: "array", items: ref("Agent") },
              dbPool: {
                type: "object",
                properties: {
                  total:       { type: "integer" },
                  idle:        { type: "integer" },
                  waiting:     { type: "integer" },
                  utilisation: { type: "number" },
                },
              },
            },
          }),
          ...err401,
        },
      },
    },

    // ── Reports ───────────────────────────────────────────────────────────────

    "/reports/daily": {
      get: {
        tags: ["Reports"],
        summary: "List daily reports",
        parameters: [PageParam, LimitParam],
        responses: { "200": jsonResponse(arrayOf("DailyReport")), ...err401 },
      },
      post: {
        tags: ["Reports"],
        summary: "Generate today's daily report",
        responses: { "200": jsonResponse(ref("DailyReport")), ...commonErrors },
      },
    },

    "/reports/daily/latest": {
      get: {
        tags: ["Reports"],
        summary: "Get the most recent daily report",
        responses: { "200": jsonResponse(ref("DailyReport")), ...err401 },
      },
    },

    "/reports/daily/{date}": {
      get: {
        tags: ["Reports"],
        summary: "Get a daily report by date (YYYY-MM-DD)",
        parameters: [{ name: "date", in: "path", required: true, schema: { type: "string", format: "date" } }],
        responses: { "200": jsonResponse(ref("DailyReport")), ...commonErrors },
      },
    },

    "/reports/weekly": {
      get: {
        tags: ["Reports"],
        summary: "List weekly reports",
        parameters: [LimitParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...err401 },
      },
    },

    "/reports/monthly": {
      get: {
        tags: ["Reports"],
        summary: "List monthly reports",
        parameters: [LimitParam],
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...err401 },
      },
    },

    // ── Analytics ─────────────────────────────────────────────────────────────

    "/analytics/summary": {
      get: {
        tags: ["Analytics"],
        summary: "Aggregate analytics summary",
        parameters: [
          { name: "projectId", in: "query", schema: { type: "string" } },
          { name: "days",      in: "query", schema: { type: "integer", default: 30 } },
        ],
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
    },

    "/analytics/cost": {
      get: {
        tags: ["Analytics"],
        summary: "Cost breakdown analytics",
        parameters: [
          { name: "projectId", in: "query", schema: { type: "string" } },
          { name: "days",      in: "query", schema: { type: "integer", default: 30 } },
        ],
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
    },

    "/analytics/weekly": {
      get: {
        tags: ["Analytics"],
        summary: "List weekly analytics data",
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...err401 },
      },
    },

    "/analytics/weekly/{weekStart}": {
      get: {
        tags: ["Analytics"],
        summary: "Get weekly analytics for a specific week",
        parameters: [{ name: "weekStart", in: "path", required: true, schema: { type: "string", format: "date" } }],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    // ── Templates ─────────────────────────────────────────────────────────────

    "/task-templates": {
      get: {
        tags: ["Templates"],
        summary: "List task templates",
        responses: { "200": jsonResponse(arrayOf("TaskTemplate")), ...err401 },
      },
      post: {
        tags: ["Templates"],
        summary: "Create a task template",
        requestBody: jsonBody("TaskTemplate"),
        responses: { ...ok201(), ...commonErrors },
      },
    },

    "/task-templates/{id}": {
      get: {
        tags: ["Templates"],
        summary: "Get a task template",
        parameters: [IdParam],
        responses: { "200": jsonResponse(ref("TaskTemplate")), ...commonErrors },
      },
      put: {
        tags: ["Templates"],
        summary: "Update a task template",
        parameters: [IdParam],
        requestBody: jsonBody("TaskTemplate"),
        responses: { ...ok200(), ...commonErrors },
      },
      delete: {
        tags: ["Templates"],
        summary: "Delete a task template",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/task-templates/{id}/use": {
      post: {
        tags: ["Templates"],
        summary: "Create a task from a template",
        parameters: [IdParam],
        requestBody: jsonBody("", {
          projectId: { type: "string" },
          variables: { type: "object", additionalProperties: { type: "string" } },
        }),
        responses: {
          "201": jsonResponse(ref("Task"), "Task created from template"),
          ...commonErrors,
        },
      },
    },

    // ── Suggestions ───────────────────────────────────────────────────────────

    "/suggestions/{id}": {
      get: {
        tags: ["Suggestions"],
        summary: "Get a suggestion",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/suggestions/{id}/approve": {
      post: {
        tags: ["Suggestions"],
        summary: "Approve a suggestion (creates task)",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/suggestions/{id}/reject": {
      post: {
        tags: ["Suggestions"],
        summary: "Reject a suggestion",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    // ── Improvement Cycles ────────────────────────────────────────────────────

    "/improvement-cycles/{id}": {
      get: {
        tags: ["Projects"],
        summary: "Get an improvement cycle",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    "/improvement-cycles/{id}/approve": {
      post: {
        tags: ["Projects"],
        summary: "Approve an improvement cycle proposal",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/improvement-cycles/{id}/cancel": {
      post: {
        tags: ["Projects"],
        summary: "Cancel an improvement cycle",
        parameters: [IdParam],
        responses: { ...ok200(), ...commonErrors },
      },
    },

    // ── Project Scans ─────────────────────────────────────────────────────────

    "/project-scans/{id}": {
      get: {
        tags: ["Projects"],
        summary: "Get a project scan result",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
    },

    // ── Debt ──────────────────────────────────────────────────────────────────

    "/debt": {
      get: {
        tags: ["Debt"],
        summary: "List all technical debt items",
        parameters: [PageParam, LimitParam],
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
    },

    "/debt/{id}": {
      get: {
        tags: ["Debt"],
        summary: "Get a technical debt item",
        parameters: [IdParam],
        responses: { "200": jsonResponse({ type: "object" }), ...commonErrors },
      },
      put: {
        tags: ["Debt"],
        summary: "Update a technical debt item",
        parameters: [IdParam],
        requestBody: jsonBody("", { status: { type: "string" }, notes: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    // ── Audit ─────────────────────────────────────────────────────────────────

    "/audit": {
      get: {
        tags: ["Audit"],
        summary: "List audit log entries",
        parameters: [
          PageParam, LimitParam,
          { name: "entityType", in: "query", schema: { type: "string" } },
          { name: "entityId",   in: "query", schema: { type: "string" } },
          { name: "eventType",  in: "query", schema: { type: "string" } },
        ],
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              entries: { type: "array", items: { type: "object" } },
              total:   { type: "integer" },
            },
          }),
          ...err401,
        },
      },
    },

    // ── Search ────────────────────────────────────────────────────────────────

    "/search": {
      get: {
        tags: ["Search"],
        summary: "Full-text search across tasks, projects, and logs",
        parameters: [
          { name: "q",     in: "query", required: true, schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 20 } },
        ],
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              tasks:   { type: "array", items: ref("Task") },
              projects:{ type: "array", items: ref("Project") },
            },
          }),
          ...err401,
        },
      },
    },

    // ── Recovery Logs ─────────────────────────────────────────────────────────

    "/recovery-logs": {
      get: {
        tags: ["Admin"],
        summary: "List auto-recovery log entries",
        parameters: [PageParam, LimitParam],
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
    },

    // ── Scheduled Resumes ─────────────────────────────────────────────────────

    "/scheduled-resumes": {
      get: {
        tags: ["Admin"],
        summary: "List scheduled task resume entries",
        responses: { "200": jsonResponse({ type: "array", items: { type: "object" } }), ...err401 },
      },
    },

    // ── Admin ─────────────────────────────────────────────────────────────────

    "/admin/config": {
      get: {
        tags: ["Admin"],
        summary: "Get admin system configuration",
        responses: { "200": jsonResponse({ type: "object" }), ...err401 },
      },
      put: {
        tags: ["Admin"],
        summary: "Update admin system configuration",
        requestBody: jsonBody("", { key: { type: "string" }, value: { type: "string" } }),
        responses: { ...ok200(), ...commonErrors },
      },
    },

    "/admin/webhook-status": {
      get: {
        tags: ["Admin", "Webhooks"],
        summary: "Get last webhook delivery and failure status",
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: {
              lastDelivery: { type: "object", nullable: true },
              lastFailure:  { type: "object", nullable: true },
            },
          }),
          ...err401,
        },
      },
    },

    // ── Webhooks ──────────────────────────────────────────────────────────────

    "/webhooks/test": {
      post: {
        tags: ["Webhooks"],
        summary: "Send a test webhook notification",
        responses: {
          "200": jsonResponse({
            type: "object",
            properties: { ok: { type: "boolean" }, error: { type: "string" } },
          }),
          ...commonErrors,
        },
      },
    },

    // ── Docs ──────────────────────────────────────────────────────────────────

    "/docs": {
      get: {
        tags: ["Admin"],
        summary: "Serve this OpenAPI 3.0 specification as JSON",
        security: [],
        responses: {
          "200": {
            description: "OpenAPI 3.0 specification",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};

// ── Write output ──────────────────────────────────────────────────────────────

const rootDir = new URL("..", import.meta.url).pathname;
const outDir  = join(rootDir, "public");
const outPath = join(outDir, "api-docs.json");

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2));
console.log(`✓ Wrote OpenAPI spec to ${outPath}`);
console.log(`  Paths: ${Object.keys(spec.paths).length}`);
console.log(`  Schemas: ${Object.keys(spec.components.schemas).length}`);
