/**
 * Phase 4.6 — Prompt Firewall
 *
 * Intercepts all prompts before they reach the AI layer.
 * Detects and blocks:
 *   - Direct prompt injection ("ignore previous instructions")
 *   - Indirect prompt injection (content-embedded directives)
 *   - Jailbreak attempts (role override, DAN, etc.)
 *   - Secret exfiltration attempts (reading env vars, credentials)
 *   - Tool abuse requests (unintended capability invocation)
 *
 * Workflow:
 *   Prompt → Firewall → Risk Analysis → Allow / Block / Escalate
 *
 * All blocked/escalated attempts are logged immutably.
 */

import { emitAudit } from "@/lib/audit";

export type FirewallDecision = "allow" | "block" | "escalate" | "sanitize";

export type ThreatCategory =
  | "prompt_injection"
  | "jailbreak"
  | "secret_exfiltration"
  | "tool_abuse"
  | "role_override"
  | "instruction_override"
  | "indirect_injection";

export interface ThreatSignal {
  category: ThreatCategory;
  pattern: string;
  matchedText: string;
  confidence: "high" | "medium" | "low";
  decision: FirewallDecision;
}

export interface FirewallResult {
  decision: FirewallDecision;
  threats: ThreatSignal[];
  sanitizedPrompt?: string;
  blocked: boolean;
  riskScore: number;
  taskId?: string;
}

// ── Threat detection patterns ─────────────────────────────────────────────────

const INJECTION_PATTERNS: Array<{
  pattern: RegExp;
  category: ThreatCategory;
  confidence: ThreatSignal["confidence"];
  decision: FirewallDecision;
}> = [
  // Direct instruction overrides — HIGH confidence → block
  {
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier|system)\s+instructions?/i,
    category: "instruction_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier|system)\s+instructions?/i,
    category: "instruction_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /forget\s+(everything|all|what)\s+(you|i|we)\s+(were|have|told)/i,
    category: "instruction_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /override\s+(your|all|system)\s+(instructions?|rules?|constraints?|guidelines?)/i,
    category: "instruction_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /new\s+(instructions?|directive|rules?|task)\s*:/i,
    category: "prompt_injection",
    confidence: "medium",
    decision: "escalate",
  },
  // Role override / jailbreak — HIGH confidence → block
  {
    pattern: /\b(DAN|do\s+anything\s+now|developer\s+mode|jailbreak\s+mode)\b/i,
    category: "jailbreak",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /you\s+are\s+now\s+(a|an|the)?\s*(different|new|unrestricted|free|evil)/i,
    category: "role_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /pretend\s+(you\s+are|to\s+be)\s+(a|an)?\s*(different|evil|hacker|attacker)/i,
    category: "role_override",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /act\s+as\s+(a|an)?\s*(unrestricted|free|hacker|attacker|malicious)/i,
    category: "role_override",
    confidence: "high",
    decision: "block",
  },
  // Secret exfiltration attempts — HIGH confidence → block
  {
    pattern: /\b(print|echo|cat|show|display|output|reveal|expose)\b.*\b(DATABASE_URL|API_KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|PRIVATE_KEY)\b/i,
    category: "secret_exfiltration",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\bcat\s+(\/etc\/passwd|\/etc\/shadow|~\/\.ssh|~\/\.env|\.env\b)/i,
    category: "secret_exfiltration",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\benv\b.*\b(all|list|show|print|dump)\b|\b(print|echo)\s+\$?(ENV|env)\b/i,
    category: "secret_exfiltration",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\bfind\s+\/\s+.*\.(pem|key|env|secret|credential)/i,
    category: "secret_exfiltration",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\b(read|show|print|display|get)\s+(all\s+)?(secrets?|credentials?|api[\s-]?keys?|passwords?)\b/i,
    category: "secret_exfiltration",
    confidence: "high",
    decision: "block",
  },
  // Tool abuse — MEDIUM confidence → escalate
  {
    pattern: /\b(execute|run|eval|exec)\s+(arbitrary|any|all|untrusted)\s+(code|commands?|scripts?)\b/i,
    category: "tool_abuse",
    confidence: "medium",
    decision: "escalate",
  },
  {
    pattern: /\bcurl\s+.*\b(attacker|evil|malicious|c2|command-and-control)\b/i,
    category: "tool_abuse",
    confidence: "high",
    decision: "block",
  },
  // Reverse shell patterns — detected regardless of destination
  {
    pattern: /bash\s+-i\s*>&?\s*\/dev\/tcp\//i,
    category: "tool_abuse",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\bnc\s+\S+\s+\d{2,5}(\s+-e\s+\/bin\/(bash|sh)|.*-e.*\/bin\/(bash|sh))/i,
    category: "tool_abuse",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /\bncat\s+.*\d+\.\d+/i,
    category: "tool_abuse",
    confidence: "high",
    decision: "block",
  },
  // Indirect injection markers
  {
    pattern: /\[\[SYSTEM\]\]|\[\[INST\]\]|\[\/INST\]|<\|system\|>|<\|im_start\|>/i,
    category: "indirect_injection",
    confidence: "high",
    decision: "block",
  },
  {
    pattern: /#{3,}\s*(SYSTEM|OVERRIDE|INJECT|CONTROL)\s*#{3,}/i,
    category: "indirect_injection",
    confidence: "high",
    decision: "block",
  },
  // Credential harvesting patterns
  {
    pattern: /\$\{?(DATABASE_URL|REDIS_URL|SMTP_|AWS_|GCP_|AZURE_|GITHUB_TOKEN|API_KEY)\}?/i,
    category: "secret_exfiltration",
    confidence: "medium",
    decision: "escalate",
  },
];

