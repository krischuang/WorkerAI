import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const template = await prisma.taskTemplate.findUnique({ where: { id } });
    if (!template) return Response.json({ error: "Not found" }, { status: 404 });
    return Response.json(template);
  } catch (err) {
    return serverError("task-templates/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const existing = await prisma.taskTemplate.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
    if (existing.isBuiltIn) {
      return Response.json({ error: "Built-in templates cannot be edited" }, { status: 403 });
    }

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

    const template = await prisma.taskTemplate.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(category !== undefined && { category }),
        ...(taskType !== undefined && { taskType }),
        ...(estimatedCostLevel !== undefined && { estimatedCostLevel }),
        ...(priority !== undefined && { priority }),
        ...(titleTemplate !== undefined && { titleTemplate }),
        ...(descriptionTemplate !== undefined && { descriptionTemplate }),
        ...(variables !== undefined && { variables: Array.isArray(variables) ? variables : [] }),
      },
    });
    return Response.json(template);
  } catch (err) {
    return serverError("task-templates/[id] PUT", err);
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const existing = await prisma.taskTemplate.findUnique({ where: { id } });
    if (!existing) return Response.json({ error: "Not found" }, { status: 404 });
    if (existing.isBuiltIn) {
      return Response.json({ error: "Built-in templates cannot be deleted" }, { status: 403 });
    }
    await prisma.taskTemplate.delete({ where: { id } });
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("task-templates/[id] DELETE", err);
  }
}
