import { access, constants as fsConstants } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { validateSshKeyPath } from "@/lib/ssh-key-path";
import { serverError } from "@/lib/api-error";
import { jsonResponse } from "@/lib/json-response";
import { logAdminAction } from "@/lib/admin-audit-log";
import type { NextRequest } from "next/server";

export async function GET() {
  try {
    const servers = await prisma.server.findMany({
      include: {
        _count: { select: { commandLogs: true } },
        tasks: {
          where: { status: { in: ["queued", "running"] } },
          select: { status: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return jsonResponse(
      servers.map(({ tasks, ...s }) => ({
        ...s,
        queuedCount: tasks.filter((t) => t.status === "queued").length,
        runningCount: tasks.filter((t) => t.status === "running").length,
      }))
    );

  } catch (err) {
    return serverError("servers GET", err);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, host, username, port, sshKeyPath, claudePermissionMode } = body;

    if (!name || !host || !username || !sshKeyPath) {
      return Response.json(
        { error: "name, host, username, and sshKeyPath are required" },
        { status: 400 }
      );
    }

    const keyValidation = validateSshKeyPath(sshKeyPath);
    if (!keyValidation.ok) {
      return Response.json({ error: keyValidation.error }, { status: 400 });
    }

    try {
      await access(keyValidation.resolved, fsConstants.R_OK);
    } catch {
      return Response.json(
        { error: `SSH key file not found or not readable: ${keyValidation.resolved}` },
        { status: 400 }
      );
    }

    const server = await prisma.server.create({
      data: {
        name,
        host,
        username,
        port: port ? Number(port) : 22,
        sshKeyPath: keyValidation.resolved,
        ...(claudePermissionMode !== undefined && { claudePermissionMode }),
      },
    });
    await logAdminAction(request, {
      action: "server.created",
      targetType: "Server",
      targetId: server.id,
      payload: { name, host, username },
    });
    return jsonResponse(server, { status: 201 });
  } catch (err) {
    return serverError("servers POST", err);
  }
}
