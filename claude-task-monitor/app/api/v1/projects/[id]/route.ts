import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { authenticateServiceAccountRequest, isProjectInScope } from "@/lib/service-account";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/v1/projects/[id]: single-project detail, scoped.
 *
 * An out-of-scope project ID returns 404, identically to an unknown ID,
 * never 403, so a scoped key cannot distinguish "exists but not yours"
 * from "doesn't exist" (same IDOR philosophy as lib/resource-access.ts).
 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const client = await authenticateServiceAccountRequest(_req);
    if (!client) {
      return Response.json({ error: "Invalid or revoked API key" }, { status: 401 });
    }

    const { id } = await ctx.params;
    if (!isProjectInScope(client, id)) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    const project = await prisma.project.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        priority: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { tasks: true } },
      },
    });
    if (!project) return Response.json({ error: "Not found" }, { status: 404 });

    return Response.json(project);
  } catch (err) {
    return serverError("v1/projects/[id] GET", err);
  }
}
