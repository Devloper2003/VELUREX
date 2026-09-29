import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction } from "@/lib/platform";

/** GET /api/owner/plans — all plans (active + inactive) with subscriber counts. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  const plans = await db.plan.findMany({
    orderBy: { sortOrder: "asc" },
    include: {
      subscriptions: { select: { status: true, property: { select: { deletedAt: true } } } },
    },
  });

  return NextResponse.json({
    plans: plans.map((p) => {
      let features: Record<string, unknown> = {};
      try { features = JSON.parse(p.features); } catch { /* keep {} */ }
      return {
        id: p.id, code: p.code, name: p.name, description: p.description,
        monthlyPrice: p.monthlyPrice, features, sortOrder: p.sortOrder, active: p.active,
        subscribers: p.subscriptions.filter(
          (s) => ["active", "trial", "overdue"].includes(s.status) && !s.property?.deletedAt
        ).length,
      };
    }),
  });
}

/** POST /api/owner/plans — create a plan. Body: { code, name, description, monthlyPrice, features, sortOrder }. */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const code = String(body.code ?? "").toLowerCase().trim();
  const name = String(body.name ?? "").trim();
  if (!code || !name) return NextResponse.json({ error: "code and name are required" }, { status: 400 });
  if (!/^[a-z0-9_-]+$/.test(code)) return NextResponse.json({ error: "code must be lowercase alphanumeric" }, { status: 400 });

  const exists = await db.plan.findUnique({ where: { code } });
  if (exists) return NextResponse.json({ error: `Plan code "${code}" already exists` }, { status: 409 });

  const plan = await db.plan.create({
    data: {
      code,
      name,
      description: String(body.description ?? ""),
      monthlyPrice: Math.max(0, Number(body.monthlyPrice ?? 0)),
      features: JSON.stringify(body.features ?? {}),
      sortOrder: Number(body.sortOrder ?? 99),
      active: body.active !== false,
    },
  });

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "PLAN_CREATED",
    entity: "plan", entityId: plan.id, details: `Plan ${name} (₹${plan.monthlyPrice}/mo) created`,
  });

  return NextResponse.json({ ok: true, id: plan.id }, { status: 201 });
}
