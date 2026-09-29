import { NextRequest, NextResponse } from "next/server";
import { GST_RATE } from "@/lib/business";
import { computeAvailability, parseDay, round2 } from "../_shared";

/**
 * GET /api/booking-engine/availability?checkIn=YYYY-MM-DD&checkOut=YYYY-MM-DD&adults=2
 * Public: per room type, worst-night availability across the stay + nightly
 * rates (rate-plan aware) + 12% GST quote.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const checkIn = parseDay(searchParams.get("checkIn"));
  const checkOut = parseDay(searchParams.get("checkOut"));
  const adults = Math.max(1, Number(searchParams.get("adults")) || 1);

  if (!checkIn || !checkOut)
    return NextResponse.json({ error: "checkIn and checkOut (YYYY-MM-DD) are required" }, { status: 400 });
  if (checkOut <= checkIn)
    return NextResponse.json({ error: "checkOut must be after checkIn" }, { status: 400 });

  const result = await computeAvailability(checkIn, checkOut);
  if (!result) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const nights = result.roomTypes[0]?.nightlyRates.length ?? 0;
  const roomTypes = result.roomTypes.map((rt) => {
    const fitsGuests = adults <= rt.maxOccupancy;
    const available = fitsGuests ? rt.available : 0;
    const taxAmount = round2(rt.total * (GST_RATE / 100));
    return {
      id: rt.id,
      name: rt.name,
      code: rt.code,
      description: rt.description,
      amenities: rt.amenities,
      maxOccupancy: rt.maxOccupancy,
      sizeSqft: rt.sizeSqft,
      bedType: rt.bedType,
      available,
      nightlyRates: rt.nightlyRates,
      avgRate: rt.avgRate,
      total: rt.total,
      taxes: { gst: GST_RATE, taxAmount },
      grandTotal: round2(rt.total + taxAmount),
    };
  });

  return NextResponse.json({
    hotelName: result.property.name,
    city: result.property.city,
    checkIn: searchParams.get("checkIn"),
    checkOut: searchParams.get("checkOut"),
    nights,
    roomTypes,
  });
}
