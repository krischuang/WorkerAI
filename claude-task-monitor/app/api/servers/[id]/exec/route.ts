import { prisma } from "@/lib/prisma";
import { execSSH } from "@/lib/ssh";
import { isLocalOrigin, isDestructiveCommand, validateCommand } from "@/lib/exec-guards";
import type { NextRequest } from "next/server";

// Allow up to 10 minutes for long-running commands like dnf update, apt upgrade, etc.
export const maxDuration = 600;

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  if (!isLocalOrigin(request.headers.get("origin"))) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const body = await request.json();
  const { command } = body as { command: string };

  const commandErr = validateCommand(command);
  if (commandErr) {
    return Response.json({ error: commandErr }, { status: 400 });
  }

  const trimmed = command.trim();

  if (isDestructiveCommand(trimmed)) {
    return Response.json(
      { error: "Command matches a destructive pattern and has been blocked" },
      { status: 422 }
    );
  }

  const server = await prisma.server.findUnique({ where: { id } });
  if (!server) return Response.json({ error: "Not found" }, { status: 404 });

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
      trimmed,
      EXEC_TIMEOUT_MS,
      request.signal  // closes SSH when client aborts the fetch
    );

    output = result.stdout || result.stderr || undefined;
    if (result.exitCode !== 0) {
      errorMessage = result.stderr || `Exit code ${result.exitCode}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : String(err);
  }

  // Exec commands are not logged to ServerCommandLog — commands sent through
  // the arbitrary exec terminal may contain inline secrets (passwords in CLI
  // flags, tokens in headers) and the in-memory terminal history in the UI
  // already provides session-level visibility.

  return Response.json({
    status: errorMessage ? "failed" : "success",
    output: output ?? "",
    errorMessage: errorMessage ?? null,
  });
}
