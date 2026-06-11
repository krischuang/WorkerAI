import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const suggestions = await prisma.taskSuggestion.findMany({
      where: { projectId: id },
      orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    });
    return Response.json(suggestions);
  } catch (err) {
    return serverError("projects/[id]/suggestions GET", err);
  }
}
