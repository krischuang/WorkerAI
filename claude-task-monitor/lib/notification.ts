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

import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";
import { sendAlertEmail } from "@/lib/email";

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
  event: "task.completed" | "task.failed" | "task.stalled";
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
  stallDetectedAt?: string | null;
  lastProgressAt?: string | null;
  timeStuckMinutes?: number | null;
}

/**
 * Pure helper: converts raw stall timestamps into ISO strings for the payload.
 * Exported for unit testing.
 */
export function buildStalledFields(stallData: {
  stallDetectedAt: Date | null;
  lastProgressAt: Date | null;
  timeStuckMinutes: number;
}): { stallDetectedAt: string | null; lastProgressAt: string | null; timeStuckMinutes: number } {
  return {
    stallDetectedAt: stallData.stallDetectedAt?.toISOString() ?? null,
    lastProgressAt: stallData.lastProgressAt?.toISOString() ?? null,
    timeStuckMinutes: stallData.timeStuckMinutes,
  };
}

async function buildPayload(
  taskId: string,
  event: "task.completed" | "task.failed" | "task.stalled",
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
  const isStalled   = p.event === "task.stalled";
  const isCompleted = !isStalled && p.status === "completed";

  const color = isStalled ? 0xf59e0b : isCompleted ? 0x22c55e : 0xef4444; // amber : green : red
  const emoji = isStalled ? "⚠️" : isCompleted ? "✅" : "❌";
  const label = isStalled ? "Stalled" : isCompleted ? "Completed" : "Failed";

  const project = p.projectName ? ` · ${p.projectName}` : "";

  const stallFields = isStalled
    ? [
        ...(p.timeStuckMinutes != null
          ? [{ name: "Stuck for", value: `${p.timeStuckMinutes}m`, inline: true }]
          : []),
        ...(p.stallDetectedAt
          ? [{ name: "Stall detected", value: new Date(p.stallDetectedAt).toISOString(), inline: true }]
          : []),
      ]
    : [];

  const durationField =
    !isStalled && p.durationMs != null
      ? [{ name: "Duration", value: `${Math.round(p.durationMs / 1000)}s`, inline: true }]
      : [];

  return {
    embeds: [
      {
        title: `${emoji} Task ${label}`,
        description: p.title,
        color,
        fields: [
          ...(p.errorMessage
            ? [{ name: "Error", value: p.errorMessage.slice(0, 1024), inline: false }]
            : []),
          { name: "Project", value: p.projectName ?? "(none)", inline: true },
          ...stallFields,
          ...durationField,
        ],
        footer: { text: `taskId: ${p.taskId}${project}` },
        timestamp: p.timestamp,
      },
    ],
  };
}

