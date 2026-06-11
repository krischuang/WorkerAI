import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";
import { runDebtScan } from "@/lib/debt-scan-service";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const severity = searchParams.get("severity");

    const items = await prisma.debtItem.findMany({
      where: {
        projectId: id,
        ...(status && { status: status as never }),
        ...(severity && { severity: severity as never }),
      },
      orderBy: [{ severity: "desc" }, { createdAt: "asc" }],
    });

    return NextResponse.json(items);
  } catch (err) {
    return serverError("projects/[id]/debt GET", err);
  }
}

export const maxDuration = 180;

export async function POST(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json().catch(() => ({}));
    const serverId = body?.serverId as string | undefined;

    if (!serverId) {
      return NextResponse.json({ error: "serverId is required" }, { status: 400 });
    }

    const result = await runDebtScan(id, serverId);

    if (!result.ok) {
      const statusMap: Record<string, number> = {
        not_found: 404,
        no_server: 400,
        server_busy: 409,
        no_tasks: 400,
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
    return serverError("projects/[id]/debt POST", err);
  }
}
