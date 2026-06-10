import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { execSSH, type ServerConfig } from "@/lib/ssh";
import { sendRawPromptToTmux } from "@/lib/ssh-claude-tmux";
import { withServerDispatchLock } from "@/lib/dispatch-lock";
import { buildReviewPrompt } from "@/lib/prompt-sanitiser";
import { serverError } from "@/lib/api-error";

export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const POLL_INTERVAL_MS = 10_000;
const POLL_TIMEOUT_MS = 50_000;

function cleanPane(raw: string): string {
  return raw
    .replace(/\r/g, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

async function pollForVerdict(
  ssh: ServerConfig,
  tmuxSession: string,
  timeoutMs: number
): Promise<"done" | "incomplete" | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const { stdout } = await execSSH(
        ssh,
        `tmux capture-pane -t ${tmuxSession} -p`,
        5_000
      );
      const pane = cleanPane(stdout);

      const verdictMatch = pane.match(/VERDICT:\s*(done|incomplete)/i);
      if (verdictMatch) {
        const v = verdictMatch[1].toLowerCase();
        return v === "done" ? "done" : "incomplete";
      }
    } catch {
      // SSH hiccup — keep polling
    }
  }

  return null;
}

export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    const task = await prisma.task.findUnique({
      where: { id },
      include: {
        server: true,
        executionLogs: {
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    if (!task) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    if (task.status !== "completed") {
      return NextResponse.json({ error: "Task is not completed" }, { status: 400 });
    }
    if (!task.server) {
      return NextResponse.json({ error: "No server assigned to this task" }, { status: 400 });
    }

    const s = task.server;
    const latestLog = task.executionLogs[0] ?? null;

    // Build a structurally hardened prompt that XML-fences all user-supplied and
    // DB-derived fields so injected directives cannot escape their data context.
    const reviewPrompt = buildReviewPrompt({
      title: task.title,
      description: task.description,
      resultSummary: task.resultSummary,
      outputSummary: latestLog?.outputSummary,
      logText: latestLog?.logText,
    });

    const ssh: ServerConfig = {
      host: s.host,
      port: s.port,
      username: s.username,
      sshKeyPath: s.sshKeyPath,
    };

    type ReviewOutcome =
      | { ok: true; verdict: "done" | "incomplete" | null }
      | { ok: false; error: string; httpStatus: number };

    const result = await withServerDispatchLock<ReviewOutcome>(s.id, async () => {
      // Guard: refuse to inject into a session that's executing another task.
      const runningCount = await prisma.task.count({
        where: { serverId: s.id, status: "running" },
      });
      if (runningCount > 0) {
        return {
          ok: false,
          error: "Server has a running task — retry once it completes",
          httpStatus: 409,
        };
      }

      const sendResult = await sendRawPromptToTmux(
        { host: s.host, port: s.port, username: s.username, sshKeyPath: s.sshKeyPath },
        reviewPrompt,
        s.tmuxSession,
      );
      if (!sendResult.success) {
        return { ok: false, error: sendResult.error ?? "SSH dispatch failed", httpStatus: 502 };
      }

      // Hold the lock through polling so no task dispatch can corrupt the session
      // while we wait for Claude's VERDICT response (up to 50 s).
      const verdict = await pollForVerdict(ssh, s.tmuxSession, POLL_TIMEOUT_MS);
      return { ok: true, verdict };
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.httpStatus });
    }

    const { verdict } = result;

    if (!verdict) {
      return NextResponse.json(
        { error: "Timed out waiting for Claude verdict" },
        { status: 504 }
      );
    }

    if (verdict === "done") {
      await prisma.task.update({ where: { id }, data: { status: "archived" } });
      return NextResponse.json({ verdict: "done", status: "archived" });
    } else {
      await prisma.task.update({
        where: { id },
        data: { status: "pending", resultSummary: null },
      });
      return NextResponse.json({ verdict: "incomplete", status: "pending" });
    }
  } catch (err) {
    return serverError("tasks/[id]/review POST", err);
  }
}