function formatSlack(p: NotificationPayload): object {
  const isStalled   = p.event === "task.stalled";
  const isCompleted = !isStalled && p.status === "completed";

  const emoji = isStalled ? ":warning:" : isCompleted ? ":white_check_mark:" : ":x:";
  const label = isStalled ? "Stalled" : isCompleted ? "Completed" : "Failed";

  const duration =
    !isStalled && p.durationMs != null
      ? `\n*Duration:* ${Math.round(p.durationMs / 1000)}s`
      : "";
  const stuckLine =
    isStalled && p.timeStuckMinutes != null
      ? `\n*Stuck for:* ${p.timeStuckMinutes}m`
      : "";

  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *Task ${label}*\n${p.title}${duration}${stuckLine}`,
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

/**
 * Returns the dedicated webhook signing secret, creating a fresh 32-byte hex
 * value in SystemConfig on first call.
 */
export async function getOrCreateWebhookSigningSecret(): Promise<string> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: "webhook_signing_secret" },
    select: { value: true },
  });
  if (row?.value) return row.value;

  const secret = randomBytes(32).toString("hex");
  await prisma.systemConfig.upsert({
    where: { key: "webhook_signing_secret" },
    create: { key: "webhook_signing_secret", value: secret },
    update: { value: secret },
  });
  return secret;
}

/**
 * Sign a webhook payload with a timestamp to prevent replay attacks.
 *
 * Signature format: t=<unix_seconds>,v1=HMAC-SHA256("<unix_seconds>.<body>", secret)
 *
 * Receivers should:
 *   1. Parse t= to get the timestamp.
 *   2. Reject payloads older than 5 minutes.
 *   3. Recompute the HMAC and compare using a timing-safe function.
 */
export function signWebhookPayload(body: string, secret: string, nowMs: number = Date.now()): string {
  const tSec = Math.floor(nowMs / 1000);
  const sig = createHmac("sha256", secret)
    .update(`${tSec}.${body}`)
    .digest("hex");
  return `t=${tSec},v1=${sig}`;
}

/**
 * Verify a webhook signature header.
 * Returns the parsed timestamp in seconds, or null if verification fails.
 *
 * @param header  The value of the X-WorkerAI-Signature header.
 * @param body    The raw request body string.
 * @param secret  The shared signing secret.
 * @param nowMs   Current epoch ms (injectable for tests).
 * @param maxAgeMs Maximum age in ms before the request is rejected (default 5 min).
 */
export function verifyWebhookSignature(
  header: string,
  body: string,
  secret: string,
  nowMs: number = Date.now(),
  maxAgeMs = 5 * 60 * 1000,
): { valid: boolean; reason?: string } {
  const tMatch = header.match(/t=(\d+)/);
  const v1Match = header.match(/v1=([0-9a-f]+)/);
  if (!tMatch || !v1Match) return { valid: false, reason: "malformed signature header" };

  const tSec = parseInt(tMatch[1], 10);
  const age = nowMs - tSec * 1000;
  if (age < 0) return { valid: false, reason: "timestamp in future" };
  if (age > maxAgeMs) return { valid: false, reason: "timestamp expired" };

  const expected = createHmac("sha256", secret)
    .update(`${tSec}.${body}`)
    .digest("hex");

  const ha = createHash("sha256").update(v1Match[1]).digest();
  const hb = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(ha, hb)) return { valid: false, reason: "signature mismatch" };

  return { valid: true };
}

function signPayload(body: string, secret: string, tsMs: number): string {
  return createHmac("sha256", secret)
    .update(`${tsMs}.${body}`)
    .digest("hex");
}

// ─── Retry delivery ───────────────────────────────────────────────────────────

const RETRY_DELAYS_MS = [2_000, 8_000, 20_000];
const MAX_ATTEMPTS = 3;

async function fireWebhook(
  cfg: WebhookConfig,
  body: string,
  headers: Record<string, string>,
  eventType: string,
): Promise<void> {
  // Add timestamp + HMAC signature for replay protection.
  // Format: t=<unix_sec>,v1=HMAC-SHA256("<unix_sec>.<body>", secret)
  const sigSecret = await getOrCreateWebhookSigningSecret().catch(() => null);
  if (sigSecret) {
    headers["X-WorkerAI-Signature"] = signWebhookPayload(body, sigSecret);
  }

  let lastError: string | undefined;
  let lastStatusCode: number | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }

    try {
      const res = await fetch(cfg.url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });

      if (res.ok) {
        const deliveryRecord = JSON.stringify({ timestamp: new Date().toISOString(), status: "ok" });
        await prisma.systemConfig.upsert({
          where: { key: "webhook_last_delivery" },
          create: { key: "webhook_last_delivery", value: deliveryRecord },
          update: { value: deliveryRecord },
        });
        return;
      }

      lastStatusCode = res.status;
      lastError = `HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      lastStatusCode = undefined;
    }
  }

  const failureRecord = JSON.stringify({
    timestamp: new Date().toISOString(),
    eventType,
    statusCode: lastStatusCode ?? null,
    error: lastError ?? "Unknown error",
  });
  console.error(`[notification] Webhook delivery failed after ${MAX_ATTEMPTS} attempts for ${eventType}: ${lastError}`);
  await Promise.all([
    prisma.systemConfig.upsert({
      where: { key: "webhook_last_failure" },
      create: { key: "webhook_last_failure", value: failureRecord },
      update: { value: failureRecord },
    }),
    // Increment cumulative failure counter for the /api/metrics endpoint.
    prisma.$executeRaw`
      INSERT INTO "SystemConfig" (id, key, value, "createdAt", "updatedAt")
      VALUES (gen_random_uuid()::text, 'webhook_delivery_failures_total', '1', now(), now())
      ON CONFLICT (key) DO UPDATE
        SET value = (COALESCE("SystemConfig".value::bigint, 0) + 1)::text, "updatedAt" = now()
    `,
  ]);
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
  const payload = await buildPayload(taskId, event).catch(() => null);

  // Webhook delivery
  try {
    const cfg = await getWebhookConfig();
    if (cfg && payload) {
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
      await fireWebhook(cfg, body, headers, event);
    }
  } catch (err) {
    console.warn("[notification] Webhook delivery error:", err);
  }

  // Email delivery — only for task.failed
  if (event === "task.failed" && payload) {
    sendAlertEmail({
      subject: `[WorkerAI] Task failed: ${payload.title}`,
      text: [
        `Task "${payload.title}" failed.`,
        payload.projectName ? `Project: ${payload.projectName}` : "",
        payload.errorMessage ? `Error: ${payload.errorMessage}` : "",
        `Task ID: ${payload.taskId}`,
        `Time: ${payload.timestamp}`,
      ].filter(Boolean).join("\n"),
      html: `<p><strong>Task failed:</strong> ${payload.title}</p>
${payload.projectName ? `<p>Project: ${payload.projectName}</p>` : ""}
${payload.errorMessage ? `<p style="color:#dc2626">Error: ${payload.errorMessage}</p>` : ""}
<p style="color:#6b7280;font-size:12px">Task ID: ${payload.taskId} · ${payload.timestamp}</p>`,
    }).catch(() => {});
  }
}

