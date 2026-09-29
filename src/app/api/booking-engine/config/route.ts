import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseAmenities } from "../_shared";

/** GET /api/booking-engine/config — public storefront configuration for the embeddable widget. */
export async function GET() {
  const property = await db.property.findFirst({ orderBy: { createdAt: "asc" } });
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const roomTypes = await db.roomType.findMany({
    where: { propertyId: property.id },
    orderBy: { baseRate: "asc" },
  });

  return NextResponse.json({
    hotelName: property.name,
    city: property.city,
    currency: property.currency,
    roomTypes: roomTypes.map((rt) => ({
      id: rt.id,
      name: rt.name,
      code: rt.code,
      baseRate: rt.baseRate,
      maxOccupancy: rt.maxOccupancy,
      description: rt.description,
      amenities: parseAmenities(rt.amenities),
      sizeSqft: rt.sizeSqft,
      bedType: rt.bedType,
    })),
  });
}
