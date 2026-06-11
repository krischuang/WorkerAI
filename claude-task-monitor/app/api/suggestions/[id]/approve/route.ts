import { serverError } from "@/lib/api-error";
import { approveSuggestion } from "@/lib/suggestion-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(_req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await approveSuggestion(id);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return Response.json(result, { status: 201 });
  } catch (err) {
    return serverError("suggestions/[id]/approve POST", err);
  }
}
