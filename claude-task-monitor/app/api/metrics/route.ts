import { prisma, pool } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

const TASK_STATUSES = ["pending", "queued", "running", "paused", "completed", "failed"] as const;

function gauge(name: string, help: string, value: number, labels?: Record<string, string>): string {
  const labelStr = labels
    ? `{${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(",")}}`
    : "";
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name}${labelStr} ${value}\n`;
}

function counter(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

export async function GET(request: NextRequest) {
  try {
    // ── Bearer token auth ────────────────────────────────────────────────────
    const tokenRow = await prisma.systemConfig.findUnique({
      where: { key: "metrics_token" },
      select: { value: true },
    });
    const configuredToken = tokenRow?.value?.trim() ?? "";

    if (!configuredToken) {
      return new Response("Metrics endpoint is disabled (no metrics_token configured)", {
        status: 503,
        headers: { "content-type": "text/plain" },
      });
    }

    const authHeader = request.headers.get("authorization") ?? "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

    if (!provided || provided !== configuredToken) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "content-type": "text/plain", "www-authenticate": 'Bearer realm="metrics"' },
      });
    }

    // ── Gather data ──────────────────────────────────────────────────────────
    const [taskCounts, activeAgents, activeServers, heartbeatRow, failureRow] = await Promise.all([
      prisma.task.groupBy({ by: ["status"], _count: { id: true } }),
      prisma.agent.count({ where: { status: { in: ["idle", "running"] } } }),
      prisma.server.count({ where: { status: "connected" } }),
      prisma.systemConfig.findUnique({
        where: { key: "poller_last_heartbeat_at" },
        select: { value: true },
      }),
      prisma.systemConfig.findUnique({
        where: { key: "webhook_delivery_failures_total" },
        select: { value: true },
      }),
    ]);

    // Build status→count map (fill missing statuses with 0)
    const statusMap: Record<string, number> = Object.fromEntries(
      TASK_STATUSES.map((s) => [s, 0])
    );
    for (const row of taskCounts) {
      statusMap[row.status as string] = row._count.id;
    }

    const lastHeartbeatAt = heartbeatRow?.value ?? null;
    const secondsSinceHeartbeat = lastHeartbeatAt
      ? Math.floor((Date.now() - new Date(lastHeartbeatAt).getTime()) / 1000)
      : -1;

    const webhookFailures = parseInt(failureRow?.value ?? "0", 10) || 0;

    // ── Build Prometheus text ────────────────────────────────────────────────
    const lines: string[] = [];

    lines.push(gauge("workerai_db_pool_total", "Total connections in the PostgreSQL connection pool", pool.totalCount));
    lines.push(gauge("workerai_db_pool_idle", "Idle connections in the PostgreSQL connection pool", pool.idleCount));
    lines.push(gauge("workerai_db_pool_waiting", "Queries currently waiting for a pool connection", pool.waitingCount));

    lines.push(
      `# HELP workerai_poller_last_heartbeat_seconds_ago Seconds since the background poller last reported a heartbeat (-1 if never)\n` +
      `# TYPE workerai_poller_last_heartbeat_seconds_ago gauge\n` +
      `workerai_poller_last_heartbeat_seconds_ago ${secondsSinceHeartbeat}\n`
    );

    // tasks_by_status — emit all statuses as labelled series
    lines.push(`# HELP workerai_tasks_by_status Number of tasks in each status\n# TYPE workerai_tasks_by_status gauge`);
    for (const status of TASK_STATUSES) {
      lines.push(`workerai_tasks_by_status{status="${status}"} ${statusMap[status]}`);
    }
    lines.push("");

    lines.push(gauge("workerai_active_agents", "Agents with status idle or running", activeAgents));
    lines.push(gauge("workerai_active_servers", "Servers with status connected", activeServers));
    lines.push(counter("workerai_webhook_delivery_failures_total", "Cumulative webhook delivery failures since server start", webhookFailures));

    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  } catch (err) {
    return serverError("metrics GET", err);
  }
}
