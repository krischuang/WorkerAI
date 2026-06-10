import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, cookieToken } from "@/middleware";
import { apiRateLimit, rateLimitResponse } from "@/lib/api-rate-limit";

const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

/** POST /api/auth — validate password, set session cookie. */
export async function POST(request: NextRequest) {
  // Brute-force protection: 10 attempts per 15 minutes, globally (single-user app).
  const rl = apiRateLimit("auth", 10, 15 * 60 * 1000);
  if (rl.limited) return rateLimitResponse(rl.retryAfterSec);

  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "AUTH_SECRET not configured on the server" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  const { password } = body as { password?: string };

  if (!password || password !== secret) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await cookieToken(secret), {
    httpOnly: true,
    secure: false,   // app runs over plain HTTP on localhost
    sameSite: "strict",
    maxAge: COOKIE_MAX_AGE,
    path: "/",
  });
  return res;
}

/** DELETE /api/auth — clear the session cookie (logout). */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(AUTH_COOKIE);
  return res;
}
