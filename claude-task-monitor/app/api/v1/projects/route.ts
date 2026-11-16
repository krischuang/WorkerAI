import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { authenticateServiceAccountRequest } from "@/lib/service-account";

/**
 * External integration surface, see lib/service-account.ts.
 *
 * GET /api/v1/projects: lists only the projects the authenticated service
 * account is scoped to. The scope filter is applied in the Prisma `where`
 * clause itself (not a post-hoc JS filter) so an out-of-scope project is
 * never even fetched from the database.
 */
export async function GET(request: Request) {
  try {
    const client = await authenticateServiceAccountRequest(request);
    if (!client) {
      return Response.json({ error: "Invalid or revoked API key" }, { status: 401 });
    }

    if (client.projectIds.length === 0) {
      return Response.json({ projects: [] });
    }

    const projects = await prisma.project.findMany({
      where: { id: { in: client.projectIds } },
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
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });

    return Response.json({ projects });
  } catch (err) {
    return serverError("v1/projects GET", err);
  }
}
