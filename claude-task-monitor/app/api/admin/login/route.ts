import { NextResponse, type NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { checkAdminLogin } from "@/lib/admin-auth";
import {
  adminCookieToken, ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE,
  adminOtpPendingToken, ADMIN_OTP_PENDING_COOKIE, ADMIN_OTP_PENDING_MAX_AGE,
} from "@/middleware";
import { getActiveTotpSecret } from "@/lib/admin-totp";

/** POST /api/admin/login — verify admin password and set httpOnly session cookie. */
export async function POST(request: NextRequest) {
  // Brute-force protection: 10 attempts per 15 minutes.
  const rl = apiRateLimit("admin-login", 10, 15 * 60 * 1000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return NextResponse.json(
      { error: "ADMIN_PASSWORD is not configured on the server" },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body as { password?: string };

  if (!password) {
    return NextResponse.json({ error: "Password is required" }, { status: 400 });
  }

  const valid = await checkAdminLogin(password);
  if (!valid) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // If TOTP is configured, issue a short-lived pending cookie and require OTP step.
  const totpSecret = await getActiveTotpSecret();
  if (totpSecret) {
    const pendingToken = await adminOtpPendingToken(adminPassword);
    const res = NextResponse.json({ requiresOtp: true });
    res.cookies.set(ADMIN_OTP_PENDING_COOKIE, pendingToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: ADMIN_OTP_PENDING_MAX_AGE,
      path: "/",
    });
    return res;
  }

  const token = await adminCookieToken(adminPassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: ADMIN_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
