import { NextResponse, type NextRequest } from "next/server";
import { createHash } from "crypto";

export const AUTH_COOKIE = "__auth";

/** sha256 hash of the secret stored as the cookie value, so the raw secret never leaves the server. */
export function cookieToken(secret: string): string {
  return createHash("sha256").update(`auth:${secret}`).digest("hex");
}

function isPublicPath(pathname: string): boolean {
  return pathname === "/login" || pathname.startsWith("/api/auth");
}

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Static assets and Next.js internals — always pass through.
  if (
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/public/")
  ) {
    return NextResponse.next();
  }

  // Login page and auth endpoint — no cookie required.
  if (isPublicPath(pathname)) return NextResponse.next();

  const secret = process.env.AUTH_SECRET;

  // If AUTH_SECRET is not configured, warn and allow through so the app
  // stays usable before first-time setup. All requests are local anyway.
  if (!secret) {
    console.warn("[auth] AUTH_SECRET is not set — all requests are unauthenticated");
    return NextResponse.next();
  }

  const expected = cookieToken(secret);
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
