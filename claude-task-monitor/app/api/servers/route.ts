import { prisma } from "@/lib/prisma";

export async function GET() {
  const servers = await prisma.server.findMany({
    include: { _count: { select: { commandLogs: true } } },
    orderBy: { createdAt: "desc" },
  });
  return Response.json(servers);
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, host, username, port, sshKeyPath } = body;

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
    },
  });
  return Response.json(server, { status: 201 });
}
