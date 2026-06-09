import { prisma } from "@/lib/prisma";
import { execSSH } from "@/lib/ssh";
import type { NextRequest } from "next/server";

// Allow up to 10 minutes for long-running commands like dnf update, apt upgrade, etc.
export const maxDuration = 600;

const EXEC_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_COMMAND_LENGTH = 4_096;

type Ctx = { params: Promise<{ id: string }> };

// Prevents cross-origin requests from malicious pages that try to use the
// user's browser to POST commands to the localhost API.
// Direct requests (curl, server-side fetch) have no Origin header → allowed.
function isLocalOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

// Narrow blocklist for commands that are irreversible and destructive at the
// OS level. Arbitrary commands remain allowed — this is an intentional
// product decision for a local-only tool (see CLAUDE.md). The blocklist only
// covers operations that can silently destroy the remote host's filesystem or
// cause unbounded resource exhaustion with no recovery path.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  // rm -rf / or rm -fr / (any flag combination with r+f targeting root)
  /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/\s*$|\/\s+)/i,
  // Filesystem format
  /\bmkfs\b/i,
  // dd writing directly to a raw disk device
  /\bdd\b.*\bof=\/dev\/(s|h|vd|xvd|nvme)/i,
  // Classic fork bomb
  /:\s*\(\s*\)\s*\{.*\|.*:.*\}.*;\s*:/,
  // Wipe disk with shred/wipefs
  /\b(shred|wipefs)\b.*\/dev\//i,
];

function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(cmd));
}

export async function POST(request: NextRequest, ctx: Ctx) {
  if (!isLocalOrigin(request)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await ctx.params;
  const body = await request.json();
  const { command } = body as { command: string };

  if (!command || typeof command !== "string" || command.trim() === "") {
    return Response.json({ error: "command is required" }, { status: 400 });
  }

  if (command.length > MAX_COMMAND_LENGTH) {
    return Response.json(
      { error: `Command exceeds maximum length of ${MAX_COMMAND_LENGTH} characters` },
      { status: 400 }
    );
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
      trimmed,
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
      command: trimmed,
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
