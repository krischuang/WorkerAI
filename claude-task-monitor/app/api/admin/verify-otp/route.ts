import { NextResponse, type NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse, getAdminOtpBucket } from "@/lib/api-rate-limit";
import { getActiveTotpSecret, verifyTotpCode } from "@/lib/admin-totp";
import {
  adminCookieToken, ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE,
  adminOtpPendingToken, ADMIN_OTP_PENDING_COOKIE,
} from "@/middleware";
import { getCurrentNonce } from "@/lib/admin-session-nonce";
import { timingSafeCompare } from "@/lib/timing-safe";
import { prisma } from "@/lib/prisma";

/** Persist OTP rate-limit bucket to SystemConfig for crash resilience. */
function persistAdminOtpBucket(): void {
  const bucket = getAdminOtpBucket();
  prisma.systemConfig.upsert({
    where: { key: "rl_bucket_admin-otp" },
    create: { key: "rl_bucket_admin-otp", value: JSON.stringify(bucket) },
    update: { value: JSON.stringify(bucket) },
  }).catch(() => { /* non-fatal */ });
}

/** POST /api/admin/verify-otp — validate TOTP code after password step. */
export async function POST(request: NextRequest) {
  const rl = apiRateLimit("admin-otp", 10, 5 * 60 * 1000);
  if (!rl.limited) persistAdminOtpBucket();
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json({ error: "ADMIN_PASSWORD is not configured" }, { status: 500 });
  }

  // Verify the short-lived pending cookie to ensure password was verified first.
  const expectedPending = await adminOtpPendingToken(adminPassword);
  const pendingCookie = request.cookies.get(ADMIN_OTP_PENDING_COOKIE)?.value ?? "";
  if (!timingSafeCompare(pendingCookie, expectedPending)) {
    return NextResponse.json({ error: "Password step not completed" }, { status: 401 });
  }

  const totpSecret = await getActiveTotpSecret();
  if (!totpSecret) {
    // TOTP was disabled between login and OTP step — complete login normally.
    const nonce = await getCurrentNonce();
    const token = await adminCookieToken(adminPassword, nonce);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(ADMIN_COOKIE, token, {
      httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
      maxAge: ADMIN_COOKIE_MAX_AGE, path: "/",
    });
    res.cookies.delete(ADMIN_OTP_PENDING_COOKIE);
    return res;
  }

  const body = await request.json().catch(() => ({}));
  const { code } = body as { code?: string };
  if (!code) {
    return NextResponse.json({ error: "OTP code is required" }, { status: 400 });
  }

  if (!verifyTotpCode(totpSecret, code.replace(/\s/g, ""))) {
    return NextResponse.json({ error: "Invalid or expired code" }, { status: 401 });
  }

  const nonce = await getCurrentNonce();
  const token = await adminCookieToken(adminPassword, nonce);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict",
    maxAge: ADMIN_COOKIE_MAX_AGE, path: "/",
  });
  res.cookies.delete(ADMIN_OTP_PENDING_COOKIE);
  return res;
}
