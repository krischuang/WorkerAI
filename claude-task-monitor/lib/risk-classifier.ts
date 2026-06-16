/**
 * Heuristic risk classification for tasks. Computed once at task creation time and stored on
 * Task.riskLevel — always manually overridable afterward via the task update route.
 *
 * High-risk tasks are never auto-dispatched by the autonomous pipeline (lib/agent-selector.ts /
 * lib/task-service.ts's autoAssignQueuedTasks) unless Project.allowHighRiskAutonomy is true.
 */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskClassificationInput {
  title: string;
  description?: string | null;
  taskType?: string;
}

/**
 * Keyword patterns that mark a task high-risk by default, per the categories called out
 * explicitly: database migrations, authentication/security, production deployment,
 * destructive commands, and secret-handling.
 */
const HIGH_RISK_PATTERNS: RegExp[] = [
  // Database migration / destructive schema changes
  /\bmigrat(e|ion|ions)\b/i,
  /\bschema\s*change\b/i,
  /\balter\s+table\b/i,
  /\bdrop\s+(table|database|column|index)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  // Authentication / security
  /\bauth(entication|orization)?\b/i,
  /\bsecurity\b/i,
  /\bpermission(s)?\s+(check|model|bypass)\b/i,
  /\bsession\s+token\b/i,
  // Production deployment
  /\bproduction\b/i,
  /\bdeploy(ment)?\s+to\s+prod/i,
  /\brelease\s+to\s+prod/i,
  // Destructive commands
  /\brm\s+-rf\b/i,
  /\bforce[\s-]?push\b/i,
  /\bdestructive\b/i,
  /--no-verify/i,
  // Secret-handling
  /\bcredential/i,
  /\bpassword/i,
  /\bsecret\b/i,
  /\bapi[\s-]?key/i,
  /\benv(ironment)?\s+variable.*(secret|key|token)/i,
  /\.env\b/i,
];

/** Default risk by taskType when no high-risk keyword matched. */
const DEFAULT_RISK_BY_TASK_TYPE: Record<string, RiskLevel> = {
  research: "low",
  writing: "low",
  review: "low",
  maintenance: "medium",
  coding: "medium",
};

export function classifyTaskRisk(input: RiskClassificationInput): RiskLevel {
  const text = `${input.title} ${input.description ?? ""}`.toLowerCase();
  if (HIGH_RISK_PATTERNS.some((pattern) => pattern.test(text))) return "high";
  return DEFAULT_RISK_BY_TASK_TYPE[input.taskType ?? ""] ?? "medium";
}
