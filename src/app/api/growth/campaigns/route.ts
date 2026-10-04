import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * /api/growth/campaigns — tenant marketing campaign management.
 *
 * GET  (hotel_admin) — campaigns (newest first) + summary aggregates.
 * POST (hotel_admin) — create a campaign. A linked promoCode must already
 *                      exist on the property (codes are managed in the
 *                      booking-engine promo module — no duplication here).
 */

const CHANNELS = ["whatsapp", "email", "promo", "social", "direct"] as const;
const AUDIENCES = ["all_guests", "repeat", "new", "vip", "lapsed"] as const;

const round2 = (n: number) => Math.round(n * 100) / 100;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse an optional date-ish body value → Date | null (invalid → undefined sentinel handled by caller). */
function parseOptionalDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined; // field absent — leave untouched
  if (v === null || v === "") return null; // explicit clear
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d; // undefined = invalid
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  try {
    const [campaigns, agg, byStatus] = await Promise.all([
      db.marketingCampaign.findMany({
        where: { propertyId: auth.session.propertyId },
        orderBy: { createdAt: "desc" },
      }),
      db.marketingCampaign.aggregate({
        where: { propertyId: auth.session.propertyId },
        _sum: { budget: true, spent: true, revenue: true },
        _count: { _all: true },
      }),
      db.marketingCampaign.groupBy({
        by: ["status"],
        where: { propertyId: auth.session.propertyId },
        _count: { _all: true },
      }),
    ]);

    const totalBudget = round2(agg._sum.budget ?? 0);
    const totalSpent = round2(agg._sum.spent ?? 0);
    const attributedRevenue = round2(agg._sum.revenue ?? 0);

    return NextResponse.json({
      campaigns,
      summary: {
        total: agg._count?._all ?? 0,
        byStatus: {
          draft: byStatus.find((s) => s.status === "draft")?._count._all ?? 0,
          active: byStatus.find((s) => s.status === "active")?._count._all ?? 0,
          paused: byStatus.find((s) => s.status === "paused")?._count._all ?? 0,
          completed: byStatus.find((s) => s.status === "completed")?._count._all ?? 0,
        },
        totalBudget,
        totalSpent,
        attributedRevenue,
        avgRoiPct: totalSpent > 0 ? round1((attributedRevenue / totalSpent) * 100) : 0,
      },
    });
  } catch (e) {
    console.error("[growth/campaigns GET]", e);
    return NextResponse.json({ error: "Could not load campaigns" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const name = String(body.name ?? "").trim();
    if (name.length < 1 || name.length > 120) {
      return NextResponse.json({ error: "Name must be 1–120 characters" }, { status: 400 });
    }

    const channel = String(body.channel ?? "whatsapp");
    if (!(CHANNELS as readonly string[]).includes(channel)) {
      return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
    }

    const audience = String(body.audience ?? "all_guests");
    if (!(AUDIENCES as readonly string[]).includes(audience)) {
      return NextResponse.json({ error: "Invalid audience" }, { status: 400 });
    }

    const promoCode = String(body.promoCode ?? "").trim().toUpperCase();
    if (promoCode) {
      const promo = await db.promoCode.findFirst({ where: { propertyId, code: promoCode } });
      if (!promo) return NextResponse.json({ error: `Promo code ${promoCode} does not exist on this property` }, { status: 400 });
    }

    const budget = Number(body.budget ?? 0);
    if (!Number.isFinite(budget) || budget < 0) {
      return NextResponse.json({ error: "Budget must be a number ≥ 0" }, { status: 400 });
    }

    const startsAt = parseOptionalDate(body.startsAt);
    if (startsAt === undefined) return NextResponse.json({ error: "Invalid start date" }, { status: 400 });
    const endsAt = parseOptionalDate(body.endsAt);
    if (endsAt === undefined) return NextResponse.json({ error: "Invalid end date" }, { status: 400 });
    if (startsAt && endsAt && endsAt < startsAt) {
      return NextResponse.json({ error: "End date must be on or after the start date" }, { status: 400 });
    }

    const notes = String(body.notes ?? "").slice(0, 500);

    const campaign = await db.marketingCampaign.create({
      data: { propertyId, name, channel, audience, promoCode, budget, startsAt, endsAt, notes },
    });

    await logActivity({
      propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "growth.campaign_create",
      entity: "marketing_campaign",
      entityId: campaign.id,
      details: `Created campaign "${name}" (${channel} · ${audience}${promoCode ? ` · promo ${promoCode}` : ""})`,
    });

    return NextResponse.json({ campaign }, { status: 201 });
  } catch (e) {
    console.error("[growth/campaigns POST]", e);
    return NextResponse.json({ error: "Failed to create campaign" }, { status: 500 });
  }
}
