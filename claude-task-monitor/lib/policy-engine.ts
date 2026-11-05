/**
 * Phase 4.5 — Policy Engine
 *
 * Centralized, declarative policy evaluation for all agent operations.
 * Policies are evaluated against file paths, repositories, risk levels,
 * and deployment targets to produce allow / require-approval / deny decisions.
 *
 * Example policies:
 *   README change      → Auto approve
 *   Backend code change → Require review
 *   Terraform change   → Require approval
 *   Production secret  → Block
 */

import { emitAudit } from "@/lib/audit";

export type PolicyDecision = "allow" | "require_approval" | "deny";
export type PolicyCategory =
  | "file_change"
  | "repository_access"
  | "deployment"
  | "secret_access"
  | "code_execution"
  | "network_egress";

export interface PolicyRule {
  id: string;
  name: string;
  description: string;
  category: PolicyCategory;
  /** Glob patterns for matching file paths */
  pathPatterns?: string[];
  /** Repository patterns (owner/repo or owner/*) */
  repositoryPatterns?: string[];
  /** Risk levels this rule applies to */
  riskLevels?: Array<"low" | "medium" | "high">;
  /** Deployment targets */
  deploymentTargets?: string[];
  /** URL/domain patterns for egress */
  egressPatterns?: string[];
  decision: PolicyDecision;
  /** Priority — higher number = higher priority (evaluated first) */
  priority: number;
  enabled: boolean;
}

export interface PolicyContext {
  taskId: string;
  projectId?: string;
  /** File paths being modified */
  filePaths?: string[];
  /** Target repository (owner/repo) */
  repository?: string;
  /** Risk level of the task */
  riskLevel?: "low" | "medium" | "high";
  /** Deployment target */
  deploymentTarget?: string;
  /** URL being accessed */
  egressUrl?: string;
  /** Category of operation */
  category: PolicyCategory;
}

export interface PolicyEvaluation {
  decision: PolicyDecision;
  matchedRule?: PolicyRule;
  reason: string;
  taskId: string;
  category: PolicyCategory;
}

// Built-in policy rules (evaluated before custom rules)
const BUILTIN_RULES: PolicyRule[] = [
  // ── Production deployments — always block unless explicitly overridden ──
  {
    id: "builtin:deny-production-deploy",
    name: "Block Production Deployments",
    description: "Production deployments require explicit human approval",
    category: "deployment",
    deploymentTargets: ["production", "prod"],
    decision: "deny",
    priority: 1000,
    enabled: true,
  },
  // ── Terraform / infrastructure changes — require approval ──
  {
    id: "builtin:approve-terraform",
    name: "Require Approval for Terraform",
    description: "Infrastructure-as-code changes require human review",
    category: "file_change",
    pathPatterns: ["**/*.tf", "**/*.tfvars", "**/terraform/**", "**/.terraform/**"],
    decision: "require_approval",
    priority: 900,
    enabled: true,
  },
  // ── CI/CD changes — require approval ──
  {
    id: "builtin:approve-ci",
    name: "Require Approval for CI/CD",
    description: "CI/CD pipeline changes can affect all deployments",
    category: "file_change",
    pathPatterns: [
      "**/.github/workflows/**",
      "**/Jenkinsfile",
      "**/.travis.yml",
      "**/Dockerfile*",
      "**/docker-compose*.yml",
    ],
    decision: "require_approval",
    priority: 850,
    enabled: true,
  },
  // ── Secret / credential files — deny ──
  {
    id: "builtin:deny-secret-files",
    name: "Block Secret File Modifications",
    description: "Secret and credential files must not be modified by agents",
    category: "file_change",
    pathPatterns: [
      "**/.env",
      "**/.env.*",
      "**/secrets/**",
      "**/*.pem",
      "**/*.key",
      "**/*.p12",
      "**/credentials.json",
      "**/service-account*.json",
      // Conventional OpenSSH private key filenames have no extension at all —
      // *.key/*.pem alone would miss every one of these.
      "**/id_rsa",
      "**/id_dsa",
      "**/id_ecdsa",
      "**/id_ed25519",
      "**/.ssh/*",
      // Common cloud-credential file locations.
      "**/.aws/credentials",
      "**/.aws/config",
      "**/.netrc",
      "**/.npmrc",
      "**/.docker/config.json",
      "**/gcloud/credentials.db",
      "**/kube/config",
      "**/.kube/config",
    ],
    decision: "deny",
    priority: 950,
    enabled: true,
  },
  // ── Authentication / security code — require approval ──
  {
    id: "builtin:approve-auth-code",
    name: "Require Approval for Auth Code",
    description: "Authentication and authorization code changes require review",
    category: "file_change",
    pathPatterns: [
      "**/auth/**",
      "**/middleware.ts",
      "**/middleware.js",
      "**/security/**",
      "**/permissions/**",
    ],
    decision: "require_approval",
    priority: 800,
    enabled: true,
  },
  // ── README and documentation — auto approve ──
  {
    id: "builtin:allow-docs",
    name: "Auto-Approve Documentation",
    description: "Documentation changes are low risk and auto-approved",
    category: "file_change",
    pathPatterns: [
      "**/README*",
      "**/CHANGELOG*",
      "**/*.md",
      "**/docs/**",
    ],
    riskLevels: ["low"],
    decision: "allow",
    priority: 100,
    enabled: true,
  },
  // ── Egress — block unknown domains ──
  {
    id: "builtin:restrict-egress",
    name: "Restrict Outbound Network Access",
    description: "Only allow-listed domains are permitted for egress",
    category: "network_egress",
    decision: "require_approval",
    priority: 500,
    enabled: true,
  },
  // ── High-risk tasks — require approval ──
  {
    id: "builtin:approve-high-risk",
    name: "Require Approval for High-Risk Tasks",
    description: "Tasks classified as high-risk require human review before execution",
    category: "code_execution",
    riskLevels: ["high"],
    decision: "require_approval",
    priority: 750,
    enabled: true,
  },
];

