/**
 * Phase 4.4 — Agent Permission Framework
 *
 * Explicit, server-side enforced permission system for agent capabilities.
 * Every task must declare required permissions; agents may only execute
 * approved capabilities. All checks happen server-side before dispatch.
 *
 * Permission hierarchy:
 *   READ_FILES → WRITE_FILES → RUN_TESTS → CREATE_BRANCH
 *   → COMMIT_CODE → CREATE_PR → DEPLOY_STAGING → DEPLOY_PRODUCTION
 *   → ACCESS_SECRETS (orthogonal, requires explicit approval)
 */

import { emitAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

// All available agent permissions
export const AgentPermission = {
  READ_FILES:         "READ_FILES",
  WRITE_FILES:        "WRITE_FILES",
  RUN_TESTS:          "RUN_TESTS",
  CREATE_BRANCH:      "CREATE_BRANCH",
  COMMIT_CODE:        "COMMIT_CODE",
  CREATE_PR:          "CREATE_PR",
  DEPLOY_STAGING:     "DEPLOY_STAGING",
  DEPLOY_PRODUCTION:  "DEPLOY_PRODUCTION",
  ACCESS_SECRETS:     "ACCESS_SECRETS",
  EXECUTE_COMMANDS:   "EXECUTE_COMMANDS",
  NETWORK_EGRESS:     "NETWORK_EGRESS",
  MODIFY_CI:          "MODIFY_CI",
} as const;

export type AgentPermission = typeof AgentPermission[keyof typeof AgentPermission];

// Permission hierarchy — granting a higher permission implicitly requires lower ones.
// Not yet consulted by any permission check (see permission-mode logic below) — the
// hierarchy is currently only enforced implicitly by which permissions each mode
// grants. Left in place as the intended model for a future explicit hierarchy check.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const PERMISSION_HIERARCHY: AgentPermission[][] = [
  [AgentPermission.READ_FILES],
  [AgentPermission.WRITE_FILES, AgentPermission.EXECUTE_COMMANDS],
  [AgentPermission.RUN_TESTS],
  [AgentPermission.CREATE_BRANCH],
  [AgentPermission.COMMIT_CODE],
  [AgentPermission.CREATE_PR, AgentPermission.MODIFY_CI],
  [AgentPermission.DEPLOY_STAGING],
  [AgentPermission.DEPLOY_PRODUCTION],
  // Orthogonal permissions (not in hierarchy)
  [AgentPermission.ACCESS_SECRETS],
  [AgentPermission.NETWORK_EGRESS],
];

// Permissions required for each permission mode (ClaudePermissionMode)
const MODE_PERMISSIONS: Record<string, AgentPermission[]> = {
  read_only: [
    AgentPermission.READ_FILES,
  ],
  workspace_write: [
    AgentPermission.READ_FILES,
    AgentPermission.WRITE_FILES,
    AgentPermission.EXECUTE_COMMANDS,
    AgentPermission.RUN_TESTS,
    AgentPermission.CREATE_BRANCH,
    AgentPermission.COMMIT_CODE,
    AgentPermission.CREATE_PR,
  ],
  full_autonomous: [
    AgentPermission.READ_FILES,
    AgentPermission.WRITE_FILES,
    AgentPermission.EXECUTE_COMMANDS,
    AgentPermission.RUN_TESTS,
    AgentPermission.CREATE_BRANCH,
    AgentPermission.COMMIT_CODE,
    AgentPermission.CREATE_PR,
    AgentPermission.DEPLOY_STAGING,
    AgentPermission.MODIFY_CI,
  ],
};

// High-risk permissions always require explicit approval
const HIGH_RISK_PERMISSIONS: Set<AgentPermission> = new Set([
  AgentPermission.DEPLOY_PRODUCTION,
  AgentPermission.ACCESS_SECRETS,
  AgentPermission.MODIFY_CI,
]);

export interface PermissionSet {
  granted: Set<AgentPermission>;
  denied: Set<AgentPermission>;
  requiresApproval: Set<AgentPermission>;
}

export interface PermissionCheck {
  allowed: boolean;
  permission: AgentPermission;
  reason?: string;
}

