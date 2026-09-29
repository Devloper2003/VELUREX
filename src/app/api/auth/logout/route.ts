import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookie } from "@/lib/auth";

/**
 * POST /api/auth/logout — expires the HttpOnly session cookie server-side.
 * (The client also drops its in-memory token and user profile.)
 */
export async function POST(_req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookie(res);
  return res;
}
