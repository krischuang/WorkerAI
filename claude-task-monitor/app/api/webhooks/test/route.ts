import { NextResponse } from "next/server";
import { serverError } from "@/lib/api-error";
import { getWebhookConfig } from "@/lib/notification";
import { createHmac } from "crypto";

/** POST /api/webhooks/test — fire a synthetic test notification to the configured URL */
export async function POST() {
  try {
    const cfg = await getWebhookConfig();
    if (!cfg) {
      return NextResponse.json({ error: "No webhook URL configured" }, { status: 400 });
    }

    const payload = {
      event: "task.completed",
      taskId: "test-task-id",
      title: "Test notification from WorkerAI",
      status: "completed",
      projectId: "test-project-id",
      projectName: "Test Project",
      agentId: null,
      serverId: null,
      errorMessage: null,
      durationMs: 42_000,
      timestamp: new Date().toISOString(),
    };

    // Detect Discord/Slack format
    let body: string;
    if (cfg.url.includes("discord.com/api/webhooks")) {
      body = JSON.stringify({
        embeds: [
          {
            title: "✅ Task Completed (test)",
            description: payload.title,
            color: 0x22c55e,
            footer: { text: "WorkerAI webhook test" },
            timestamp: payload.timestamp,
          },
        ],
      });
    } else if (cfg.url.includes("hooks.slack.com") || cfg.url.includes("slack.com/services")) {
      body = JSON.stringify({
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: *WorkerAI webhook test*\n${payload.title}`,
            },
          },
        ],
      });
    } else {
      body = JSON.stringify(payload);
    }

    const tsMs = Date.now();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "WorkerAI-Webhook/1.0",
      "X-Webhook-Event": "task.completed",
      "X-Webhook-Timestamp": String(tsMs),
    };

    if (cfg.secret) {
      const sig = createHmac("sha256", cfg.secret)
        .update(`${tsMs}.${body}`)
        .digest("hex");
      headers["X-Webhook-Signature"] = `sha256=${sig}`;
    }

    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return NextResponse.json(
        { error: `Webhook returned HTTP ${res.status}`, detail: text.slice(0, 300) },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, status: res.status, url: cfg.url });
  } catch (err) {
    return serverError("webhooks/test POST", err);
  }
}