export interface TaskPermissionDeclaration {
  taskId: string;
  requestedPermissions: AgentPermission[];
  justification?: string;
}

/**
 * Compute the effective permission set for a task based on:
 * 1. The agent/server's permission mode
 * 2. The task's explicit permission declarations
 * 3. Project-level permission overrides
 * 4. High-risk permission rules
 */
export async function computeTaskPermissions(opts: {
  taskId: string;
  permissionMode: string;
  requestedPermissions?: AgentPermission[];
  projectId?: string;
}): Promise<PermissionSet> {
  const basePermissions = new Set<AgentPermission>(
    MODE_PERMISSIONS[opts.permissionMode] ?? MODE_PERMISSIONS.read_only,
  );

  const denied = new Set<AgentPermission>();
  const requiresApproval = new Set<AgentPermission>();

  // Apply requested permissions — only add if not already in base set
  for (const perm of opts.requestedPermissions ?? []) {
    if (HIGH_RISK_PERMISSIONS.has(perm)) {
      requiresApproval.add(perm);
    } else if (!basePermissions.has(perm)) {
      denied.add(perm);
    }
  }

  // Check project-level overrides
  if (opts.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: opts.projectId },
      select: { allowHighRiskAutonomy: true },
    });

    if (project?.allowHighRiskAutonomy) {
      // Allow high-risk permissions if project explicitly opts in
      for (const perm of requiresApproval) {
        requiresApproval.delete(perm);
        basePermissions.add(perm);
      }
    }
  }

  // Production deployments are always blocked unless explicitly unlocked
  if (!process.env.ALLOW_PRODUCTION_DEPLOY) {
    denied.add(AgentPermission.DEPLOY_PRODUCTION);
    basePermissions.delete(AgentPermission.DEPLOY_PRODUCTION);
  }

  return {
    granted: basePermissions,
    denied,
    requiresApproval,
  };
}

/**
 * Check whether a specific permission is granted for a task.
 * This is the server-side enforcement point — called before any operation.
 */
export async function checkPermission(opts: {
  taskId: string;
  permission: AgentPermission;
  agentId?: string;
  serverId?: string;
}): Promise<PermissionCheck> {
  const task = await prisma.task.findUnique({
    where: { id: opts.taskId },
    select: {
      status: true,
      projectId: true,
      agentId: true,
      serverId: true,
    },
  });

  if (!task) {
    return { allowed: false, permission: opts.permission, reason: "Task not found" };
  }

  if (task.status !== "running") {
    return {
      allowed: false,
      permission: opts.permission,
      reason: `Task status is "${task.status}", not "running"`,
    };
  }

  // Verify requester is the assigned executor
  if (opts.agentId && task.agentId !== opts.agentId) {
    await emitAudit({
      entityType: "permission",
      entityId: opts.taskId,
      eventType: "permission.check.unauthorized",
      actorType: "agent",
      payload: {
        permission: opts.permission,
        requestedBy: opts.agentId,
        assignedTo: task.agentId,
      },
    });
    return { allowed: false, permission: opts.permission, reason: "Agent not assigned to this task" };
  }

  if (opts.serverId && task.serverId !== opts.serverId) {
    await emitAudit({
      entityType: "permission",
      entityId: opts.taskId,
      eventType: "permission.check.unauthorized",
      actorType: "server",
      payload: {
        permission: opts.permission,
        requestedBy: opts.serverId,
        assignedTo: task.serverId,
      },
    });
    return { allowed: false, permission: opts.permission, reason: "Server not assigned to this task" };
  }

  // Get the effective permissions
  let permissionMode = "workspace_write"; // default

  if (opts.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: opts.agentId },
      select: { claudePermissionMode: true },
    });
    permissionMode = agent?.claudePermissionMode ?? "workspace_write";
  } else if (opts.serverId) {
    const server = await prisma.server.findUnique({
      where: { id: opts.serverId },
      select: { claudePermissionMode: true },
    });
    permissionMode = server?.claudePermissionMode ?? "workspace_write";
  }

  const permissions = await computeTaskPermissions({
    taskId: opts.taskId,
    permissionMode,
    projectId: task.projectId ?? undefined,
  });

  const allowed = permissions.granted.has(opts.permission);
  const requiresApproval = permissions.requiresApproval.has(opts.permission);

  if (!allowed || requiresApproval) {
    await emitAudit({
      entityType: "permission",
      entityId: opts.taskId,
      eventType: "permission.check.denied",
      actorType: opts.agentId ? "agent" : "server",
      payload: {
        permission: opts.permission,
        requiresApproval,
        permissionMode,
        grantedPermissions: [...permissions.granted],
      },
    });
    return {
      allowed: false,
      permission: opts.permission,
      reason: requiresApproval
        ? `Permission "${opts.permission}" requires explicit approval`
        : `Permission "${opts.permission}" not granted in mode "${permissionMode}"`,
    };
  }

  return { allowed: true, permission: opts.permission };
}