// ─── Worker unhealthy ─────────────────────────────────────────────────────────

export interface WorkerUnhealthyPayload {
  event: "worker.unhealthy";
  resourceType: "server" | "agent";
  resourceId: string;
  name: string;
  consecutiveFailures: number;
  lastErrorMessage: string | null;
  timestamp: string;
}

function formatDiscordWorkerUnhealthy(p: WorkerUnhealthyPayload): object {
  return {
    embeds: [
      {
        title: `🔴 Worker Unhealthy: ${p.name}`,
        color: 0xef4444,
        fields: [
          { name: "Type", value: p.resourceType === "server" ? "Server" : "Agent", inline: true },
          { name: "Consecutive Failures", value: String(p.consecutiveFailures), inline: true },
          ...(p.lastErrorMessage
            ? [{ name: "Last Error", value: p.lastErrorMessage.slice(0, 1024), inline: false }]
            : []),
        ],
        footer: { text: `${p.resourceType}Id: ${p.resourceId}` },
        timestamp: p.timestamp,
      },
    ],
  };
}

function formatSlackWorkerUnhealthy(p: WorkerUnhealthyPayload): object {
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:red_circle: *Worker Unhealthy: ${p.name}*\n*Type:* ${p.resourceType} · *Failures:* ${p.consecutiveFailures}`,
        },
      },
      ...(p.lastErrorMessage
        ? [
            {
              type: "context",
              elements: [
                {
                  type: "mrkdwn",
                  text: `Error: ${p.lastErrorMessage.slice(0, 200)}`,
                },
              ],
            },
          ]
        : []),
    ],
  };
}

/**
 * Fire-and-forget worker-unhealthy webhook alert.
 * Call with `.catch(() => {})` — errors are logged but never propagate.
 */
export async function emitWorkerUnhealthyNotification(
  payload: Omit<WorkerUnhealthyPayload, "event" | "timestamp">,
): Promise<void> {
  const full: WorkerUnhealthyPayload = {
    ...payload,
    event: "worker.unhealthy",
    timestamp: new Date().toISOString(),
  };

  // Webhook delivery
  try {
    const cfg = await getWebhookConfig();
    if (cfg) {
      let body: string;
      if (cfg.url.includes("discord.com/api/webhooks")) {
        body = JSON.stringify(formatDiscordWorkerUnhealthy(full));
      } else if (cfg.url.includes("hooks.slack.com") || cfg.url.includes("slack.com/services")) {
        body = JSON.stringify(formatSlackWorkerUnhealthy(full));
      } else {
        body = JSON.stringify(full);
      }
      const tsMs = Date.now();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "WorkerAI-Webhook/1.0",
        "X-Webhook-Event": "worker.unhealthy",
        "X-Webhook-Timestamp": String(tsMs),
      };
      if (cfg.secret) {
        headers["X-Webhook-Signature"] = `sha256=${signPayload(body, cfg.secret, tsMs)}`;
      }
      await fireWebhook(cfg, body, headers, "worker.unhealthy");
    }
  } catch (err) {
    console.warn("[notification] Worker-unhealthy webhook error:", err);
  }

  // Email delivery
  sendAlertEmail({
    subject: `[WorkerAI] Worker unhealthy: ${full.name}`,
    text: [
      `Worker "${full.name}" is unhealthy.`,
      `Type: ${full.resourceType}`,
      `Consecutive failures: ${full.consecutiveFailures}`,
      full.lastErrorMessage ? `Last error: ${full.lastErrorMessage}` : "",
      `Time: ${full.timestamp}`,
    ].filter(Boolean).join("\n"),
    html: `<p><strong>Worker unhealthy:</strong> ${full.name}</p>
<p>Type: ${full.resourceType} · Consecutive failures: ${full.consecutiveFailures}</p>
${full.lastErrorMessage ? `<p style="color:#dc2626">Error: ${full.lastErrorMessage}</p>` : ""}
<p style="color:#6b7280;font-size:12px">${full.resourceType}Id: ${full.resourceId} · ${full.timestamp}</p>`,
  }).catch(() => {});
}

/**
 * Fire-and-forget stalled-task webhook notification.
 * Emits a "task.stalled" event with extra stall diagnostics alongside the
 * standard task fields.  Call with `.catch(() => {})`.
 */
export async function emitStalledNotification(
  taskId: string,
  stallData: {
    stallDetectedAt: Date | null;
    lastProgressAt: Date | null;
    timeStuckMinutes: number;
  },
): Promise<void> {
  const base = await buildPayload(taskId, "task.failed").catch(() => null);
  const payload: NotificationPayload | null = base
    ? { ...base, event: "task.stalled", ...buildStalledFields(stallData) }
    : null;

  // Webhook delivery
  try {
    const cfg = await getWebhookConfig();
    if (cfg && payload) {
      const body = formatBody(cfg.url, payload);
      const tsMs = Date.now();
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": "WorkerAI-Webhook/1.0",
        "X-Webhook-Event": "task.stalled",
        "X-Webhook-Timestamp": String(tsMs),
      };
      if (cfg.secret) {
        headers["X-Webhook-Signature"] = `sha256=${signPayload(body, cfg.secret, tsMs)}`;
      }
      await fireWebhook(cfg, body, headers, "task.stalled");
    }
  } catch (err) {
    console.warn("[notification] Stalled webhook delivery error:", err);
  }

  // Email delivery
  if (payload) {
    sendAlertEmail({
      subject: `[WorkerAI] Task stalled: ${payload.title}`,
      text: [
        `Task "${payload.title}" appears to be stalled.`,
        payload.projectName ? `Project: ${payload.projectName}` : "",
        `Stuck for: ${stallData.timeStuckMinutes} minutes`,
        stallData.stallDetectedAt ? `Stall detected at: ${stallData.stallDetectedAt.toISOString()}` : "",
        payload.errorMessage ? `Last error: ${payload.errorMessage}` : "",
        `Task ID: ${payload.taskId}`,
      ].filter(Boolean).join("\n"),
      html: `<p><strong>Task stalled:</strong> ${payload.title}</p>
${payload.projectName ? `<p>Project: ${payload.projectName}</p>` : ""}
<p style="color:#d97706">Stuck for ${stallData.timeStuckMinutes} minutes</p>
${payload.errorMessage ? `<p style="color:#dc2626">Last error: ${payload.errorMessage}</p>` : ""}
<p style="color:#6b7280;font-size:12px">Task ID: ${payload.taskId} · ${payload.timestamp}</p>`,
    }).catch(() => {});
  }
}

// ─── Worker disk full ─────────────────────────────────────────────────────────

export interface WorkerDiskFullPayload {
  event: "worker.disk_full";
  resourceType: "server" | "agent";
  resourceId: string;
  name: string;
  diskUsedBytes: bigint;
  diskTotalBytes: bigint;
  utilisationPct: number;
  timestamp: string;
}

function formatDiscordDiskFull(p: WorkerDiskFullPayload): object {
  const pct = Math.round(p.utilisationPct * 100);
  const usedGb = (Number(p.diskUsedBytes) / 1_073_741_824).toFixed(1);
  const totalGb = (Number(p.diskTotalBytes) / 1_073_741_824).toFixed(1);
  return {
    embeds: [
      {
        title: `🔴 Disk Almost Full: ${p.name}`,
        color: 0xef4444,
        fields: [
          { name: "Type", value: p.resourceType === "server" ? "Server" : "Agent", inline: true },
          { name: "Utilisation", value: `${pct}%`, inline: true },
          { name: "Used / Total", value: `${usedGb} GB / ${totalGb} GB`, inline: true },
        ],
        footer: { text: `${p.resourceType}Id: ${p.resourceId}` },
        timestamp: p.timestamp,
      },
    ],
  };
}

function formatSlackDiskFull(p: WorkerDiskFullPayload): object {
  const pct = Math.round(p.utilisationPct * 100);
  const usedGb = (Number(p.diskUsedBytes) / 1_073_741_824).toFixed(1);
  const totalGb = (Number(p.diskTotalBytes) / 1_073_741_824).toFixed(1);
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:red_circle: *Disk Almost Full: ${p.name}*\n*Type:* ${p.resourceType} · *Utilisation:* ${pct}% · *Used:* ${usedGb} GB / ${totalGb} GB`,
        },
      },
    ],
  };
}

