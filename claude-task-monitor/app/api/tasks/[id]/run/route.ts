import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-error";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { dispatchTask } from "@/lib/task-service";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // SSH task dispatch; cap at 10 per minute per task.
    const rl = apiRateLimit(`task:run:${id}`, 10, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const result = await dispatchTask(id);

    if (result.ok) return NextResponse.json({ success: true });

    switch (result.reason) {
      case "not_found":
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      case "no_resource":
        return NextResponse.json(
          { error: "No agent or server assigned to this task" },
          { status: 400 },
        );
      case "usage_blocked":
        return NextResponse.json({ blocked: true, ...result.usageInfo });
      case "already_running":
        return NextResponse.json(
          {
            error:
              result.entity === "agent"
                ? "Agent already has a running task"
                : "Server already has a running task",
          },
          { status: 409 },
        );
      case "not_dispatchable":
        return NextResponse.json({ error: "Task is not in a runnable state" }, { status: 409 });
      case "ssh_failed":
      case "tmux_missing":
        return NextResponse.json({ error: result.detail ?? "SSH dispatch failed" }, { status: 502 });
    }
  } catch (err) {
    return serverError("tasks/[id]/run POST", err);
  }
}
