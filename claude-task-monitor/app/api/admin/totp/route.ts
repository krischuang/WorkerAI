import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  TOTP_SECRET_KEY, TOTP_PENDING_KEY,
  generateTotpSecret, getActiveTotpSecret, getPendingTotpSecret,
  verifyTotpCode, getTotpUri, generateQrDataUrl,
} from "@/lib/admin-totp";

/** GET /api/admin/totp — return TOTP status and setup QR for pending secret. */
export async function GET() {
  const active = await getActiveTotpSecret();
  if (active) {
    return NextResponse.json({ enabled: true });
  }

  // Reuse existing pending secret or generate a fresh one.
  let pending = await getPendingTotpSecret();
  if (!pending) {
    pending = generateTotpSecret();
    await prisma.systemConfig.upsert({
      where: { key: TOTP_PENDING_KEY },
      create: { key: TOTP_PENDING_KEY, value: pending },
      update: { value: pending },
    });
  }

  const uri = getTotpUri(pending);
  const qrDataUrl = await generateQrDataUrl(uri);
  return NextResponse.json({ enabled: false, setupUri: uri, qrDataUrl, secret: pending });
}

/** POST /api/admin/totp { code } — confirm TOTP setup with a valid code. */
export async function POST(request: Request) {
  const pending = await getPendingTotpSecret();
  if (!pending) {
    return NextResponse.json({ error: "No pending TOTP secret — reload the setup page" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { code } = body as { code?: string };
  if (!code) {
    return NextResponse.json({ error: "Code is required" }, { status: 400 });
  }

  if (!verifyTotpCode(pending, code.replace(/\s/g, ""))) {
    return NextResponse.json({ error: "Invalid or expired code — try again" }, { status: 401 });
  }

  await prisma.$transaction(async (tx) => {
    await tx.systemConfig.upsert({
      where: { key: TOTP_SECRET_KEY },
      create: { key: TOTP_SECRET_KEY, value: pending },
      update: { value: pending },
    });
    await tx.systemConfig.deleteMany({ where: { key: TOTP_PENDING_KEY } });
  });

  return NextResponse.json({ ok: true });
}

/** DELETE /api/admin/totp — disable TOTP (removes active and pending secrets). */
export async function DELETE() {
  await prisma.systemConfig.deleteMany({
    where: { key: { in: [TOTP_SECRET_KEY, TOTP_PENDING_KEY] } },
  });
  return NextResponse.json({ ok: true });
}
