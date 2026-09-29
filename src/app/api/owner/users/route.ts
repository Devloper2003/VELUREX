import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/users — every staff user across all businesses
 * (name, business, role, last login, status) with search/filter/pagination.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const search = sp.get("search")?.trim() ?? "";
  const role = sp.get("role") ?? "";
  const status = sp.get("status") ?? "";
  const businessId = sp.get("businessId") ?? "";
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get("pageSize") ?? "12", 10) || 12));

  const where: Record<string, unknown> = { ...notDemoTenant(scope) };
  if (search) {
    where.OR = [{ name: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }];
  }
  if (role) where.role = role;
  if (status === "active") where.active = true;
  if (status === "inactive") where.active = false;
  if (businessId) where.propertyId = { equals: businessId, notIn: scope.demoIds };

  const [total, users] = await Promise.all([
    db.staff.count({ where }),
    db.staff.findMany({
      where,
      include: { property: { select: { id: true, name: true, city: true, subscriptionStatus: true } } },
      orderBy: [{ lastLoginAt: { sort: "desc", nulls: "last" } }, { createdAt: "asc" }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const loginEvents = await db.activityLog.findMany({
    where: { action: "LOGIN" },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  const lastLogins = new Map<string, Date>();
  for (const ev of loginEvents) {
    if (!lastLogins.has(ev.staffId)) lastLogins.set(ev.staffId, ev.createdAt);
  }

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      phone: u.phone,
      role: u.role,
      active: u.active,
      mustChangePassword: u.mustChangePassword,
      lastLoginAt: u.lastLoginAt,
      recentLogin: lastLogins.get(u.id) ?? null,
      property: u.property,
      createdAt: u.createdAt,
    })),
    total, page, pageSize, pages: Math.ceil(total / pageSize),
  });
}
