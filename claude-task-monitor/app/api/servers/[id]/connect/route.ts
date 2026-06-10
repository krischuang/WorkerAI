import { prisma } from "@/lib/prisma";
import { testConnection } from "@/lib/ssh";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;

    // SSH connection test; cap at 10 per minute per server.
    const rl = apiRateLimit(`server:connect:${id}`, 10, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });

    const startedAt = new Date();
    const result = await testConnection({
      host: server.host,
      username: server.username,
      port: server.port,
      sshKeyPath: server.sshKeyPath,
    });

    await prisma.server.update({
      where: { id },
      data: {
        status: result.success ? "connected" : "failed",
        lastCheckedAt: new Date(),
      },
    });

    await prisma.serverCommandLog.create({
      data: {
        serverId: id,
        command: "whoami",
        status: result.success ? "success" : "failed",
        output: result.success ? result.message : undefined,
        errorMessage: result.success ? undefined : result.message,
        startedAt,
        finishedAt: new Date(),
      },
    });

    return Response.json(result);
  } catch (err) {
    return serverError("servers/[id]/connect POST", err);
  }
}
