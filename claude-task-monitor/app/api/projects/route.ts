import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

export async function GET() {
  try {
    const projects = await prisma.project.findMany({
      include: {
        _count: { select: { tasks: true } },
        tasks: {
          select: { status: true },
        },
      },
      orderBy: [{ priority: "asc" }, { createdAt: "desc" }],
    });
    return Response.json(projects);
  } catch (err) {
    return serverError("projects GET", err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { name, description, priority, status, repoUrl, defaultBranch, workspaceStrategy } = body;

    if (!name) {
      return Response.json({ error: "Name is required" }, { status: 400 });
    }

    const project = await prisma.project.create({
      data: {
        name,
        description,
        priority: priority ?? "P3",
        status: status ?? "active",
        ...(repoUrl !== undefined && { repoUrl }),
        ...(defaultBranch !== undefined && { defaultBranch }),
        ...(workspaceStrategy !== undefined && { workspaceStrategy }),
      },
    });
    return Response.json(project, { status: 201 });
  } catch (err) {
    return serverError("projects POST", err);
  }
}