// Custom rules loaded from SystemConfig (key: "policy_rules", value: JSON array)
let customRules: PolicyRule[] = [];
let rulesLastLoaded = 0;
const RULES_CACHE_TTL = 60_000; // 1 minute

async function loadCustomRules(): Promise<PolicyRule[]> {
  const now = Date.now();
  if (now - rulesLastLoaded < RULES_CACHE_TTL) return customRules;

  try {
    const { prisma } = await import("@/lib/prisma");
    const config = await prisma.systemConfig.findUnique({
      where: { key: "policy_rules" },
    });
    if (config?.value) {
      customRules = JSON.parse(config.value) as PolicyRule[];
    }
    rulesLastLoaded = now;
  } catch {
    // Return cached rules on error
  }

  return customRules;
}

/**
 * Match a path against a glob pattern.
 * Supports ** for directory wildcards and * for single-segment wildcards.
 *
 * A leading double-star-slash segment matches zero or more directories —
 * not "at least one" — so a pattern like double-star-slash-".env" matches
 * both a repo-root .env and a nested a/b/.env. A naive substitution of
 * double-star to ".*" leaves the slash as a literal required character,
 * which would silently let a bare root-level .env (the single most common
 * and most sensitive location) slip past the "block secret files" rule while
 * still blocking any nested one — the opposite of what the rule intends.
 */
function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "DOUBLE_STAR_SLASH")
    .replace(/\*\*/g, "DOUBLE_STAR")
    .replace(/\*/g, "[^/]*")
    .replace(/DOUBLE_STAR_SLASH/g, "(?:.*/)?")
    .replace(/DOUBLE_STAR/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

/**
 * Check if a value matches any pattern in a list.
 */
function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((p) => matchGlob(p, value) || p === value);
}

/**
 * Evaluate policies for a given context.
 * Returns the highest-priority matching rule's decision.
 * If no rule matches, defaults to "allow" for low-risk, "require_approval" for others.
 */
