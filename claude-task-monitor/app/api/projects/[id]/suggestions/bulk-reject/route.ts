import { serverError } from "@/lib/api-error";
import { bulkRejectSuggestions } from "@/lib/suggestion-service";
import { logAdminAction } from "@/lib/admin-audit-log";
import type { NextRequest } from "next/server";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await req.json().catch(() => ({}));
    const ids: string[] = Array.isArray(body?.ids) ? body.ids : [];

    if (ids.length === 0) {
      return Response.json({ error: "ids must be a non-empty array" }, { status: 400 });
    }

    const result = await bulkRejectSuggestions(id, ids);
    if (!result.ok) {
      return Response.json({ error: result.error }, { status: 400 });
    }

    await logAdminAction(req, {
      action: "suggestions.bulk_rejected",
      targetType: "Project",
      targetId: id,
      payload: { count: ids.length, ids },
    });

    return Response.json(result, { status: 200 });
  } catch (err) {
    return serverError("projects/[id]/suggestions/bulk-reject POST", err);
  }
}
