import { serverError } from "@/lib/api-error";
import { recoverAgent } from "@/lib/auto-recovery";
import type { NextRequest } from "next/server";

export const maxDuration = 30;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await recoverAgent(id, "manual");

    if (result.reason === "not_found") {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    if (result.reason === "running_tasks_present") {
      return Response.json({ error: "Cannot recover: agent has running tasks" }, { status: 409 });
    }
    if (!result.attempted) {
      return Response.json({ error: result.reason ?? "Recovery not attempted" }, { status: 400 });
    }
    if (!result.success) {
      return Response.json({ error: result.error ?? "Recovery failed" }, { status: 502 });
    }

    return Response.json({ success: true, command: result.command });
  } catch (err) {
    return serverError("agents/[id]/recover POST", err);
  }
}
