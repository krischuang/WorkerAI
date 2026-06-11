import { serverError } from "@/lib/api-error";
import { rejectSuggestion } from "@/lib/suggestion-service";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    let reviewNote: string | undefined;
    try {
      const body = await req.json();
      reviewNote = body?.reviewNote;
    } catch { /* body is optional */ }

    const result = await rejectSuggestion(id, reviewNote);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    return new Response(null, { status: 204 });
  } catch (err) {
    return serverError("suggestions/[id]/reject POST", err);
  }
}