export async function evaluatePolicy(ctx: PolicyContext): Promise<PolicyEvaluation> {
  const custom = await loadCustomRules();
  const allRules = [...BUILTIN_RULES, ...custom]
    .filter((r) => r.enabled && r.category === ctx.category)
    .sort((a, b) => b.priority - a.priority); // highest priority first

  for (const rule of allRules) {
    let matches = true;

    // File path check
    if (rule.pathPatterns && ctx.filePaths && ctx.filePaths.length > 0) {
      const anyFileMatches = ctx.filePaths.some((fp) =>
        rule.pathPatterns!.some((pattern) => matchGlob(pattern, fp)),
      );
      if (!anyFileMatches) matches = false;
    } else if (rule.pathPatterns && !ctx.filePaths) {
      matches = false;
    }

    // Repository check
    if (matches && rule.repositoryPatterns && ctx.repository) {
      if (!matchesAny(rule.repositoryPatterns, ctx.repository)) matches = false;
    }

    // Risk level check
    if (matches && rule.riskLevels && ctx.riskLevel) {
      if (!rule.riskLevels.includes(ctx.riskLevel)) matches = false;
    }

    // Deployment target check
    if (matches && rule.deploymentTargets && ctx.deploymentTarget) {
      if (!matchesAny(rule.deploymentTargets, ctx.deploymentTarget.toLowerCase())) {
        matches = false;
      }
    }

    if (matches) {
      await emitAudit({
        entityType: "policy",
        entityId: ctx.taskId,
        eventType: `policy.${rule.decision}`,
        actorType: "system",
        payload: {
          ruleId: rule.id,
          ruleName: rule.name,
          category: ctx.category,
          decision: rule.decision,
          filePaths: ctx.filePaths,
          repository: ctx.repository,
          riskLevel: ctx.riskLevel,
          deploymentTarget: ctx.deploymentTarget,
        },
      });

      return {
        decision: rule.decision,
        matchedRule: rule,
        reason: rule.description,
        taskId: ctx.taskId,
        category: ctx.category,
      };
    }
  }

  // Default decision: allow low/medium risk, require approval for high risk
  const defaultDecision: PolicyDecision =
    ctx.riskLevel === "high" ? "require_approval" : "allow";

  return {
    decision: defaultDecision,
    reason: `No matching policy rule — default decision for ${ctx.riskLevel ?? "unknown"} risk`,
    taskId: ctx.taskId,
    category: ctx.category,
  };
}

/**
 * Evaluate policy for a task dispatch.
 * Checks all relevant categories and returns the most restrictive decision.
 */
export async function evaluateDispatchPolicy(opts: {
  taskId: string;
  projectId?: string;
  riskLevel?: "low" | "medium" | "high";
  filePaths?: string[];
  repository?: string;
  deploymentTarget?: string;
}): Promise<{
  decision: PolicyDecision;
  evaluations: PolicyEvaluation[];
  blocked: boolean;
  requiresApproval: boolean;
}> {
  const evaluations: PolicyEvaluation[] = [];

  // Evaluate code execution policy
  const execEval = await evaluatePolicy({
    taskId: opts.taskId,
    projectId: opts.projectId,
    riskLevel: opts.riskLevel,
    category: "code_execution",
    repository: opts.repository,
  });
  evaluations.push(execEval);

  // Evaluate file change policies if paths provided
  if (opts.filePaths && opts.filePaths.length > 0) {
    const fileEval = await evaluatePolicy({
      taskId: opts.taskId,
      projectId: opts.projectId,
      riskLevel: opts.riskLevel,
      category: "file_change",
      filePaths: opts.filePaths,
      repository: opts.repository,
    });
    evaluations.push(fileEval);
  }

  // Evaluate deployment policy if target provided
  if (opts.deploymentTarget) {
    const deployEval = await evaluatePolicy({
      taskId: opts.taskId,
      projectId: opts.projectId,
      category: "deployment",
      deploymentTarget: opts.deploymentTarget,
    });
    evaluations.push(deployEval);
  }

  // Most restrictive decision wins: deny > require_approval > allow
  let finalDecision: PolicyDecision = "allow";
  for (const evaluation of evaluations) {
    if (evaluation.decision === "deny") {
      finalDecision = "deny";
      break;
    }
    if (evaluation.decision === "require_approval") {
      finalDecision = "require_approval";
    }
  }

  return {
    decision: finalDecision,
    evaluations,
    blocked: finalDecision === "deny",
    requiresApproval: finalDecision === "require_approval",
  };
}

// ── Policy approvals ──────────────────────────────────────────────────────────
//
// A "require_approval" decision is not self-granting — evaluatePolicy/
// evaluateDispatchPolicy only ever *classify* a decision, they never record
// that a human actually reviewed and approved it. Approval is tracked here,
// in SystemConfig (no schema migration needed, same storage already used for
// policy_rules and the kill switch), keyed per task. An approval is one-time
// use: the gate that consumes it (lib/task-dispatch.ts for dispatch-time
// code_execution policy, lib/validation-gate.ts for post-execution
// file_change policy) deletes it immediately, so a stale approval can't be
// silently replayed for a later, possibly different, decision on the same
// task.

