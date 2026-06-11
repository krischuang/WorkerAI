import { serverError } from "@/lib/api-error";
import { generateSuggestionsForProject } from "@/lib/suggestion-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const count = await generateSuggestionsForProject(id);
    return Response.json({ generated: count }, { status: 201 });
  } catch (err) {
    return serverError("projects/[id]/generate-suggestions POST", err);
  }
}
