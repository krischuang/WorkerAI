import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { logAdminAction } from "@/lib/admin-audit-log";

export async function GET(): Promise<NextResponse> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: "webhook_signing_secret" },
    select: { value: true },
  });
  return NextResponse.json({ secret: row?.value ?? null });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = randomBytes(32).toString("hex");
  await prisma.systemConfig.upsert({
    where: { key: "webhook_signing_secret" },
    create: { key: "webhook_signing_secret", value: secret },
    update: { value: secret },
  });
  await logAdminAction(req, {
    action: "webhook_signing_secret.rotated",
    targetType: "SystemConfig",
    targetId: "webhook_signing_secret",
  });
  return NextResponse.json({ secret });
}
