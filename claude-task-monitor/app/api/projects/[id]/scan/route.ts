import { NextRequest, NextResponse } from "next/server";
import { serverError } from "@/lib/api-error";
import { runProjectScan } from "@/lib/project-scan-service";

type Ctx = { params: Promise<{ id: string }> };

export const maxDuration = 180;

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const scanType = (body?.scanType as string | undefined) ?? "gap_analysis";
    const serverId = body?.serverId as string | undefined;

    if (!serverId) {
      return NextResponse.json({ error: "serverId is required" }, { status: 400 });
    }

    const result = await runProjectScan(id, serverId, scanType);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        no_server: 400,
        server_busy: 409,
        no_completed_tasks: 400,
        ssh_failed: 502,
        parse_failed: 422,
        timed_out: 504,
      };
      return NextResponse.json(
        { error: result.reason, detail: "detail" in result ? result.detail : undefined },
        { status: statusMap[result.reason] ?? 500 },
      );
    }

    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    return serverError("projects/[id]/scan POST", err);
  }
}
