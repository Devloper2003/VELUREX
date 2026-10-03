import { NextRequest, NextResponse } from "next/server";
import { verifyToken, csrfGuard, SESSION_COOKIE } from "@/lib/auth";

/**
 * Route-level access control (Next 16 `proxy` convention — replaces the
 * deprecated `middleware` file): every /api route requires a valid JWT except
 * the public allow-list below. Fine-grained role checks live inside handlers.
 *
 * Session transport: the JWT is accepted from the Authorization header OR the
 * HttpOnly `velurex_session` cookie (the SPA's persistent transport). The
 * cookie path makes every API call survive a page refresh without any token
 * in localStorage.
 */
const PUBLIC_PATHS = [
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/2fa/challenge", // second login factor — pre-session by design
  "/api/booking-engine/availability",
  "/api/booking-engine/book",
  "/api/booking-engine/hold",
  "/api/booking-engine/pay",
  "/api/booking-engine/holds/sweep",
  "/api/booking-engine/promo",
  "/api/booking-engine/payment-intent",
  "/api/booking-engine/config",
  "/api/whatsapp/webhook",
  "/api/channels/ical",   // outbound calendar feed — token-authenticated (OTA extranets pull it)
  "/api/channels/webhook", // inbound booking events — token-authenticated (OTAs push here)
  "/api/health",
];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // CSRF: state-changing requests on AUTHENTICATED paths must be same-origin
  // (checked before auth so forged requests are rejected outright).
  const csrf = csrfGuard(req);
  if (csrf) return csrf;

  const authHeader = req.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.slice(7)
    : req.cookies.get(SESSION_COOKIE)?.value ?? null;

  const session = token ? await verifyToken(token) : null;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized — invalid or missing token" }, { status: 401 });
  }

  const demoRes = withDemoToggle(req);
  if (demoRes) return demoRes;

  const res = NextResponse.next();
  res.headers.set("x-user-id", session.sub);
  res.headers.set("x-user-role", session.role);
  res.headers.set("x-property-id", session.propertyId);
  return res;
}

/**
 * Owner "Show demo data" toggle: when the real owner flips the topbar switch
 * the UI sets cookie `vx_show_demo=1`; the proxy then appends `includeDemo=1`
 * to every /api/owner request so all owner endpoints return demo rows too.
 * (The demo owner account sees demo data regardless — session.isDemo.)
 */
function withDemoToggle(req: NextRequest): NextResponse | null {
  if (!req.nextUrl.pathname.startsWith("/api/owner/")) return null;
  if (req.cookies.get("vx_show_demo")?.value !== "1") return null;
  const url = req.nextUrl.clone();
  url.searchParams.set("includeDemo", "1");
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: "/api/:path*",
};
