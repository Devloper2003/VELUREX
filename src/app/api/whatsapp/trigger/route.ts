import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { startOfDay } from "@/lib/business";
import { postStayMsg, preArrivalMsg, sendWhatsApp } from "@/lib/whatsapp";
import { getTenantEntitlements, requireFeature, checkLimit } from "@/lib/entitlements";
type TriggerKind = "pre_arrival" | "post_stay";

/**
 * POST /api/whatsapp/trigger — auth (hotel_admin, front_desk): fire lifecycle
 * messages. With a reservationId it targets that stay; without one it runs in
 * bulk: pre_arrival → confirmations arriving tomorrow, post_stay → guests who
 * checked out today.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: WhatsApp automation + monthly quota.
  const ent = await getTenantEntitlements(propertyId);
  const locked = requireFeature(ent, "whatsapp_automation", "WhatsApp automation");
  if (locked) return locked;
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const waThisMonth = await db.whatsAppMessage.count({
    where: { propertyId, createdAt: { gte: monthStart }, status: { in: ["queued", "sent", "mock"] } },
  });
  const waCap = checkLimit(ent, "whatsapp_msgs", waThisMonth, "WhatsApp messages this month");
  if (waCap) return waCap;

  const body = (await req.json().catch(() => null)) as { kind?: string; reservationId?: string } | null;
  const kind = body?.kind;
  if (kind !== "pre_arrival" && kind !== "post_stay")
    return NextResponse.json({ error: 'kind must be "pre_arrival" or "post_stay"' }, { status: 400 });

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const include = { guest: { select: { id: true, fullName: true, phone: true } } };
  const withPhone = (r: { guest: { phone: string } }) => r.guest.phone.trim().length > 0;

  let reservations: Array<{
    id: string;
    confirmationNumber: string;
    checkIn: Date;
    guest: { fullName: string; phone: string };
  }>;
  let skippedAlreadyMessaged = 0;

  if (body?.reservationId) {
    const reservation = await db.reservation.findFirst({
      where: { id: body.reservationId, propertyId },
      include,
    });
    if (!reservation) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    reservations = [reservation];
  } else if (kind === "pre_arrival") {
    const tomorrow = startOfDay(new Date(Date.now() + 86400000));
    const dayAfter = new Date(tomorrow.getTime() + 86400000);
    const candidates = await db.reservation.findMany({
      where: { propertyId, status: "confirmed", checkIn: { gte: tomorrow, lt: dayAfter } },
      include,
      orderBy: { checkIn: "asc" },
    });
    // Idempotency: skip guests who already received a pre_arrival message
    const candidateIds = candidates.map((c) => c.id);
    const already = candidateIds.length
      ? await db.whatsAppMessage.findMany({
          where: { propertyId, templateName: "pre_arrival", reservationId: { in: candidateIds } },
          select: { reservationId: true },
        })
      : [];
    const messaged = new Set(already.map((m) => m.reservationId));
    skippedAlreadyMessaged = candidates.filter((c) => messaged.has(c.id)).length;
    reservations = candidates.filter((c) => !messaged.has(c.id));
  } else {
    const today = startOfDay(new Date());
    const tomorrow = new Date(today.getTime() + 86400000);
    reservations = await db.reservation.findMany({
      where: { propertyId, status: "checked_out", checkedOutAt: { gte: today, lt: tomorrow } },
      include,
      orderBy: { checkedOutAt: "asc" },
    });
  }

  const eligible = reservations.filter(withPhone);
  const messages: Awaited<ReturnType<typeof sendWhatsApp>>[] = [];
  for (const reservation of eligible) {
    const bodyText =
      kind === "pre_arrival"
        ? preArrivalMsg(property.name, reservation.guest.fullName, reservation.confirmationNumber, reservation.checkIn)
        : postStayMsg(property.name, reservation.guest.fullName);
    messages.push(
      await sendWhatsApp({
        propertyId,
        toPhone: reservation.guest.phone,
        templateName: kind,
        body: bodyText,
        reservationId: reservation.id,
      })
    );
  }

  return NextResponse.json({
    sent: messages.length,
    eligible: eligible.length,
    skippedNoPhone: reservations.length - eligible.length,
    skippedAlreadyMessaged,
    messages,
  });
}