/**
 * Validate a complete set of permissions for a task dispatch.
 * Returns all denied/approval-required permissions before dispatch.
 */
export async function validateDispatchPermissions(opts: {
  taskId: string;
  permissionMode: string;
  requestedPermissions: AgentPermission[];
  projectId?: string;
}): Promise<{
  valid: boolean;
  denied: AgentPermission[];
  requiresApproval: AgentPermission[];
  granted: AgentPermission[];
}> {
  const permissions = await computeTaskPermissions({
    taskId: opts.taskId,
    permissionMode: opts.permissionMode,
    requestedPermissions: opts.requestedPermissions,
    projectId: opts.projectId,
  });

  const denied = opts.requestedPermissions.filter(
    (p) => permissions.denied.has(p),
  );
  const requiresApproval = opts.requestedPermissions.filter(
    (p) => permissions.requiresApproval.has(p),
  );
  const granted = opts.requestedPermissions.filter(
    (p) => permissions.granted.has(p),
  );

  return {
    valid: denied.length === 0 && requiresApproval.length === 0,
    denied,
    requiresApproval,
    granted,
  };
}

/**
 * Infer required permissions from task content (title + description).
 * Used to pre-populate permission declarations at task creation time.
 */
export function inferRequiredPermissions(opts: {
  title: string;
  description?: string | null;
  taskType?: string;
}): AgentPermission[] {
  const text = `${opts.title} ${opts.description ?? ""}`.toLowerCase();
  const permissions = new Set<AgentPermission>([AgentPermission.READ_FILES]);

  if (/\b(write|create|update|modify|edit|add|remove|delete|fix|refactor)\b/.test(text)) {
    permissions.add(AgentPermission.WRITE_FILES);
  }
  if (/\b(test|tests|spec|specs|jest|vitest|pytest|unittest)\b/.test(text)) {
    permissions.add(AgentPermission.RUN_TESTS);
  }
  if (/\b(branch|checkout|git)\b/.test(text)) {
    permissions.add(AgentPermission.CREATE_BRANCH);
  }
  if (/\b(commit|push|stage)\b/.test(text)) {
    permissions.add(AgentPermission.COMMIT_CODE);
  }
  if (/\b(pull request|pr|merge request)\b/.test(text)) {
    permissions.add(AgentPermission.CREATE_PR);
  }
  if (/\b(deploy|deployment|release)\b.*\b(staging|stage|dev)\b/.test(text)) {
    permissions.add(AgentPermission.DEPLOY_STAGING);
  }
  if (/\b(deploy|deployment|release)\b.*\b(prod|production)\b/.test(text)) {
    permissions.add(AgentPermission.DEPLOY_PRODUCTION);
  }
  if (/\b(secret|credential|api.?key|password|token|env)\b/.test(text)) {
    permissions.add(AgentPermission.ACCESS_SECRETS);
  }
  if (/\b(curl|wget|fetch|http|api|network|request)\b/.test(text)) {
    permissions.add(AgentPermission.NETWORK_EGRESS);
  }
  if (/\b(ci|github.?action|workflow|pipeline|yaml)\b/.test(text)) {
    permissions.add(AgentPermission.MODIFY_CI);
  }
  if (/\b(run|exec|execute|sh|bash|shell|script)\b/.test(text)) {
    permissions.add(AgentPermission.EXECUTE_COMMANDS);
  }

  return [...permissions];
}
