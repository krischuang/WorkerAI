import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { ADMIN_PASSWORD_HASH_KEY } from "@/lib/admin-auth";
import { logAdminAction } from "@/lib/admin-audit-log";
import { setRateLimitEnabled } from "@/lib/api-rate-limit";
import type { NextRequest } from "next/server";

const DEFAULTS: Record<string, string> = {
  stall_threshold_minutes: "30",
  confirm_cycles: "2",
  webhook_url: "",
  webhook_secret: "",
  timeout_coding_minutes: "120",
  timeout_research_minutes: "60",
  timeout_writing_minutes: "45",
  timeout_review_minutes: "30",
  timeout_maintenance_minutes: "90",
  worker_failure_alert_threshold: "3",
  execution_log_retention_days: "90",
  metrics_token: "",
  smtp_host: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_pass: "",
  smtp_from: "",
  alert_email_to: "",
  // Set to "false" to disable IP-based rate limiting (e.g. trusted internal networks).
  rate_limit_enabled: "true",
};

export async function GET() {
  try {
    const rows = await prisma.systemConfig.findMany({ orderBy: { key: "asc" } });
    // Merge with defaults so keys not yet written still appear.
    // Exclude admin_password_hash — it must not be exposed via API.
    const config: Record<string, string> = { ...DEFAULTS };
    const HIDDEN_KEYS = new Set([ADMIN_PASSWORD_HASH_KEY, "smtp_pass"]);
    for (const row of rows) {
      if (!HIDDEN_KEYS.has(row.key)) config[row.key] = row.value;
    }
    return Response.json(config);
  } catch (err) {
    return serverError("admin/config GET", err);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body: Record<string, string> = await request.json();

    // Only allow known config keys; ignore others.
    const allowed = new Set(Object.keys(DEFAULTS));
    const updates = Object.entries(body).filter(([k]) => allowed.has(k));

    if (updates.length === 0) {
      return Response.json({ error: "No valid config keys provided" }, { status: 400 });
    }

    await Promise.all(
      updates.map(([key, value]) =>
        prisma.systemConfig.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        })
      )
    );

    await logAdminAction(request, {
      action: "config.updated",
      targetType: "SystemConfig",
      payload: { keys: updates.map(([k]) => k), values: Object.fromEntries(updates) },
    });

    // Apply rate_limit_enabled immediately to the in-process cache so the
    // change takes effect without a server restart.
    const rlUpdate = updates.find(([k]) => k === "rate_limit_enabled");
    if (rlUpdate) {
      setRateLimitEnabled(rlUpdate[1] !== "false");
    }

    return Response.json({ updated: updates.map(([k]) => k) });
  } catch (err) {
    return serverError("admin/config PUT", err);
  }
}
