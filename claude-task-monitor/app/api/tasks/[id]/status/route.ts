import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { validateStatusUpdate } from "@/lib/task-validation";
import type { NextRequest } from "next/server";
import type { $Enums } from "@/app/generated/prisma/client";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { status } = await request.json();

    const validationErr = validateStatusUpdate(status);
    if (validationErr) {
      return Response.json({ error: validationErr.message }, { status: 400 });
    }

    const task = await prisma.task.update({
      where: { id },
      data: { status: status as $Enums.TaskStatus },
    });
    return Response.json(task);
  } catch (err) {
    return serverError("tasks/[id]/status PUT", err);
  }
}
