import { access, constants as fsConstants } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { validateSshKeyPath } from "@/lib/ssh-key-path";
import { serverError } from "@/lib/api-error";
import { jsonResponse } from "@/lib/json-response";
import { logAdminAction } from "@/lib/admin-audit-log";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id } });
    if (!server) return Response.json({ error: "Not found" }, { status: 404 });
    return jsonResponse(server);
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

      const existing = await prisma.server.findUnique({ where: { id }, select: { sshKeyPath: true } });
      if (!existing) return Response.json({ error: "Not found" }, { status: 404 });

      if (resolvedKeyPath !== existing.sshKeyPath) {
        try {
          await access(resolvedKeyPath, fsConstants.R_OK);
        } catch {
          return Response.json(
            { error: `SSH key file not found or not readable: ${resolvedKeyPath}` },
            { status: 400 }
          );
        }
      }
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

    const changedFields = Object.fromEntries(
      Object.entries({ name, host, username, port, claudePermissionMode }).filter(([, v]) => v !== undefined),
    );
    await logAdminAction(request, {
      action: "server.updated",
      targetType: "Server",
      targetId: id,
      payload: { fields: changedFields },
    });

    return jsonResponse(server);
  } catch (err) {
    return serverError("servers/[id] PUT", err);
  }
}

export async function DELETE(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const server = await prisma.server.findUnique({ where: { id }, select: { name: true } });
    await prisma.server.delete({ where: { id } });
    await logAdminAction(request, {
      action: "server.deleted",
      targetType: "Server",
      targetId: id,
      payload: { name: server?.name },
    });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("servers/[id] DELETE", err);
  }
}
