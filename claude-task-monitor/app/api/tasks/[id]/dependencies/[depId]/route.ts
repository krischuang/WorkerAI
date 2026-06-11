import { serverError } from "@/lib/api-error";
import { removeDependency } from "@/lib/task-dependency";

type Ctx = { params: Promise<{ id: string; depId: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const { id, depId } = await ctx.params;
    const result = await removeDependency(id, depId);
    if (!result.ok) {
      return Response.json({ error: "Dependency not found" }, { status: 404 });
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("tasks/[id]/dependencies/[depId] DELETE", err);
  }
}
