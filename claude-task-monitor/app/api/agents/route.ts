import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const serverId = searchParams.get("serverId");

  const agents = await prisma.agent.findMany({
    where: serverId ? { serverId } : undefined,
    include: {
      server: { select: { id: true, name: true, host: true } },
      _count: { select: { tasks: true } },
    },
    orderBy: [{ serverId: "asc" }, { name: "asc" }],
  });

  return NextResponse.json(agents);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { serverId, name, slug, workDir, tmuxSession, claudePermissionMode } = body;

  if (!serverId || !name || !slug || !workDir || !tmuxSession) {
    return NextResponse.json(
      { error: "serverId, name, slug, workDir, and tmuxSession are required" },
      { status: 400 }
    );
  }

  const slugPattern = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;
  if (!slugPattern.test(slug)) {
    return NextResponse.json(
      { error: "slug must be lowercase alphanumeric with hyphens (e.g. agent-1)" },
      { status: 400 }
    );
  }

  const server = await prisma.server.findUnique({ where: { id: serverId } });
  if (!server) {
    return NextResponse.json({ error: "Server not found" }, { status: 404 });
  }

  try {
    const agent = await prisma.agent.create({
      data: {
        serverId,
        name,
        slug,
        workDir,
        tmuxSession,
        claudePermissionMode: claudePermissionMode ?? "workspace_write",
      },
      include: {
        server: { select: { id: true, name: true, host: true } },
      },
    });
    return NextResponse.json(agent, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && err.code === "P2002") {
      return NextResponse.json(
        { error: `An agent with slug "${slug}" already exists on this server` },
        { status: 409 }
      );
    }
    throw err;
  }
}
