import { prisma } from "@/lib/prisma";
import { validateSshKeyPath } from "@/lib/ssh-key-path";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(server);
  } catch (err) {
    return serverError("servers/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const { name, host, username, port, sshKeyPath, claudePermissionMode } = body;

    let resolvedKeyPath: string | undefined;
    if (sshKeyPath !== undefined) {
      const keyValidation = validateSshKeyPath(sshKeyPath);
      if (!keyValidation.ok) {
        return Response.json({ error: keyValidation.error }, { status: 400 });
      }
      resolvedKeyPath = keyValidation.resolved;
    }

    const server = await prisma.server.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(host !== undefined && { host }),
        ...(username !== undefined && { username }),
        ...(port !== undefined && { port: Number(port) }),
        ...(resolvedKeyPath !== undefined && { sshKeyPath: resolvedKeyPath }),
        ...(claudePermissionMode !== undefined && { claudePermissionMode }),
      },
    });
    return Response.json(server);
  } catch (err) {
    return serverError("servers/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    await prisma.server.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("servers/[id] DELETE", err);
  }
}
