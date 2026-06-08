import { prisma } from "@/lib/prisma";
import { execSSH } from "@/lib/ssh";
import type { NextRequest } from "next/server";

// Allow up to 10 minutes for long-running commands like dnf update, apt upgrade, etc.
export const maxDuration = 600;

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.json();
  const { command } = body as { command: string };

  if (!command || typeof command !== "string" || command.trim() === "") {
    return Response.json({ error: "command is required" }, { status: 400 });
  }

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return Response.json({ error: "Not found" }, { status: 404 });

  const startedAt = new Date();
  let logStatus: "success" | "failed" = "success";
  let output: string | undefined;
  let errorMessage: string | undefined;

  try {
    const result = await execSSH(
      {
        host: server.host,
        username: server.username,
        port: server.port,
        sshKeyPath: server.sshKeyPath,
      },
      command.trim(),
      EXEC_TIMEOUT_MS,
      request.signal  // closes SSH when client aborts the fetch
    );

    output = result.stdout || result.stderr || undefined;
    if (result.exitCode !== 0) {
      logStatus = "failed";
      errorMessage = result.stderr || `Exit code ${result.exitCode}`;
    }
  } catch (err) {
    logStatus = "failed";
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  await prisma.serverCommandLog.create({
    data: {
      serverId: id,
      command: command.trim(),
      status: logStatus,
      output,
      errorMessage,
      startedAt,
      finishedAt: new Date(),
    },
  });

  return Response.json({
    status: logStatus,
    output: output ?? "",
    errorMessage: errorMessage ?? null,
  });
}
