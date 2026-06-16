import { NextRequest, NextResponse } from "next/server";
import { generateProjectObjective } from "@/lib/project-objective-service";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 600;

/** "Generate Objective with Claude" button — drafts the Project Objective section via SSH. */
export async function POST(_request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const result = await generateProjectObjective(id);

    if (!result.ok) {
      const statusByReason: Record<string, number> = {
        not_found: 404,
        no_session: 409,
        server_busy: 409,
        ssh_failed: 502,
        timed_out: 504,
      };
      return NextResponse.json(result, { status: statusByReason[result.reason] ?? 500 });
    }

    return NextResponse.json(result);
  } catch (err) {
    return serverError("projects/[id]/objective/generate POST", err);
  }
}
