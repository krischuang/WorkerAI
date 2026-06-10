import { prisma } from "@/lib/prisma";
import { runSSHCommand, ALLOWED_COMMANDS, type AllowedCommand } from "@/lib/ssh";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // SSH env-check commands; cap at 10 per minute per server.
    const rl = apiRateLimit(`server:run:${id}`, 10, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const body = await request.json();
    const { command } = body as { command: string };

    if (!(ALLOWED_COMMANDS as readonly string[]).includes(command)) {
      return Response.json(
        { error: `Command not allowed. Permitted: ${ALLOWED_COMMANDS.join(", ")}` },
        { status: 400 }
      );
    }

    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });

    const startedAt = new Date();
    let logStatus: "success" | "failed" = "success";
    let output: string | undefined;
    let errorMessage: string | undefined;

    try {
      const result = await runSSHCommand(
        {
          host: server.host,
          username: server.username,
          port: server.port,
          sshKeyPath: server.sshKeyPath,
        },
        command as AllowedCommand
      );

      output = result.stdout || result.stderr;
      if (result.exitCode !== 0) {
        logStatus = "failed";
        errorMessage = result.stderr || `Exit code ${result.exitCode}`;
      }
    } catch (err) {
      logStatus = "failed";
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    const log = await prisma.serverCommandLog.create({
      data: {
        serverId: id,
        command,
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
      logId: log.id,
    });
  } catch (err) {
    return serverError("servers/[id]/run POST", err);
  }
}
