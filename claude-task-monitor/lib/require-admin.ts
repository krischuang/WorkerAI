/**
 * Server-side admin session guard for API route handlers.
 *
 * Usage in a route handler:
 *   const denied = await requireAdmin(request);
 *   if (denied) return denied;
 */

import type { NextRequest } from "next/server";
import { adminCookieToken, ADMIN_COOKIE } from "@/middleware";
import { getAdminNonce } from "@/lib/admin-nonce-cache";
import { timingSafeCompare } from "@/lib/timing-safe";

/**
 * Validates the admin session cookie on an incoming request.
 * Returns a 401/503 Response when access should be denied, null when access is granted.
 */
export async function requireAdmin(request: NextRequest): Promise<Response | null> {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return new Response(
      JSON.stringify({ error: "Admin access unavailable: server configuration error" }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  }

  const nonce = getAdminNonce();
  const expected = await adminCookieToken(adminPassword, nonce);
  const presented = request.cookies.get(ADMIN_COOKIE)?.value ?? "";

  if (!timingSafeCompare(presented, expected)) {
    return new Response(
      JSON.stringify({ error: "Admin authentication required" }),
      { status: 401, headers: { "content-type": "application/json" } },
    );
  }

  return null;
}
