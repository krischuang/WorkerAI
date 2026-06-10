import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-error";
import { reviewTask } from "@/lib/task-service";

export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const result = await reviewTask(id);

    if (!result.ok) {
      switch (result.reason) {
        case "not_found":
          return NextResponse.json({ error: "Task not found" }, { status: 404 });
        case "not_completed":
          return NextResponse.json({ error: "Task is not completed" }, { status: 400 });
        case "no_server":
          return NextResponse.json({ error: "No server assigned to this task" }, { status: 400 });
        case "server_busy":
          return NextResponse.json(
            { error: "Server has a running task — retry once it completes" },
            { status: 409 },
          );
        case "ssh_failed":
          return NextResponse.json(
            { error: result.detail ?? "SSH dispatch failed" },
            { status: 502 },
          );
      }
    }

    if (result.verdict === null) {
      return NextResponse.json(
        { error: "Timed out waiting for Claude verdict" },
        { status: 504 },
      );
    }

    return NextResponse.json({ verdict: result.verdict, status: result.newStatus });
  } catch (err) {
    return serverError("tasks/[id]/review POST", err);
  }
}
