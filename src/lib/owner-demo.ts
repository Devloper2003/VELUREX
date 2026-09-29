import type { NextRequest } from "next/server";
import type { Session } from "@/lib/auth";
import { db } from "@/lib/db";

/**
 * Demo-data scoping for the Software Owner console.
 *
 * The REAL owner (owner@velurexhms.in) must see a clean platform with zero
 * seed/demo businesses so real clients can be assigned. Everything flagged
 * `isDemo` is hidden for them — unless they flip the "Demo data" toggle in
 * the topbar (cookie `vx_show_demo=1` → proxy appends `includeDemo=1`).
 * The demo owner account (session.isDemo) always sees everything.
 */

export const DEMO_OWNER_EMAIL = "owner@velurex.in";

export interface DemoScope {
  /** true → demo owner session, or the real owner explicitly showing demo data */
  includeDemo: boolean;
  /** ids of isDemo tenants — empty when includeDemo (no exclusions) */
  demoIds: string[];
}

export async function demoScope(session: Session, req: NextRequest): Promise<DemoScope> {
  const includeDemo =
    session.isDemo === true ||
    req.nextUrl.searchParams.get("includeDemo") === "1" ||
    req.cookies.get("vx_show_demo")?.value === "1";
  if (includeDemo) return { includeDemo, demoIds: [] };
  const rows = await db.property.findMany({ where: { isDemo: true }, select: { id: true } });
  return { includeDemo: false, demoIds: rows.map((r) => r.id) };
}

/**
 * Filter for tenant-scoped tables (invoice, subscription, staff, ticket,
 * payment, channel*, usageMetric, onboardingChecklist…). Spread into a where
 * clause. `notIn: []` matches everything, so it is safe unconditionally.
 */
export function notDemoTenant(s: DemoScope) {
  return { propertyId: { notIn: s.demoIds } };
}

/** Filter for tenant tables queried by their own id column (property itself). */
export function notDemoTenantId(s: DemoScope) {
  return { id: { notIn: s.demoIds } };
}

/** Filter for platform-level tables carrying their own isDemo flag. */
export function notDemoPlatform(s: DemoScope) {
  return s.includeDemo ? {} : { isDemo: false };
}

/**
 * Filter for the platform audit trail: hide rows tied to demo tenants and
 * rows authored by the demo owner account. System rows (actorName "system")
 * remain — they are real platform events.
 */
export function notDemoAudit(s: DemoScope) {
  return s.includeDemo
    ? {}
    : {
        AND: [{ propertyId: { notIn: s.demoIds } }, { actorName: { notIn: [DEMO_OWNER_EMAIL] } }],
      };
}
