import { prisma } from "@/lib/prisma";

export async function GET() {
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
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, description, priority, status } = body;

  if (!name) {
    return Response.json({ error: "Name is required" }, { status: 400 });
  }

  const project = await prisma.project.create({
    data: { name, description, priority: priority ?? "P3", status: status ?? "active" },
  });
  return Response.json(project, { status: 201 });
}
