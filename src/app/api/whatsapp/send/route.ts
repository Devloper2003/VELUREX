import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { bookingConfirmationMsg, postStayMsg, preArrivalMsg, sendWhatsApp } from "@/lib/whatsapp";
import { getTenantEntitlements, requireFeature, checkLimit } from "@/lib/entitlements";

const TEMPLATES = ["booking_confirmation", "pre_arrival", "post_stay", "custom"];

/** Sensible default copy when a template is sent without a custom body. */
function defaultBody(
  templateName: string,
  hotelName: string,
  reservation?: {
    guest: { fullName: string };
    confirmationNumber: string;
    checkIn: Date;
    nights: number;
    totalAmount: number;
    roomType?: { name: string } | null;
  } | null
): string {
  if (reservation) {
    if (templateName === "booking_confirmation")
      return bookingConfirmationMsg(
        hotelName,
        reservation.guest.fullName,
        reservation.confirmationNumber,
        reservation.checkIn,
        reservation.roomType?.name ?? "your room",
        reservation.nights,
        reservation.totalAmount
      );
    if (templateName === "pre_arrival")
      return preArrivalMsg(hotelName, reservation.guest.fullName, reservation.confirmationNumber, reservation.checkIn);
    if (templateName === "post_stay") return postStayMsg(hotelName, reservation.guest.fullName);
  }
  switch (templateName) {
    case "booking_confirmation":
      return `Hi! Your booking at ${hotelName} is confirmed. 🏨 Check-in from 2 PM — we look forward to hosting you!`;
    case "pre_arrival":
      return `Hi! We look forward to welcoming you to ${hotelName} tomorrow! Check-in from 2 PM. Need an airport pickup or early check-in? Just reply here.`;
    case "post_stay":
      return `Thank you for staying with us at ${hotelName}! We'd love your feedback — rate your stay 1-5 by replying to this message. Hope to see you again soon! ✨`;
    default:
      return "";
  }
}

/**
 * POST /api/whatsapp/send — auth (hotel_admin, front_desk): send a message to
 * a phone number. Templates get sensible defaults when no body is given; an
 * optional reservationId personalises the copy and links the log entry.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: WhatsApp automation is a Pro+ feature with a monthly quota.
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

  const body = (await req.json().catch(() => null)) as
    | { toPhone?: string; templateName?: string; body?: string; reservationId?: string }
    | null;

  const toPhone = String(body?.toPhone ?? "").trim();
  const templateName = String(body?.templateName ?? "").trim();
  const text = String(body?.body ?? "").trim();

  if (!toPhone || toPhone.replace(/\D/g, "").length < 8)
    return NextResponse.json({ error: "A valid toPhone number is required" }, { status: 400 });
  if (!TEMPLATES.includes(templateName))
    return NextResponse.json(
      { error: `templateName must be one of: ${TEMPLATES.join(", ")}` },
      { status: 400 }
    );

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  let reservation: {
    guest: { fullName: string };
    confirmationNumber: string;
    checkIn: Date;
    nights: number;
    totalAmount: number;
    roomType: { name: string } | null;
  } | null = null;

  if (body?.reservationId) {
    const found = await db.reservation.findFirst({
      where: { id: body.reservationId, propertyId },
      include: {
        guest: { select: { fullName: true } },
        roomType: { select: { name: true } },
      },
    });
    if (!found) return NextResponse.json({ error: "Reservation not found" }, { status: 404 });
    reservation = found;
  }

  let finalBody = text;
  if (!finalBody) {
    if (templateName === "custom")
      return NextResponse.json({ error: "A message body is required for custom messages" }, { status: 400 });
    finalBody = defaultBody(templateName, property.name, reservation);
  }

  const message = await sendWhatsApp({
    propertyId,
    toPhone,
    templateName,
    body: finalBody,
    reservationId: body?.reservationId ?? null,
  });

  return NextResponse.json({ message }, { status: 201 });
}