/**
 * Fire-and-forget disk-full webhook alert.
 * Fires when disk utilisation exceeds 90%. Call with `.catch(() => {})`.
 */
export async function emitDiskFullNotification(
  payload: Omit<WorkerDiskFullPayload, "event" | "timestamp" | "utilisationPct">,
): Promise<void> {
  try {
    const cfg = await getWebhookConfig();
    if (!cfg) return;

    const utilisationPct = Number(payload.diskTotalBytes) > 0
      ? Number(payload.diskUsedBytes) / Number(payload.diskTotalBytes)
      : 0;

    const full: WorkerDiskFullPayload = {
      ...payload,
      event: "worker.disk_full",
      utilisationPct,
      timestamp: new Date().toISOString(),
    };

    let body: string;
    if (cfg.url.includes("discord.com/api/webhooks")) {
      body = JSON.stringify(formatDiscordDiskFull(full));
    } else if (cfg.url.includes("hooks.slack.com") || cfg.url.includes("slack.com/services")) {
      body = JSON.stringify(formatSlackDiskFull(full));
    } else {
      body = JSON.stringify(full, (_, v) => typeof v === "bigint" ? v.toString() : v);
    }

    const tsMs = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WorkerAI-Webhook/1.0",
      "X-Webhook-Event": "worker.disk_full",
      "X-Webhook-Timestamp": String(tsMs),
    };
    if (cfg.secret) {
      headers["X-Webhook-Signature"] = `sha256=${signPayload(body, cfg.secret, tsMs)}`;
    }

    await fireWebhook(cfg, body, headers, "worker.disk_full");
  } catch (err) {
    console.warn("[notification] Disk-full webhook error:", err);
  }
}

