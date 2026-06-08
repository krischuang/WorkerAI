import { prisma } from "@/lib/prisma";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const server = await prisma.server.findUnique({
    where: { id },
    include: {
      commandLogs: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
    },
  });
  if (!server) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json(server);
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = await request.json();
  const { name, host, username, port, sshKeyPath } = body;

  const server = await prisma.server.update({
    where: { id },
    data: {
      ...(name !== undefined && { name }),
      ...(host !== undefined && { host }),
      ...(username !== undefined && { username }),
      ...(port !== undefined && { port: Number(port) }),
      ...(sshKeyPath !== undefined && { sshKeyPath }),
    },
  });
  return Response.json(server);
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  await prisma.server.delete({ where: { id } });
  return new Response(null, { status: 204 });
}
