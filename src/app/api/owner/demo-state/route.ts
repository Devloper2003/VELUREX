import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope } from "@/lib/owner-demo";

/**
 * GET /api/owner/demo-state — powers the "Demo data" toggle in the owner topbar.
 * hasDemoData → seed/demo tenants exist (toggle worth showing)
 * showing     → demo rows are currently included in console data
 * canToggle   → false for the demo owner account (it always sees demo data)
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const scope = await demoScope(auth.session, req);
  const hasDemoData = await db.property.count({ where: { isDemo: true, deletedAt: null } });

  return NextResponse.json({
    hasDemoData: hasDemoData > 0,
    showing: scope.includeDemo,
    canToggle: auth.session.isDemo !== true,
  });
}
