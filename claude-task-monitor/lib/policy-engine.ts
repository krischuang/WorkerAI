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
 */
function matchGlob(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "DOUBLE_STAR")
    .replace(/\*/g, "[^/]*")
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
