import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * /api/growth/campaigns/[id] — edit / transition / result-track / delete a
 * single marketing campaign owned by the session property.
 *
 * PATCH  (hotel_admin) — creation fields, status (draft|active|paused|completed)
 *                        and result counters {reach, conversions, revenue, spent}.
 * DELETE (hotel_admin) — remove the campaign.
 */

const CHANNELS = ["whatsapp", "email", "promo", "social", "direct"] as const;
const AUDIENCES = ["all_guests", "repeat", "new", "vip", "lapsed"] as const;
const STATUSES = ["draft", "active", "paused", "completed"] as const;

type Ctx = { params: Promise<{ id: string }> };

/** Optional date body value: undefined = untouched, null/"" = clear, else parsed. */
function parseOptionalDate(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Non-negative number field: undefined = untouched, else validated value. */
function parseNonNegative(v: unknown, int = false): number | undefined | null {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null; // null sentinel = invalid
  return int ? Math.floor(n) : Math.round(n * 100) / 100;
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  try {
    const campaign = await db.marketingCampaign.findFirst({ where: { id, propertyId } });
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

    const data: {
      name?: string;
      channel?: string;
      audience?: string;
      promoCode?: string;
      budget?: number;
      startsAt?: Date | null;
      endsAt?: Date | null;
      notes?: string;
      status?: string;
      reach?: number;
      conversions?: number;
      revenue?: number;
      spent?: number;
    } = {};

    // ── Creation fields ───────────────────────────────────────────────────
    if (body.name !== undefined) {
      const name = String(body.name).trim();
      if (name.length < 1 || name.length > 120) {
        return NextResponse.json({ error: "Name must be 1–120 characters" }, { status: 400 });
      }
      data.name = name;
    }

    if (body.channel !== undefined) {
      const channel = String(body.channel);
      if (!(CHANNELS as readonly string[]).includes(channel)) {
        return NextResponse.json({ error: "Invalid channel" }, { status: 400 });
      }
      data.channel = channel;
    }

    if (body.audience !== undefined) {
      const audience = String(body.audience);
      if (!(AUDIENCES as readonly string[]).includes(audience)) {
        return NextResponse.json({ error: "Invalid audience" }, { status: 400 });
      }
      data.audience = audience;
    }

    if (body.promoCode !== undefined) {
      const promoCode = String(body.promoCode ?? "").trim().toUpperCase();
      if (promoCode && promoCode !== campaign.promoCode) {
        const promo = await db.promoCode.findFirst({ where: { propertyId, code: promoCode } });
        if (!promo) return NextResponse.json({ error: `Promo code ${promoCode} does not exist on this property` }, { status: 400 });
      }
      data.promoCode = promoCode;
    }

    if (body.budget !== undefined) {
      const budget = parseNonNegative(body.budget);
      if (budget === null) return NextResponse.json({ error: "Budget must be a number ≥ 0" }, { status: 400 });
      data.budget = budget;
    }

    // Dates are OPTIONAL on PATCH — only validate/set when the client sent them.
    // (parseOptionalDate returns undefined both for "absent" and "unparseable",
    //  so gate on body.startsAt/endsAt being present before treating it as an error.)
    if (body.startsAt !== undefined) {
      const startsAt = parseOptionalDate(body.startsAt);
      if (startsAt === undefined) return NextResponse.json({ error: "Invalid start date" }, { status: 400 });
      data.startsAt = startsAt;
    }
    if (body.endsAt !== undefined) {
      const endsAt = parseOptionalDate(body.endsAt);
      if (endsAt === undefined) return NextResponse.json({ error: "Invalid end date" }, { status: 400 });
      data.endsAt = endsAt;
    }
    const effStart = data.startsAt !== undefined ? data.startsAt : campaign.startsAt;
    const effEnd = data.endsAt !== undefined ? data.endsAt : campaign.endsAt;
    if (effStart && effEnd && effEnd < effStart) {
      return NextResponse.json({ error: "End date must be on or after the start date" }, { status: 400 });
    }

    if (body.notes !== undefined) {
      data.notes = String(body.notes ?? "").slice(0, 500);
    }

    // ── Lifecycle (simple enum check — draft→active→paused/completed) ─────
    if (body.status !== undefined) {
      const status = String(body.status);
      if (!(STATUSES as readonly string[]).includes(status)) {
        return NextResponse.json({ error: "Invalid status" }, { status: 400 });
      }
      data.status = status;
    }

    // ── Result counters ───────────────────────────────────────────────────
    const reach = parseNonNegative(body.reach, true);
    if (reach === null) return NextResponse.json({ error: "Reach must be a number ≥ 0" }, { status: 400 });
    if (reach !== undefined) data.reach = reach;
    const conversions = parseNonNegative(body.conversions, true);
    if (conversions === null) return NextResponse.json({ error: "Conversions must be a number ≥ 0" }, { status: 400 });
    if (conversions !== undefined) data.conversions = conversions;
    const revenue = parseNonNegative(body.revenue);
    if (revenue === null) return NextResponse.json({ error: "Revenue must be a number ≥ 0" }, { status: 400 });
    if (revenue !== undefined) data.revenue = revenue;
    const spent = parseNonNegative(body.spent);
    if (spent === null) return NextResponse.json({ error: "Spent must be a number ≥ 0" }, { status: 400 });
    if (spent !== undefined) data.spent = spent;

    const updated = await db.marketingCampaign.update({ where: { id: campaign.id }, data });

    const changes = Object.keys(data).filter((k) => data[k as keyof typeof data] !== undefined);
    await logActivity({
      propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "growth.campaign_update",
      entity: "marketing_campaign",
      entityId: campaign.id,
      details: `Updated campaign "${updated.name}" — ${changes.join(", ") || "no changes"}`,
    });

    return NextResponse.json({ campaign: updated });
  } catch (e) {
    console.error("[growth/campaigns/:id PATCH]", e);
    return NextResponse.json({ error: "Failed to update campaign" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await ctx.params;

  try {
    const campaign = await db.marketingCampaign.findFirst({ where: { id, propertyId } });
    if (!campaign) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });

    await db.marketingCampaign.delete({ where: { id: campaign.id } });

    await logActivity({
      propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "growth.campaign_delete",
      entity: "marketing_campaign",
      entityId: campaign.id,
      details: `Deleted campaign "${campaign.name}" (${campaign.channel})`,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[growth/campaigns/:id DELETE]", e);
    return NextResponse.json({ error: "Failed to delete campaign" }, { status: 500 });
  }
}
