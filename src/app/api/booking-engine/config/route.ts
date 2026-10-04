import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseAmenities } from "../_shared";

/**
 * GET /api/booking-engine/config — public storefront configuration for the
 * embeddable widget and the hosted /book page.
 *
 * Beyond the original fields (hotelName/city/currency/roomTypes) this now
 * carries everything the upgraded storefront needs: per-room-type photo
 * galleries, the property's stay policy (check-in/out times, cancellation,
 * minimum nights) and the active add-ons (upsells).
 *
 * Supports an optional `?property=<id>` so each tenant can host its own
 * booking page (`/book?property=...`); without the param the flagship
 * (first-created) property is served, preserving legacy behavior.
 */
export async function GET(req: NextRequest) {
  const requestedId = req.nextUrl.searchParams.get("property") ?? "";
  const property = requestedId
    ? await db.property.findFirst({
        where: { id: requestedId, deletedAt: null },
      })
    : await db.property.findFirst({ orderBy: { createdAt: "asc" } });
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const [roomTypes, upsells] = await Promise.all([
    db.roomType.findMany({
      where: { propertyId: property.id },
      orderBy: { baseRate: "asc" },
    }),
    db.bookingUpsell.findMany({
      where: { propertyId: property.id, active: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, description: true, price: true, priceType: true },
    }),
  ]);

  return NextResponse.json({
    hotelName: property.name,
    city: property.city,
    currency: property.currency,
    policy: {
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      cancellationPolicy: property.cancellationPolicy,
      minNights: property.minNights,
    },
    roomTypes: roomTypes.map((rt) => {
      let photos: string[] = [];
      try {
        const parsed: unknown = JSON.parse(rt.photos || "[]");
        if (Array.isArray(parsed)) photos = parsed.map(String);
      } catch {
        photos = [];
      }
      return {
        id: rt.id,
        name: rt.name,
        code: rt.code,
        baseRate: rt.baseRate,
        maxOccupancy: rt.maxOccupancy,
        description: rt.description,
        amenities: parseAmenities(rt.amenities),
        photos,
        sizeSqft: rt.sizeSqft,
        bedType: rt.bedType,
      };
    }),
    upsells: upsells.map((u) => ({
      id: u.id,
      name: u.name,
      description: u.description,
      price: u.price,
      priceType: u.priceType,
    })),
  });
}
