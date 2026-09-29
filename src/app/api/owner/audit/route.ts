import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoAudit } from "@/lib/owner-demo";

/** GET /api/owner/audit — platform audit trail with filters. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const action = sp.get("action") ?? "";
  const search = sp.get("search")?.trim() ?? "";
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(10, parseInt(sp.get("pageSize") ?? "25", 10) || 25));

  const where: Record<string, unknown> = { ...notDemoAudit(scope) };
  if (action) where.action = action;
  if (search) {
    where.OR = [
      { actorName: { contains: search, mode: "insensitive" } },
      { details: { contains: search, mode: "insensitive" } },
      { entity: { contains: search, mode: "insensitive" } },
    ];
  }

  const [total, logs] = await Promise.all([
    db.platformAuditLog.count({ where }),
    db.platformAuditLog.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const actions = await db.platformAuditLog.groupBy({ by: ["action"], where: notDemoAudit(scope), _count: true });

  return NextResponse.json({
    logs, total, page, pageSize, pages: Math.ceil(total / pageSize),
    actions: actions.map((a) => ({ action: a.action, count: a._count })).sort((a, b) => b.count - a.count),
  });
}
