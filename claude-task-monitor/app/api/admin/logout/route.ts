import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_COOKIE } from "@/middleware";
import { rotateNonce } from "@/lib/admin-session-nonce";
import { setAdminNonce } from "@/lib/admin-nonce-cache";
import { logAdminAction } from "@/lib/admin-audit-log";

/** POST /api/admin/logout — clear the admin session cookie and rotate the nonce. */
export async function POST(request: NextRequest) {
  // Rotate the session nonce so all existing admin cookies become invalid
  // immediately — even if an attacker captured a valid cookie before logout.
  const newNonce = await rotateNonce();
  setAdminNonce(newNonce);

  await logAdminAction(request, { action: "admin.logout" });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return res;
}