// ─── Stale-pending task ───────────────────────────────────────────────────────

export interface StalePendingPayload {
  event: "task.stale_pending";
  taskId: string;
  title: string;
  projectId: string;
  projectName: string | null;
  pendingMinutes: number;
  timestamp: string;
}

function formatDiscordStalePending(p: StalePendingPayload): object {
  return {
    embeds: [
      {
        title: `⏳ Task Stale (pending ${p.pendingMinutes}m): ${p.title}`,
        color: 0xf59e0b,
        fields: [
          { name: "Project", value: p.projectName ?? "(none)", inline: true },
          { name: "Pending for", value: `${p.pendingMinutes} minutes`, inline: true },
        ],
        footer: { text: `taskId: ${p.taskId}` },
        timestamp: p.timestamp,
      },
    ],
  };
}

function formatSlackStalePending(p: StalePendingPayload): object {
  return {
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:hourglass_flowing_sand: *Task Stale (pending ${p.pendingMinutes}m)*\n${p.title}`,
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
            ].filter(Boolean).join(" · "),
          },
        ],
      },
    ],
  };
}

/**
 * Fire-and-forget stale-pending webhook alert. Call with `.catch(() => {})`.
 */
export async function emitStalePendingNotification(opts: {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string | null;
  pendingMinutes: number;
}): Promise<void> {
  try {
    const cfg = await getWebhookConfig();
    if (!cfg) return;

    const full: StalePendingPayload = {
      event: "task.stale_pending",
      ...opts,
      timestamp: new Date().toISOString(),
    };

    let body: string;
    if (cfg.url.includes("discord.com/api/webhooks")) {
      body = JSON.stringify(formatDiscordStalePending(full));
    } else if (cfg.url.includes("hooks.slack.com") || cfg.url.includes("slack.com/services")) {
      body = JSON.stringify(formatSlackStalePending(full));
    } else {
      body = JSON.stringify(full);
    }

    const tsMs = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WorkerAI-Webhook/1.0",
      "X-Webhook-Event": "task.stale_pending",
      "X-Webhook-Timestamp": String(tsMs),
    };
    if (cfg.secret) {
      headers["X-Webhook-Signature"] = `sha256=${signPayload(body, cfg.secret, tsMs)}`;
    }
    await fireWebhook(cfg, body, headers, "task.stale_pending");
  } catch (err) {
    console.warn("[notification] Stale-pending webhook error:", err);
  }
}