export interface PolicyApprovalRecord {
  approvedBy: string;
  approvedAt: string;
  /** Hard expiry — an approval past this point is treated as absent. */
  expiresAt: string;
  /** The exact policy category this approval authorises. An approval granted
   *  for one category (e.g. dispatch-time code_execution) can never satisfy
   *  a check for a different category (e.g. post-execution file_change),
   *  even for the same task — approvals are scoped to the operation they
   *  were actually granted for, not just the task. */
  category: PolicyCategory;
  detail?: string;
}

function approvalKey(taskId: string): string {
  return `policy_approval:${taskId}`;
}

const DEFAULT_APPROVAL_TTL_MINUTES = 30;
/** Hard ceiling regardless of what a caller requests — an approval can never
 *  be granted for longer than this, so "time-limited" cannot be defeated by
 *  simply asking for a very large TTL. */
const MAX_APPROVAL_TTL_MINUTES = 240;

/** Record that a human has approved a pending require_approval decision for
 *  this task, scoped to exactly one policy category, expiring after ttlMinutes
 *  (default 30, hard-capped at 4 hours). */
export async function grantPolicyApproval(opts: {
  taskId: string;
  approvedBy: string;
  category: PolicyCategory;
  detail?: string;
  ttlMinutes?: number;
}): Promise<PolicyApprovalRecord> {
  const { prisma } = await import("@/lib/prisma");
  const ttl = Math.min(Math.max(opts.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES, 1), MAX_APPROVAL_TTL_MINUTES);
  const now = Date.now();
  const record: PolicyApprovalRecord = {
    approvedBy: opts.approvedBy,
    approvedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl * 60_000).toISOString(),
    category: opts.category,
    detail: opts.detail,
  };
  await prisma.systemConfig.upsert({
    where: { key: approvalKey(opts.taskId) },
    create: { key: approvalKey(opts.taskId), value: JSON.stringify(record) },
    update: { value: JSON.stringify(record) },
  });
  await emitAudit({
    entityType: "task",
    entityId: opts.taskId,
    eventType: "policy.approval_granted",
    actorType: opts.approvedBy,
    payload: { ...record },
  });
  return record;
}

/** Look up a pending approval for a task, scoped to a specific policy
 *  category — returns null (treated as "no approval") if none exists, if it
 *  was granted for a different category, or if it has expired. An expired
 *  record is deleted on read so it cannot be mistaken for valid on a later
 *  lookup and does not linger indefinitely. */
export async function getPolicyApproval(
  taskId: string,
  category: PolicyCategory,
): Promise<PolicyApprovalRecord | null> {
  const { prisma } = await import("@/lib/prisma");
  const config = await prisma.systemConfig.findUnique({ where: { key: approvalKey(taskId) } });
  if (!config?.value) return null;

  let record: PolicyApprovalRecord;
  try {
    record = JSON.parse(config.value) as PolicyApprovalRecord;
  } catch {
    return null;
  }

  if (record.category !== category) return null;

  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    await consumePolicyApproval(taskId);
    await emitAudit({
      entityType: "task",
      entityId: taskId,
      eventType: "policy.approval_expired",
      actorType: "system",
      payload: { category, expiresAt: record.expiresAt },
    });
    return null;
  }

  return record;
}

/** Consume (delete) an approval once a gate has acted on it — one-time use. */
export async function consumePolicyApproval(taskId: string): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await prisma.systemConfig.delete({ where: { key: approvalKey(taskId) } }).catch(() => {});
}

/**
 * Get all active policy rules (built-in + custom).
 */
export async function getAllPolicyRules(): Promise<PolicyRule[]> {
  const custom = await loadCustomRules();
  return [...BUILTIN_RULES, ...custom].sort((a, b) => b.priority - a.priority);
}

/**
 * Save custom policy rules to SystemConfig.
 */
export async function saveCustomRules(rules: PolicyRule[]): Promise<void> {
  const { prisma } = await import("@/lib/prisma");
  await prisma.systemConfig.upsert({
    where: { key: "policy_rules" },
    create: { key: "policy_rules", value: JSON.stringify(rules) },
    update: { value: JSON.stringify(rules) },
  });
  customRules = rules;
  rulesLastLoaded = Date.now();
}
