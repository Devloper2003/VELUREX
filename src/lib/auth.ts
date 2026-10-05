import { SignJWT, jwtVerify } from "jose";
import { NextResponse } from "next/server";
import "@/lib/env"; // canonical .env — AUTH_SECRET must come from the file, not stale shell exports
import { PLATFORM_ROLES, TEAM_INVITABLE_ROLES } from "@/lib/owner-roles";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "velurex-dev-secret-change-me-in-production"
);

export type Role =
  | "hotel_admin" | "front_desk" | "housekeeping" | "restaurant_staff"
  // Platform console roles (Software Owner = super-admin; the rest are Team & Roles members)
  | "software_owner" | "platform_admin" | "platform_support" | "platform_finance";

export interface Session {
  sub: string;
  role: Role;
  name: string;
  email: string;
  propertyId: string;
  /** Platform-user only: demo owner accounts see seed/demo data in the console. */
  isDemo?: boolean;
  /** Set when a software owner is impersonating a tenant user (audited). */
  impersonatedBy?: string;
  /** True while the account still runs on a temporary password — the UI must
   *  force the permanent-password reset screen before anything else. */
  mustChangePassword?: boolean;
  /** Token issued-at (unix seconds) — used for force-logout staleness checks. */
  iat?: number;
}

export const ROLE_LABELS: Record<Role, string> = {
  hotel_admin: "Hotel Admin",
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  restaurant_staff: "Restaurant Staff",
  software_owner: "Software Owner",
  platform_admin: "Platform Admin",
  platform_support: "Platform Support",
  platform_finance: "Platform Finance",
};

export async function signToken(session: Session): Promise<string> {
  return new SignJWT({ ...session })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

/**
 * Short-lived (5 min) token that only proves "password step passed, waiting
 * for the 2FA code". It can NEVER be used as a session token — verifyToken
 * rejects anything carrying purpose:"mfa".
 */
export async function signMfaToken(sub: string): Promise<string> {
  return new SignJWT({ sub, purpose: "mfa" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (!payload.sub || !payload.role) return null;
    if (payload.purpose === "mfa") return null; // mfa tokens are not sessions
    return {
      sub: payload.sub as string,
      role: payload.role as Role,
      name: payload.name as string,
      email: payload.email as string,
      propertyId: payload.propertyId as string,
      isDemo: payload.isDemo === true,
      impersonatedBy: payload.impersonatedBy as string | undefined,
      mustChangePassword: payload.mustChangePassword === true,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
    };
  } catch {
    return null;
  }
}

/** Verify a purpose:"mfa" token — returns the subject (user id) or null. */
export async function verifyMfaToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.purpose !== "mfa" || !payload.sub) return null;
    return payload.sub as string;
  } catch {
    return null;
  }
}

/* ── httpOnly session cookie ───────────────────────────────────────────────
 * The JWT is delivered as an HttpOnly + SameSite=Lax cookie so it is NOT
 * reachable from JavaScript (an XSS bug can no longer exfiltrate the session).
 * Bearer tokens remain accepted for API clients / in-memory SPA usage — the
 * client store no longer persists the token to localStorage.
 */
export const SESSION_COOKIE = "velurex_session";
export const SESSION_COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days — matches the JWT TTL

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.get("cookie");
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function getTokenFromRequest(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return parseCookies(req)[SESSION_COOKIE] ?? null;
}

/** Set the session cookie on a NextResponse (secure when served over TLS). */
export function setSessionCookie(res: NextResponse, token: string, req?: Request): void {
  const https =
    req?.headers.get("x-forwarded-proto") === "https" ||
    new URL(req?.url ?? "http://local").protocol === "https:";
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: https,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE,
  });
}

/** Expire the session cookie (logout). */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: 0,
  });
}

/**
 * CSRF defense for the cookie transport.
 *
 * Primary signal: the browser-asserted `Sec-Fetch-Site` header (Fetch Metadata).
 * The BROWSER computes it from the page that initiated the request — proxies
 * can't rewrite it away from the truth and page JavaScript is forbidden from
 * setting it. `same-origin`/`same-site` are our own frontend by definition;
 * `cross-site` is a forged request. This works identically whether the app is
 * served from localhost, a LAN IP or behind the multi-hop preview gateway
 * (where the browser's Origin host is the public domain but the Host header
 * reaching Node is internal — the naive Origin↔Host compare false-positives
 * there).
 *
 * Legacy fallback (browsers without Fetch Metadata): Origin is compared
 * against every host the proxy chain presented — X-Forwarded-Host (list) and
 * Host — hostname-level, port-insensitive, so gateway port rewrites don't
 * break legitimate users.
 *
 * Non-browser clients (curl, server-to-server) send neither header and pass
 * through — they cannot be CSRF-forged by a browser anyway, and every
 * authenticated route still requires a valid Bearer/cookie session.
 */
