import { NextResponse } from "next/server";
import { ADMIN_COOKIE } from "@/middleware";

/** POST /api/admin/logout — clear the admin session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, "", {
    httpOnly: true,
    secure: false,
    sameSite: "strict",
    maxAge: 0,
    path: "/",
  });
  return res;
}
