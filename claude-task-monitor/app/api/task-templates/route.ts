import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { ensureBuiltInTemplates } from "@/lib/task-templates";

export async function GET() {
  try {
    await ensureBuiltInTemplates();
    const templates = await prisma.taskTemplate.findMany({
      orderBy: [{ isBuiltIn: "desc" }, { category: "asc" }, { name: "asc" }],
    });
    return Response.json(templates);
  } catch (err) {
    return serverError("task-templates GET", err);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const {
      name,
      category,
      taskType,
      estimatedCostLevel,
      priority,
      titleTemplate,
      descriptionTemplate,
      variables,
    } = body;

    if (!name || !titleTemplate || !descriptionTemplate) {
      return Response.json(
        { error: "name, titleTemplate, and descriptionTemplate are required" },
        { status: 400 }
      );
    }

    const template = await prisma.taskTemplate.create({
      data: {
        name,
        category: category ?? "custom",
        taskType: taskType ?? "coding",
        estimatedCostLevel: estimatedCostLevel ?? "medium",
        priority: priority ?? "P3",
        titleTemplate,
        descriptionTemplate,
        variables: Array.isArray(variables) ? variables : [],
        isBuiltIn: false,
      },
    });
    return Response.json(template, { status: 201 });
  } catch (err) {
    return serverError("task-templates POST", err);
  }
}
