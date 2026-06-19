/**
 * Phase 4.8 — Agent Behaviour Monitoring
 *
 * Tracks agent actions and detects anomalous patterns that indicate:
 *   - Compromise: unusual commands, secret harvesting
 *   - Exfiltration: mass file access, unexpected egress
 *   - Privilege escalation: capability expansion attempts
 *   - Lateral movement: accessing other agents' resources
 *
 * Suspicious patterns trigger alerts, agent suspension, or task termination.
 */

import { emitAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";

export type BehaviourEventType =
  | "command_executed"
  | "file_accessed"
  | "file_modified"
  | "repository_accessed"
  | "secret_requested"
  | "egress_attempted"
  | "permission_escalation"
  | "process_spawned";

export type AnomalyType =
  | "credential_harvesting"
  | "mass_file_access"
  | "ssh_key_access"
  | "suspicious_command"
  | "unusual_egress"
  | "privilege_escalation"
  | "mass_repo_access"
  | "reconnaissance";

export type AlertSeverity = "low" | "medium" | "high" | "critical";

export interface BehaviourEvent {
  taskId: string;
  agentId?: string;
  serverId?: string;
  eventType: BehaviourEventType;
  command?: string;
  filePath?: string;
  repository?: string;
  url?: string;
  timestamp: Date;
}

export interface AnomalyAlert {
  alertId: string;
  taskId: string;
  agentId?: string;
  anomalyType: AnomalyType;
  severity: AlertSeverity;
  description: string;
  evidence: string[];
  detectedAt: Date;
  action: "alert" | "suspend" | "terminate";
}

// In-memory ring buffer of recent events per task (max 100 per task)
const taskEventBuffer = new Map<string, BehaviourEvent[]>();
const MAX_EVENTS_PER_TASK = 100;

// Suspicious command patterns
const SUSPICIOUS_COMMAND_PATTERNS: Array<{
  pattern: RegExp;
  anomalyType: AnomalyType;
  severity: AlertSeverity;
  action: AnomalyAlert["action"];
  description: string;
}> = [
  // SSH key access
  {
    pattern: /cat\s+~\/\.ssh\/|cat\s+\/root\/\.ssh\//i,
    anomalyType: "ssh_key_access",
    severity: "critical",
    action: "terminate",
    description: "Attempted to read SSH private key",
  },
  // Credential file harvesting
  {
    pattern: /find\s+[/~]\s+.*-name.*\.(pem|key|env|secret|credential|p12|pfx)/i,
    anomalyType: "credential_harvesting",
    severity: "critical",
    action: "terminate",
    description: "Searching for credential files across filesystem",
  },
  {
    pattern: /grep\s+-r.*password|grep\s+-r.*secret|grep\s+-r.*api.?key/i,
    anomalyType: "credential_harvesting",
    severity: "high",
    action: "suspend",
    description: "Recursively grepping for credentials",
  },
  // Mass file access
  {
    pattern: /find\s+\/\s+-type\s+f\s+-print|find\s+\/\s+-exec\s+cat/i,
    anomalyType: "mass_file_access",
    severity: "high",
    action: "suspend",
    description: "Mass file enumeration from root",
  },
  // Environment variable dumping
  {
    pattern: /printenv\s*$|env\s*$|export\s*$|set\s*$/m,
    anomalyType: "credential_harvesting",
    severity: "high",
    action: "alert",
    description: "Dumping all environment variables",
  },
  // Privilege escalation attempts
  {
    pattern: /\bsudo\s+-i\b|\bsudo\s+su\b|\bsudo\s+bash\b/i,
    anomalyType: "privilege_escalation",
    severity: "critical",
    action: "terminate",
    description: "Attempted root privilege escalation",
  },
  {
    pattern: /\bchmod\s+(777|4755|u\+s|g\+s)\b/i,
    anomalyType: "privilege_escalation",
    severity: "high",
    action: "suspend",
    description: "Suspicious file permission change (SUID/world-writable)",
  },
  // C2 / exfiltration
  {
    pattern: /curl\s+.*-X\s+POST\s+http.*\s+-d\s+\$\{?\w+(SECRET|KEY|TOKEN|PASSWORD)/i,
    anomalyType: "unusual_egress",
    severity: "critical",
    action: "terminate",
    description: "Possible data exfiltration via curl",
  },
  {
    pattern: /nc\s+.*\d+\.\d+\.\d+\.\d+\s+\d+|ncat\s+.*\d+\.\d+/i,
    anomalyType: "unusual_egress",
    severity: "critical",
    action: "terminate",
    description: "Netcat connection attempt — possible reverse shell",
  },
  {
    pattern: /bash\s+-i\s+>&\s+\/dev\/tcp\//i,
    anomalyType: "unusual_egress",
    severity: "critical",
    action: "terminate",
    description: "Bash reverse shell attempt detected",
  },
  // Reconnaissance
  {
    pattern: /\bnmap\b|\bnetstat\b|\bss\s+-|\barp\s+-a\b/i,
    anomalyType: "reconnaissance",
    severity: "medium",
    action: "alert",
    description: "Network reconnaissance command detected",
  },
  {
    pattern: /\bps\s+(aux|auxf|ef)\b|\bpstree\b/i,
    anomalyType: "reconnaissance",
    severity: "low",
    action: "alert",
    description: "Full process listing — possible reconnaissance",
  },
  // Docker/container escape
  {
    pattern: /docker\s+run\s+.*--privileged|docker\s+run\s+.*-v\s+\/:/i,
    anomalyType: "privilege_escalation",
    severity: "critical",
    action: "terminate",
    description: "Privileged container or root mount escape attempt",
  },
];

/**
 * Record a behaviour event for a task.
 * Triggers anomaly detection after recording.
 */
export async function recordBehaviourEvent(event: BehaviourEvent): Promise<AnomalyAlert[]> {
  // Add to ring buffer
  const buffer = taskEventBuffer.get(event.taskId) ?? [];
  buffer.push(event);
  if (buffer.length > MAX_EVENTS_PER_TASK) {
    buffer.shift(); // remove oldest
  }
  taskEventBuffer.set(event.taskId, buffer);

  // Check for anomalies
  return detectAnomalies(event, buffer);
}

/**
 * Analyse a behaviour event and recent history for anomaly patterns.
 */
async function detectAnomalies(
  event: BehaviourEvent,
  history: BehaviourEvent[],
): Promise<AnomalyAlert[]> {
  const alerts: AnomalyAlert[] = [];

  // Check command against suspicious patterns
  if (event.command) {
    for (const detector of SUSPICIOUS_COMMAND_PATTERNS) {
      if (detector.pattern.test(event.command)) {
        const alert = await createAlert({
          taskId: event.taskId,
          agentId: event.agentId,
          anomalyType: detector.anomalyType,
          severity: detector.severity,
          description: detector.description,
          evidence: [event.command],
          action: detector.action,
        });
        alerts.push(alert);

        // Execute response action
        await executeAlertAction(alert);
      }
    }
  }

  // Mass file access detection (>50 file access events in buffer)
  if (event.eventType === "file_accessed") {
    const recentFileAccess = history.filter(
      (e) => e.eventType === "file_accessed" &&
        e.timestamp > new Date(Date.now() - 60_000), // last 60 seconds
    );
    if (recentFileAccess.length > 50) {
      const alert = await createAlert({
        taskId: event.taskId,
        agentId: event.agentId,
        anomalyType: "mass_file_access",
        severity: "high",
        description: `Mass file access: ${recentFileAccess.length} files in 60 seconds`,
        evidence: recentFileAccess.slice(-5).map((e) => e.filePath ?? "unknown"),
        action: "suspend",
      });
      alerts.push(alert);
      await executeAlertAction(alert);
    }
  }

  // Mass repository access detection
  if (event.eventType === "repository_accessed") {
    const uniqueRepos = new Set(
      history
        .filter((e) => e.eventType === "repository_accessed" && e.repository)
        .map((e) => e.repository),
    );
    if (uniqueRepos.size > 10) {
      const alert = await createAlert({
        taskId: event.taskId,
        agentId: event.agentId,
        anomalyType: "mass_repo_access",
        severity: "high",
        description: `Mass repository access: ${uniqueRepos.size} unique repositories accessed`,
        evidence: [...uniqueRepos].slice(0, 10) as string[],
        action: "suspend",
      });
      alerts.push(alert);
      await executeAlertAction(alert);
    }
  }

  // Secret request spike detection
  if (event.eventType === "secret_requested") {
    const recentSecretRequests = history.filter(
      (e) => e.eventType === "secret_requested" &&
        e.timestamp > new Date(Date.now() - 300_000), // last 5 minutes
    );
    if (recentSecretRequests.length > 10) {
      const alert = await createAlert({
        taskId: event.taskId,
        agentId: event.agentId,
        anomalyType: "credential_harvesting",
        severity: "critical",
        description: `Secret harvesting: ${recentSecretRequests.length} secret requests in 5 minutes`,
        evidence: [`${recentSecretRequests.length} secret access events`],
        action: "terminate",
      });
      alerts.push(alert);
      await executeAlertAction(alert);
    }
  }

  return alerts;
}

/**
 * Create an anomaly alert and emit an audit event.
 */
async function createAlert(opts: {
  taskId: string;
  agentId?: string;
  anomalyType: AnomalyType;
  severity: AlertSeverity;
  description: string;
  evidence: string[];
  action: AnomalyAlert["action"];
}): Promise<AnomalyAlert> {
  const alert: AnomalyAlert = {
    alertId: crypto.randomUUID(),
    taskId: opts.taskId,
    agentId: opts.agentId,
    anomalyType: opts.anomalyType,
    severity: opts.severity,
    description: opts.description,
    evidence: opts.evidence,
    detectedAt: new Date(),
    action: opts.action,
  };

  await emitAudit({
    entityType: "behaviour-monitor",
    entityId: opts.taskId,
    eventType: `anomaly.${opts.anomalyType}`,
    actorType: "monitor",
    payload: {
      alertId: alert.alertId,
      agentId: opts.agentId,
      severity: opts.severity,
      description: opts.description,
      evidence: opts.evidence,
      action: opts.action,
    },
  });

  console.warn(
    `[SECURITY_ALERT] taskId="${opts.taskId}" agentId="${opts.agentId ?? "none"}" ` +
    `anomaly="${opts.anomalyType}" severity="${opts.severity}" action="${opts.action}" ` +
    `description="${opts.description}"`,
  );

  return alert;
}

/**
 * Execute the response action for an anomaly alert.
 */
async function executeAlertAction(alert: AnomalyAlert): Promise<void> {
  if (alert.action === "alert") {
    // Alert only — no automated action
    return;
  }

  if (alert.action === "suspend" || alert.action === "terminate") {
    // Mark task as failed
    await prisma.task.update({
      where: { id: alert.taskId },
      data: {
        status: "failed",
        resultSummary: `[SECURITY] Task terminated by behaviour monitor: ${alert.description}`,
      },
    }).catch((err) => {
      console.error(`[behaviour-monitor] Failed to terminate task ${alert.taskId}: ${err}`);
    });

    // Suspend agent if identified
    if (alert.agentId && alert.action === "suspend") {
      await prisma.agent.update({
        where: { id: alert.agentId },
        data: { status: "offline" },
      }).catch((err) => {
        console.error(`[behaviour-monitor] Failed to suspend agent ${alert.agentId}: ${err}`);
      });
    }

    await emitAudit({
      entityType: "behaviour-monitor",
      entityId: alert.taskId,
      eventType: `security.task.${alert.action}ed`,
      actorType: "monitor",
      payload: {
        alertId: alert.alertId,
        agentId: alert.agentId,
        reason: alert.description,
      },
    });
  }
}

/**
 * Analyse a command string for suspicious patterns without recording an event.
 * Used for pre-dispatch command validation.
 */
export function analyseCommand(command: string): {
  suspicious: boolean;
  patterns: Array<{ type: AnomalyType; severity: AlertSeverity; description: string }>;
} {
  const patterns: Array<{ type: AnomalyType; severity: AlertSeverity; description: string }> = [];

  for (const detector of SUSPICIOUS_COMMAND_PATTERNS) {
    if (detector.pattern.test(command)) {
      patterns.push({
        type: detector.anomalyType,
        severity: detector.severity,
        description: detector.description,
      });
    }
  }

  return { suspicious: patterns.length > 0, patterns };
}

/**
 * Get recent anomaly alerts from audit events.
 */
export async function getRecentAlerts(opts?: {
  sinceHours?: number;
  severity?: AlertSeverity;
  limit?: number;
}): Promise<Array<{
  alertId: string;
  taskId: string;
  anomalyType: string;
  severity: string;
  description: string;
  detectedAt: Date;
}>> {
  const since = new Date(Date.now() - (opts?.sinceHours ?? 24) * 60 * 60 * 1000);

  const events = await prisma.auditEvent.findMany({
    where: {
      eventType: { startsWith: "anomaly." },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    take: opts?.limit ?? 50,
  });

  return events.map((e) => {
    const payload = e.payload as Record<string, unknown>;
    return {
      alertId: payload.alertId as string ?? e.id,
      taskId: e.entityId,
      anomalyType: e.eventType.replace("anomaly.", ""),
      severity: payload.severity as string ?? "unknown",
      description: payload.description as string ?? "",
      detectedAt: e.createdAt,
    };
  });
}

/**
 * Clear the event buffer for a task (call on task completion/cleanup).
 */
export function clearTaskBuffer(taskId: string): void {
  taskEventBuffer.delete(taskId);
}
