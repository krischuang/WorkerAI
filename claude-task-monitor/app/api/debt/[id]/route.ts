import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { serverError } from "@/lib/api-error";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const item = await prisma.debtItem.findUnique({ where: { id } });
    if (!item) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(item);
  } catch (err) {
    return serverError("debt/[id] GET", err);
  }
}

export async function PUT(request: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const body = await request.json();
    const { status, severity, title, description, category } = body;

    const existing = await prisma.debtItem.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const item = await prisma.debtItem.update({
      where: { id },
      data: {
        ...(status !== undefined && { status: status as never }),
        ...(severity !== undefined && { severity: severity as never }),
        ...(title !== undefined && { title }),
        ...(description !== undefined && { description }),
        ...(category !== undefined && { category: category as never }),
        ...(status === "resolved" && { resolvedAt: new Date() }),
        ...(status && status !== "resolved" && { resolvedAt: null }),
      },
    });

    return NextResponse.json(item);
  } catch (err) {
    return serverError("debt/[id] PUT", err);
  }
}