export function csrfGuard(req: Request): NextResponse | null {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return null;

  const secFetchSite = req.headers.get("sec-fetch-site")?.toLowerCase();

  // 1) Authoritative browser signal.
  if (secFetchSite === "same-origin" || secFetchSite === "same-site") return null;
  if (secFetchSite === "cross-site" || secFetchSite === "none") return rejectCsrf(req);

  // 2) No Fetch Metadata → non-browser client unless an Origin was sent.
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return null;

  // 3) Legacy browser: port-insensitive Origin↔Host comparison.
  const originHost = hostOf(origin);
  if (originHost) {
    const candidates = new Set<string>();
    for (const raw of [req.headers.get("x-forwarded-host"), req.headers.get("host")]) {
      if (!raw) continue;
      for (const part of raw.split(",")) {
        const clean = part.trim().toLowerCase();
        if (!clean) continue;
        candidates.add(clean);
        const noPort = hostOf(clean);
        if (noPort) candidates.add(noPort);
      }
    }
    if (candidates.has(originHost)) return null;
  }
  return rejectCsrf(req);
}

/** hostname[:port] → hostname (lowercased). */
function hostOf(h: string): string | null {
  try {
    const host = new URL(h.includes("://") ? h : `//${h}`, "http://x").host;
    const name = host.split(":")[0].trim().toLowerCase();
    return name || null;
  } catch {
    return null;
  }
}

/** Log the rejection details (proxy-chain diagnosis) and answer 403. */
function rejectCsrf(req: Request): NextResponse {
  console.warn(
    `[csrf] blocked ${req.method} ${new URL(req.url).pathname} — ` +
      `origin=${req.headers.get("origin") ?? "-"} sec-fetch-site=${req.headers.get("sec-fetch-site") ?? "-"} ` +
      `host=${req.headers.get("host") ?? "-"} x-forwarded-host=${req.headers.get("x-forwarded-host") ?? "-"}`
  );
  return NextResponse.json({ error: "Cross-origin request blocked" }, { status: 403 });
}

/** Returns the session for a request, or null. */
export async function getAuth(req: Request): Promise<Session | null> {
  const token = getTokenFromRequest(req);
  if (!token) return null;
  return verifyToken(token);
}

/** Role-guard helper. Returns NextResponse error or null when authorized. */
export async function requireAuth(
  req: Request,
  roles?: Role[]
): Promise<{ session: Session } | { error: NextResponse }> {
  const csrf = csrfGuard(req);
  if (csrf) return { error: csrf };
  const session = await getAuth(req);
  if (!session) {
    return { error: NextResponse.json({ error: "Unauthorized — please sign in" }, { status: 401 }) };
  }
  if (roles && roles.length > 0 && !roles.includes(session.role)) {
    return { error: NextResponse.json({ error: "Forbidden — insufficient permissions" }, { status: 403 }) };
  }
  return { session };
}

/**
 * Owner-route guard with centralized capability enforcement.
 *
 * `software_owner` (Sujeet Sharma) keeps unrestricted access — behavior of
 * every existing route is unchanged. Team & Roles members (platform_admin /
 * platform_support / platform_finance) get the platform console too, but the
 * matrix below decides what they may WRITE; everything else is read-only.
 * Denied writes return 403 — UI hiding alone is never the enforcement.
 */
export async function requireOwner(req: Request): Promise<{ session: Session } | { error: NextResponse }> {
  const auth = await requireAuth(req, [...PLATFORM_ROLES] as Role[]);
  if ("error" in auth) return auth;
  const { role } = auth.session;
  if (role === "software_owner") return auth;

  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const method = (req.method ?? "GET").toUpperCase();
  const seg = path.replace("/api/owner/", "").split("/")[0] ?? "";

  // Owner-only modules (any method — team roster, platform API keys, demo
  // visibility, impersonation and the owner's own WhatsApp fallback).
  if (["team", "settings", "demo-state", "impersonate", "whatsapp"].includes(seg)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden — this module requires the Software Owner role", code: "ROLE_FORBIDDEN" },
        { status: 403 }
      ),
    };
  }

  if (method === "GET" || method === "HEAD") return auth; // all platform roles can read everything else

  const writable =
    role === "platform_admin"
      ? ["businesses", "users", "onboarding", "subscriptions", "plans", "addons", "billing", "coupons", "payment-gateways", "tickets", "announcements", "integrations", "health", "cron"]
      : role === "platform_support"
        ? ["tickets", "announcements"]
        : ["subscriptions", "plans", "addons", "billing", "coupons", "payment-gateways"]; // platform_finance

  if (!writable.includes(seg)) {
    return {
      error: NextResponse.json(
        { error: "Forbidden — this action requires the Software Owner role", code: "ROLE_FORBIDDEN" },
        { status: 403 }
      ),
    };
  }
  return auth;
}

/** Roles that may be invited via Team & Roles (never software_owner). */
export const INVITABLE_PLATFORM_ROLES = TEAM_INVITABLE_ROLES;

/** Client/server-safe platform-role predicate (re-exported for auth consumers). */
export { isPlatformRole } from "@/lib/owner-roles";
