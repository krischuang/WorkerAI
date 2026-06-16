import { NextResponse, type NextRequest } from "next/server";
import { isLocalOrigin } from "@/lib/exec-guards";
import { apiRateLimit, rateLimitResponse, extractRequestIp } from "@/lib/api-rate-limit";

// ─── General auth ─────────────────────────────────────────────────────────────

export const AUTH_COOKIE = "__auth";

/** sha256 hash of the secret stored as the cookie value, so the raw secret never leaves the server. */
export async function cookieToken(secret: string): Promise<string> {
  const data = new TextEncoder().encode(`auth:${secret}`);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Admin auth (edge-compatible) ─────────────────────────────────────────────

export const ADMIN_COOKIE = "__admin";
export const ADMIN_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days

export const ADMIN_OTP_PENDING_COOKIE = "__admin_otp_pending";
export const ADMIN_OTP_PENDING_MAX_AGE = 10 * 60; // 10 minutes

/**
 * HMAC-SHA256 token derived from the admin password.
 * Used as the httpOnly admin session cookie value.
 * Edge-compatible — no bcrypt involved.
 */
export async function adminCookieToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("admin-session:v1"),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Short-lived HMAC token set after password verification when TOTP is required.
 * Valid for ADMIN_OTP_PENDING_MAX_AGE seconds only.
 */
export async function adminOtpPendingToken(password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode("admin-otp-pending:v1"),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

function isPublicPath(pathname: string): boolean {
  // /api/metrics authenticates via its own Bearer token — no session cookie needed.
  return pathname === "/login" || pathname.startsWith("/api/auth") || pathname === "/api/metrics";
}

/** Admin paths that bypass the admin auth check (login/logout/otp endpoints). */
function isAdminPublicPath(pathname: string): boolean {
  return (
    pathname === "/admin/login" ||
    pathname === "/admin/verify-otp" ||
    pathname === "/api/admin/login" ||
    pathname === "/api/admin/logout" ||
    pathname === "/api/admin/verify-otp"
  );
}

function isAdminPath(pathname: string): boolean {
  return pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
}

const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// ─── Middleware ────────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets and Next.js internals — always pass through.
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/public/")
  ) {
    return NextResponse.next();
  }

  // CSRF: reject mutating requests whose Origin header points to a non-localhost
  // source. Runs before auth so cross-origin probes cannot distinguish
  // authenticated from unauthenticated state.
  if (MUTATING_METHODS.has(request.method)) {
    const origin = request.headers.get("origin");
    if (!isLocalOrigin(origin)) {
      return new NextResponse(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
  }

  // ── Global rate limiting for all API routes ────────────────────────────────
  // Applied after CSRF (so cross-origin probes are blocked first) and before
  // auth (so we don't burn crypto on throttled requests).
  // Read endpoints: 60 req / min.  Write endpoints: 10 req / min.
  if (pathname.startsWith("/api/")) {
    const ip = extractRequestIp(request);
    const isWrite = MUTATING_METHODS.has(request.method);
    const [rlKey, rlMax] = isWrite
      ? [`global:write:${ip}`, 10]
      : [`global:read:${ip}`, 60];
    const rl = apiRateLimit(rlKey, rlMax, 60_000);
    if (rl.limited) return rateLimitResponse(rl.retryAfterSec);
  }

  // ── Admin paths have their own independent auth flow ───────────────────────

  if (isAdminPath(pathname)) {
    // Login / logout endpoints are always accessible.
    if (isAdminPublicPath(pathname)) return NextResponse.next();

    const adminPassword = process.env.ADMIN_PASSWORD;
    if (!adminPassword) {
      console.warn("[admin-auth] ADMIN_PASSWORD is not set — admin routes are unprotected");
      return NextResponse.next();
    }

    const expected = await adminCookieToken(adminPassword);
    const adminCookie = request.cookies.get(ADMIN_COOKIE)?.value;

    if (adminCookie === expected) return NextResponse.next();

    // API routes → 401 JSON.
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "Admin authentication required" }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    // Page routes → redirect to /admin/login.
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/admin/login";
    loginUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(loginUrl);
  }

  // ── Non-admin paths use the general AUTH_SECRET check ─────────────────────

  // Login page and auth endpoint — no cookie required.
  if (isPublicPath(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;

  // If AUTH_SECRET is not configured, warn and allow through so the app
  // stays usable before first-time setup. All requests are local anyway.
  if (!secret) {
    console.warn("[auth] AUTH_SECRET is not set — all requests are unauthenticated");
    return NextResponse.next();
  }

  const expected = await cookieToken(secret);
  const cookie = request.cookies.get(AUTH_COOKIE)?.value;

  if (cookie === expected) return NextResponse.next();

  // API routes → 401 JSON (not a redirect, so fetch() callers get a proper error).
  if (pathname.startsWith("/api/")) {
    return new NextResponse(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Page routes → redirect to /login, preserving the intended destination.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.searchParams.set("redirect", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
