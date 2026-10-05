import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { PLAN_CORE_SELECT, findPlansSafe, isSchemaGapError } from "@/lib/plan-safe";
import { logPlatformAction } from "@/lib/platform";

/** GET /api/owner/plans — all plans (active + inactive) with subscriber counts. */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;

  // Schema-resilient: plan rows come from the safe helper (tagline/badge
  // degrade to "" on pre-v2.3.0 databases); subscriber counts in one light
  // query over the unchanged Subscription table.
  const [plans, subs] = await Promise.all([
    findPlansSafe(),
    db.subscription.findMany({
      select: { planId: true, status: true, property: { select: { deletedAt: true } } },
    }),
  ]);
  const countByPlan = new Map<string, number>();
  for (const s of subs) {
    if (!["active", "trial", "overdue"].includes(s.status) || s.property?.deletedAt) continue;
    countByPlan.set(s.planId, (countByPlan.get(s.planId) ?? 0) + 1);
  }

  return NextResponse.json({
    plans: plans.map((p) => {
      let features: Record<string, unknown> = {};
      try { features = JSON.parse(p.features); } catch { /* keep {} */ }
      return {
        id: p.id, code: p.code, name: p.name, description: p.description,
        tagline: p.tagline, badge: p.badge,
        monthlyPrice: p.monthlyPrice, features, sortOrder: p.sortOrder, active: p.active,
        subscribers: countByPlan.get(p.id) ?? 0,
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

  const exists = await db.plan.findUnique({ where: { code }, select: { id: true } });
  if (exists) return NextResponse.json({ error: `Plan code "${code}" already exists` }, { status: 409 });

  const baseData = {
    code,
    name,
    description: String(body.description ?? "").slice(0, 500),
    monthlyPrice: Math.max(0, Number(body.monthlyPrice ?? 0)),
    features: JSON.stringify(body.features ?? {}),
    sortOrder: Number(body.sortOrder ?? 99),
    active: body.active !== false,
  };
  // tagline/badge need the v2.3.0 schema — retry with core columns only on
  // older databases (explicit select keeps the read-back safe too).
  let plan;
  try {
    plan = await db.plan.create({
      data: {
        ...baseData,
        tagline: String(body.tagline ?? "").slice(0, 160),
        badge: String(body.badge ?? "").slice(0, 30),
      },
    });
  } catch (err) {
    if (!isSchemaGapError(err)) throw err;
    plan = await db.plan.create({ data: baseData, select: PLAN_CORE_SELECT });
  }

  await clearEntitlementsCache();

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "PLAN_CREATED",
    entity: "plan", entityId: plan.id, details: `Plan ${name} (₹${plan.monthlyPrice}/mo) created`,
  });

  return NextResponse.json({ ok: true, id: plan.id }, { status: 201 });
}
