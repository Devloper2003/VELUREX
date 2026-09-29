import "@/lib/env";

/**
 * In-memory rate limiter (fixed-window) + login lockout.
 *
 * Design:
 * - Buckets live in a module-level Map keyed by an arbitrary string
 *   ("login:ip:1.2.3.4", "login:fail:user@x", "2fa:challenge:<sub>" ...).
 * - Fixed window: a bucket counts hits from firstHitUntil resetAt; when now
 *   passes resetAt the bucket restarts. Cheap, allocation-light, no deps.
 * - Expired buckets are pruned lazily on access + opportunistically on a
 *   60s sweep so the map can't grow unbounded under scanner traffic.
 *
 * Scope: per server instance. The app runs as a single Next.js node, so this
 * is authoritative. If the deployment ever scales horizontally, swap the Map
 * for a shared store (Redis / Postgres) behind the same function signatures.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

function sweep(now: number) {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

export interface RateResult {
  /** true = request allowed (consumed one hit). */
  allowed: boolean;
  /** Seconds until the window resets (present when blocked). */
  retryAfterSec?: number;
  /** Hits remaining in the current window. */
  remaining: number;
}

/** Consume one hit from `key`'s window (max `limit` per `windowMs`). */
export function rateLimit(key: string, limit: number, windowMs: number): RateResult {
  const now = Date.now();
  sweep(now);
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }
  if (bucket.count >= limit) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)), remaining: 0 };
  }
  bucket.count += 1;
  return { allowed: true, remaining: limit - bucket.count };
}

/* ── Login brute-force protection ─────────────────────────────────────────
 * Two walls:
 *  1. IP wall   — N requests per window per IP (stops credential stuffing loops)
 *  2. Lockout   — M failed attempts for one email → the email is locked for a
 *                 cool-down even if the attacker rotates IPs.
 * Successful sign-in clears the email failure counter.
 */

export const LOGIN_IP_LIMIT = 20; // attempts / 5 min / IP
export const LOGIN_IP_WINDOW_MS = 5 * 60_000;
export const LOGIN_FAILS_ALLOWED = 5; // failures before email lockout
export const LOGIN_FAIL_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCKOUT_MS = 15 * 60_000;

/** Best-effort client IP behind the Caddy gateway. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "local";
}

/** Wall 1 — per-IP request budget. */
export function limitLoginIp(req: Request): RateResult {
  return rateLimit(`login:ip:${clientIp(req)}`, LOGIN_IP_LIMIT, LOGIN_IP_WINDOW_MS);
}

/** Wall 2 — check whether an email is currently locked out. */
export function isLockedOut(email: string): RateResult {
  const now = Date.now();
  const b = buckets.get(`login:lock:${email}`);
  if (b && b.resetAt > now) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)), remaining: 0 };
  }
  return { allowed: true, remaining: LOGIN_FAILS_ALLOWED };
}

/** Record a failed attempt for the email; locks it once failures exceed the budget. */
export function recordLoginFailure(email: string): void {
  const now = Date.now();
  const key = `login:fail:${email}`;
  const b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + LOGIN_FAIL_WINDOW_MS });
    return;
  }
  b.count += 1;
  if (b.count >= LOGIN_FAILS_ALLOWED) {
    // move the budget bucket into a lockout bucket
    buckets.set(`login:lock:${email}`, { count: 0, resetAt: now + LOGIN_LOCKOUT_MS });
    buckets.delete(key);
  }
}

export function clearLoginFailures(email: string): void {
  buckets.delete(`login:fail:${email}`);
  buckets.delete(`login:lock:${email}`);
}

// buckets reset on recompile (QA run)
// recompile marker
// recompile marker 2
// recompile marker 3
