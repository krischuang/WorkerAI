import { prisma } from "@/lib/prisma";

export async function GET() {
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
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, host, username, port, sshKeyPath, claudePermissionMode } = body;

  if (!name || !host || !username || !sshKeyPath) {
    return Response.json(
      { error: "name, host, username, and sshKeyPath are required" },
      { status: 400 }
    );
  }

  const server = await prisma.server.create({
    data: {
      name,
      host,
      username,
      port: port ? Number(port) : 22,
      sshKeyPath,
      ...(claudePermissionMode !== undefined && { claudePermissionMode }),
    },
  });
  return Response.json(server, { status: 201 });
}
