import { NextResponse, type NextRequest } from "next/server";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";
import { checkAdminLogin } from "@/lib/admin-auth";
import { adminCookieToken, ADMIN_COOKIE, ADMIN_COOKIE_MAX_AGE } from "@/middleware";

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

  const token = await adminCookieToken(adminPassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    secure: false, // app runs over plain HTTP on localhost
    sameSite: "strict",
    maxAge: ADMIN_COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}
