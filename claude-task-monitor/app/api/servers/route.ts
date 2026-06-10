import { prisma } from "@/lib/prisma";
import { validateSshKeyPath } from "@/lib/ssh-key-path";
import { serverError } from "@/lib/api-error";

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

    return Response.json(
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

export async function POST(request: Request) {
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
    return Response.json(server, { status: 201 });
  } catch (err) {
    return serverError("servers POST", err);
  }
}
