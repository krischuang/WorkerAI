/**
 * Webhook notification service.
 *
 * Fires a non-blocking HTTP POST whenever a task transitions to
 * "completed" or "failed".  Supports three delivery modes:
 *
 *   Generic JSON  — default; sends the raw payload
 *   Discord embed — auto-detected when URL contains discord.com/api/webhooks
 *   Slack Block   — auto-detected when URL contains hooks.slack.com
 *
 * Configuration (DB wins over env var so it can be changed from the UI):
 *   SystemConfig key "webhook_url"    / env WEBHOOK_URL
 *   SystemConfig key "webhook_secret" / env WEBHOOK_SECRET  (HMAC-SHA256 signing)
 */

import { createHmac } from "crypto";
import { prisma } from "@/lib/prisma";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface WebhookConfig {
  url: string;
  secret: string;
}

export async function getWebhookConfig(): Promise<WebhookConfig | null> {
  const rows = await prisma.systemConfig.findMany({
    where: { key: { in: ["webhook_url", "webhook_secret"] } },
    select: { key: true, value: true },
  });
  const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const url = map["webhook_url"] ?? process.env.WEBHOOK_URL ?? "";
  const secret = map["webhook_secret"] ?? process.env.WEBHOOK_SECRET ?? "";

  if (!url.trim()) return null;
  return { url: url.trim(), secret: secret.trim() };
}

// ─── Payload ──────────────────────────────────────────────────────────────────

export interface NotificationPayload {
  event: "task.completed" | "task.failed";
  taskId: string;
  title: string;
  status: "completed" | "failed";
  projectId: string;
  projectName: string | null;
  agentId: string | null;
  serverId: string | null;
  errorMessage: string | null;
  durationMs: number | null;
  timestamp: string;
}

async function buildPayload(
  taskId: string,
  event: "task.completed" | "task.failed",
): Promise<NotificationPayload | null> {
  const task = await prisma.task.findUnique({
    where: { id: taskId },
    select: {
      id: true,
      title: true,
      status: true,
      projectId: true,
      agentId: true,
      serverId: true,
      project: { select: { name: true } },
      executionLogs: {
        where: { finishedAt: { not: null } },
        orderBy: { finishedAt: "desc" },
        take: 1,
        select: { durationMs: true, errorMessage: true },
      },
    },
  });

  if (!task) return null;

  const latestLog = task.executionLogs[0] ?? null;
  return {
    event,
    taskId: task.id,
    title: task.title,
    status: task.status as "completed" | "failed",
    projectId: task.projectId,
    projectName: task.project?.name ?? null,
    agentId: task.agentId,
    serverId: task.serverId,
    errorMessage: latestLog?.errorMessage ?? null,
    durationMs: latestLog?.durationMs ?? null,
    timestamp: new Date().toISOString(),
  };
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatDiscord(p: NotificationPayload): object {
  const isCompleted = p.status === "completed";
  const color = isCompleted ? 0x22c55e : 0xef4444; // green : red
  const emoji = isCompleted ? "✅" : "❌";
  const duration = p.durationMs != null
    ? ` · ${Math.round(p.durationMs / 1000)}s`
    : "";
  const project = p.projectName ? ` · ${p.projectName}` : "";

  return {
    embeds: [
      {
        title: `${emoji} Task ${isCompleted ? "Completed" : "Failed"}`,
        description: p.title,
        color,
        fields: [
          ...(p.errorMessage
            ? [{ name: "Error", value: p.errorMessage.slice(0, 1024), inline: false }]
            : []),
          { name: "Project", value: p.projectName ?? "(none)", inline: true },
          ...(duration ? [{ name: "Duration", value: duration.slice(3), inline: true }] : []),
        ],
        footer: { text: `taskId: ${p.taskId}${project}` },
        timestamp: p.timestamp,
      },
    ],
  };
}

function formatSlack(p: NotificationPayload): object {
  const isCompleted = p.status === "completed";
  const emoji = isCompleted ? ":white_check_mark:" : ":x:";
  const duration = p.durationMs != null
    ? `\n*Duration:* ${Math.round(p.durationMs / 1000)}s`
    : "";

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Task ${isCompleted ? "Completed" : "Failed"}*\n${p.title}${duration}`,
        },
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: [
              p.projectName && `Project: *${p.projectName}*`,
              `taskId: \`${p.taskId}\``,
              p.errorMessage && `Error: ${p.errorMessage.slice(0, 200)}`,
            ]
              .filter(Boolean)
              .join(" · "),
          },
        ],
      },
    ],
  };
}

function formatBody(url: string, payload: NotificationPayload): string {
  if (url.includes("discord.com/api/webhooks")) {
    return JSON.stringify(formatDiscord(payload));
  }
  if (url.includes("hooks.slack.com") || url.includes("slack.com/services")) {
    return JSON.stringify(formatSlack(payload));
  }
  return JSON.stringify(payload);
}

// ─── HMAC signing ─────────────────────────────────────────────────────────────

function signPayload(body: string, secret: string, tsMs: number): string {
  return createHmac("sha256", secret)
    .update(`${tsMs}.${body}`)
    .digest("hex");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Fire-and-forget webhook notification.
 * Call with `.catch(() => {})` — errors are logged but never propagate.
 */
export async function emitNotification(
  taskId: string,
  event: "task.completed" | "task.failed",
): Promise<void> {
  try {
    const cfg = await getWebhookConfig();
    if (!cfg) return;

    const payload = await buildPayload(taskId, event);
    if (!payload) return;

    const body = formatBody(cfg.url, payload);
    const tsMs = Date.now();

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WorkerAI-Webhook/1.0",
      "X-Webhook-Event": event,
      "X-Webhook-Timestamp": String(tsMs),
    };

    if (cfg.secret) {
      headers["X-Webhook-Signature"] = `sha256=${signPayload(body, cfg.secret, tsMs)}`;
    }

    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.warn(`[notification] Webhook POST to ${cfg.url} failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn("[notification] Webhook delivery error:", err);
  }
}
