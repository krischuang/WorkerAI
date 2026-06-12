import { serverError } from "@/lib/api-error";
import { approveSuggestion } from "@/lib/suggestion-service";
import { logAdminAction } from "@/lib/admin-audit-log";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await approveSuggestion(id);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }
    await logAdminAction(req, {
      action: "suggestion.approved",
      targetType: "Suggestion",
      targetId: id,
    });
    return Response.json(result, { status: 201 });
  } catch (err) {
    return serverError("suggestions/[id]/approve POST", err);
  }
}