// Severity weights for risk score calculation
const CONFIDENCE_WEIGHTS: Record<ThreatSignal["confidence"], number> = {
  high: 40,
  medium: 20,
  low: 5,
};

const DECISION_WEIGHTS: Record<FirewallDecision, number> = {
  block: 50,
  escalate: 25,
  sanitize: 10,
  allow: 0,
};

/**
 * Scan a prompt for threat patterns.
 * Returns all detected signals with their categories and decisions.
 */
function detectThreats(prompt: string): ThreatSignal[] {
  const threats: ThreatSignal[] = [];

  for (const detector of INJECTION_PATTERNS) {
    const match = prompt.match(detector.pattern);
    if (match) {
      threats.push({
        category: detector.category,
        pattern: detector.pattern.source,
        matchedText: match[0].slice(0, 200), // cap at 200 chars
        confidence: detector.confidence,
        decision: detector.decision,
      });
    }
  }

  return threats;
}

/**
 * Calculate a risk score from 0–100 based on detected threats.
 * Used for threshold-based escalation.
 */
function calculateRiskScore(threats: ThreatSignal[]): number {
  if (threats.length === 0) return 0;

  const score = threats.reduce((acc, threat) => {
    return acc + CONFIDENCE_WEIGHTS[threat.confidence] + DECISION_WEIGHTS[threat.decision];
  }, 0);

  return Math.min(100, score);
}

/**
 * Determine the final decision from a set of threat signals.
 * Most restrictive decision wins: block > escalate > sanitize > allow.
 */
function resolveDecision(threats: ThreatSignal[]): FirewallDecision {
  if (threats.some((t) => t.decision === "block")) return "block";
  if (threats.some((t) => t.decision === "escalate")) return "escalate";
  if (threats.some((t) => t.decision === "sanitize")) return "sanitize";
  return "allow";
}

/**
 * Attempt to sanitize a prompt by removing or neutralizing threat patterns.
 * Used when decision is "sanitize" to allow the operation with threat removed.
 */
function sanitizePrompt(prompt: string, threats: ThreatSignal[]): string {
  let sanitized = prompt;

  for (const threat of threats) {
    if (threat.decision === "sanitize") {
      // Replace matched text with a neutralized placeholder
      sanitized = sanitized.replace(
        new RegExp(threat.pattern, "gi"),
        "[CONTENT_REMOVED_BY_FIREWALL]",
      );
    }
  }

  return sanitized;
}

/**
 * Evaluate a prompt through the firewall.
 * Main entry point for all prompt processing.
 */
export async function evaluatePrompt(opts: {
  prompt: string;
  taskId?: string;
  source?: "user" | "task" | "agent" | "webhook" | "repository";
  allowSanitize?: boolean;
}): Promise<FirewallResult> {
  const threats = detectThreats(opts.prompt);
  const riskScore = calculateRiskScore(threats);
  const decision = resolveDecision(threats);

  let sanitizedPrompt: string | undefined;
  if (decision === "sanitize" && opts.allowSanitize) {
    sanitizedPrompt = sanitizePrompt(opts.prompt, threats);
  }

  // Log all non-allow decisions
  if (decision !== "allow") {
    const eventType =
      decision === "block" ? "firewall.prompt.blocked" :
      decision === "escalate" ? "firewall.prompt.escalated" :
      "firewall.prompt.sanitized";

    await emitAudit({
      entityType: "firewall",
      entityId: opts.taskId ?? "global",
      eventType,
      actorType: opts.source ?? "unknown",
      payload: {
        riskScore,
        decision,
        threatCount: threats.length,
        threats: threats.map((t) => ({
          category: t.category,
          confidence: t.confidence,
          matchedText: t.matchedText,
        })),
        promptLength: opts.prompt.length,
        promptPrefix: opts.prompt.slice(0, 100),
      },
    });
  }

  return {
    decision,
    threats,
    sanitizedPrompt,
    blocked: decision === "block",
    riskScore,
    taskId: opts.taskId,
  };
}

/**
 * Check if a prompt is safe to dispatch.
 * Returns the firewall result; callers must check result.blocked.
 */
export async function checkPromptSafety(
  prompt: string,
  taskId?: string,
): Promise<FirewallResult> {
  return evaluatePrompt({
    prompt,
    taskId,
    source: "task",
    allowSanitize: false,
  });
}

/**
 * Evaluate all text fields of a task for threats.
 * Checks title, description, and any user-supplied content.
 */
export async function evaluateTaskContent(opts: {
  taskId: string;
  title: string;
  description?: string | null;
}): Promise<FirewallResult> {
  const combined = [opts.title, opts.description ?? ""].join("\n\n");

  return evaluatePrompt({
    prompt: combined,
    taskId: opts.taskId,
    source: "task",
    allowSanitize: false,
  });
}

/**
 * Get firewall statistics from audit events.
 * Returns counts of blocked/escalated/allowed prompts.
 */
export async function getFirewallStats(sinceHours = 24): Promise<{
  blocked: number;
  escalated: number;
  sanitized: number;
  total: number;
}> {
  const since = new Date(Date.now() - sinceHours * 60 * 60 * 1000);

  const { prisma } = await import("@/lib/prisma");
  const [blocked, escalated, sanitized] = await Promise.all([
    prisma.auditEvent.count({
      where: {
        eventType: "firewall.prompt.blocked",
        createdAt: { gte: since },
      },
    }),
    prisma.auditEvent.count({
      where: {
        eventType: "firewall.prompt.escalated",
        createdAt: { gte: since },
      },
    }),
    prisma.auditEvent.count({
      where: {
        eventType: "firewall.prompt.sanitized",
        createdAt: { gte: since },
      },
    }),
  ]);

  return {
    blocked,
    escalated,
    sanitized,
    total: blocked + escalated + sanitized,
  };
}
