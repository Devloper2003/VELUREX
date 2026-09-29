import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { round2 } from "@/app/api/invoice/_shared";

/**
 * POST /api/groups/[code]/rates — per-room nightly-rate overrides for a group.
 *
 * Body: { overrides?: [{ reservationId, nightlyRate }], applyToAll?: number }
 * At least one of `overrides` / `applyToAll` must be provided. `applyToAll`
 * sets every member's rate in one shot; per-member `overrides` win for the
 * rooms they mention.
 *
 * Only active bookings (hold / confirmed / checked_in) are re-priced —
 * cancelled, no-show and checked-out folios are left untouched. The booking
 * total is recalculated as nightlyRate × nights; posted folio nights are NOT
 * modified (night audit already locked those).
 */
const RATES_CAPABLE = new Set(["hold", "confirmed", "checked_in"]);

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const rawOverrides = Array.isArray(body.overrides) ? body.overrides : [];
  const applyToAll = Number(body.applyToAll);

  const overrides = new Map<string, number>();
  for (const o of rawOverrides) {
    const rec = o as Record<string, unknown>;
    const rid = typeof rec?.reservationId === "string" ? rec.reservationId : "";
    const rate = Number(rec?.nightlyRate);
    if (!rid) return NextResponse.json({ error: "Each override needs a reservationId" }, { status: 400 });
    if (!Number.isFinite(rate) || rate < 0) {
      return NextResponse.json({ error: `Invalid nightlyRate for a member of ${groupCode}` }, { status: 400 });
    }
    overrides.set(rid, round2(rate));
  }
  if (Number.isFinite(applyToAll) && body.applyToAll !== undefined && body.applyToAll !== null) {
    if (applyToAll < 0) return NextResponse.json({ error: "applyToAll must be a positive rate" }, { status: 400 });
    const members = await db.reservation.findMany({
      where: { propertyId, groupCode, status: { in: [...RATES_CAPABLE] } },
      select: { id: true },
    });
    for (const m of members) if (!overrides.has(m.id)) overrides.set(m.id, round2(applyToAll));
  }
  if (overrides.size === 0) {
    return NextResponse.json({ error: "Provide overrides[] or applyToAll" }, { status: 400 });
  }

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: { guest: { select: { fullName: true } }, room: { select: { number: true } } },
  });
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  const changes: { reservationId: string; from: number; to: number }[] = [];
  const skipped: string[] = [];

  await db.$transaction(async (tx) => {
    for (const m of members) {
      const rate = overrides.get(m.id);
      if (rate === undefined) continue;
      if (!RATES_CAPABLE.has(m.status)) {
        skipped.push(`${m.guest.fullName} (${m.room?.number ?? m.confirmationNumber}) — ${m.status.replace("_", " ")}`);
        continue;
      }
      const revisedTotal = round2(rate * m.nights);
      if (round2(m.nightlyRate) === rate && round2(m.totalAmount) === revisedTotal) continue;
      await tx.reservation.update({
        where: { id: m.id },
        data: { nightlyRate: rate, totalAmount: revisedTotal },
      });
      changes.push({ reservationId: m.id, from: round2(m.nightlyRate), to: rate });
    }
  });

  if (changes.length > 0) {
    const label = (id: string) => {
      const m = members.find((x) => x.id === id);
      return m ? `${m.guest.fullName} (${m.room?.number ?? m.confirmationNumber})` : id;
    };
    await logActivity({
      propertyId,
      staffId: auth.session.sub,
      staffName: auth.session.name,
      action: "GROUP_RATE_OVERRIDE",
      entity: "reservation",
      entityId: members[0]?.id ?? groupCode,
      details: `Group ${groupCode}: ${changes.length} room rate(s) overridden — ${changes
        .map((c) => `${label(c.reservationId)} ₹${c.from.toFixed(0)} → ₹${c.to.toFixed(0)}`)
        .join(", ")}${skipped.length > 0 ? ` (skipped: ${skipped.join("; ")})` : ""}`,
    });
  }

  const refreshed = await db.reservation.findMany({
    where: { propertyId, groupCode },
    select: { id: true, nightlyRate: true, totalAmount: true, status: true },
  });

  return NextResponse.json({
    changed: changes,
    skipped,
    members: refreshed,
  });
}
