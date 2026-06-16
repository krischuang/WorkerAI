import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";

export async function GET(): Promise<NextResponse> {
  const row = await prisma.systemConfig.findUnique({
    where: { key: "webhook_signing_secret" },
    select: { value: true },
  });
  return NextResponse.json({ secret: row?.value ?? null });
}

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const secret = randomBytes(32).toString("hex");
  await prisma.systemConfig.upsert({
    where: { key: "webhook_signing_secret" },
    create: { key: "webhook_signing_secret", value: secret },
    update: { value: secret },
  });
  return NextResponse.json({ secret });
}
