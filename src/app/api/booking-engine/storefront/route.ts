import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { getPrimaryProperty, parseAmenities } from "../_shared";

/**
 * Storefront configuration API (hotel_admin) — backs the "Storefront" tab of
 * the tenant Booking Engine view.
 *
 * GET   → { policy, roomTypes: [{id,name,code,baseRate,photos,amenities}], upsells }
 * PATCH → { policy?: {checkInTime?, checkOutTime?, cancellationPolicy?, minNights?},
 *           photos?: [{roomTypeId, photos: string[]}] }
 *
 * Photos use the same URL rule as menu images: /api/uploads/… or https://…,
 * max 6 per room type, each ≤ 500 chars.
 */

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_PHOTOS = 6;
const MAX_PHOTO_LEN = 500;

function validPhotoUrl(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!s || s.length > MAX_PHOTO_LEN) return false;
  return s.startsWith("/api/uploads/") || s.startsWith("https://");
}

/** GET /api/booking-engine/storefront — current storefront configuration. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  // Each tenant manages ITS OWN storefront (policies / photos / add-ons).
  // The public /book page currently serves the platform's primary property
  // only — `isPrimary` tells the UI whether this tenant IS that property.
  const primary = await getPrimaryProperty();
  const isPrimary = !!primary && primary.id === auth.session.propertyId;
  const property = await db.property.findUnique({ where: { id: auth.session.propertyId } });
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });

  const [roomTypes, upsells] = await Promise.all([
    db.roomType.findMany({
      where: { propertyId: property.id },
      orderBy: { baseRate: "asc" },
      select: { id: true, name: true, code: true, baseRate: true, photos: true, amenities: true },
    }),
    db.bookingUpsell.findMany({
      where: { propertyId: property.id },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
  ]);

  return NextResponse.json({
    isPrimary,
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
        photos,
        amenities: parseAmenities(rt.amenities),
      };
    }),
    upsells,
  });
}

/** PATCH /api/booking-engine/storefront — update policy fields and room photo galleries. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;

  const property = await db.property.findUnique({ where: { id: auth.session.propertyId } });
  if (!property) return NextResponse.json({ error: "Property not configured" }, { status: 404 });
  // PATCH also operates on the SESSION property — tenants manage their own storefront.

  const body = (await req.json().catch(() => null)) as {
    policy?: {
      checkInTime?: unknown;
      checkOutTime?: unknown;
      cancellationPolicy?: unknown;
      minNights?: unknown;
    };
    photos?: { roomTypeId?: unknown; photos?: unknown }[];
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const changes: string[] = [];

  // ── Policy ──
  if (body.policy) {
    const data: { checkInTime?: string; checkOutTime?: string; cancellationPolicy?: string; minNights?: number } = {};

    if (body.policy.checkInTime !== undefined) {
      const v = String(body.policy.checkInTime).trim();
      if (!TIME_RE.test(v)) {
        return NextResponse.json({ error: "checkInTime must be HH:mm (24h), e.g. 14:00" }, { status: 400 });
      }
      data.checkInTime = v;
    }
    if (body.policy.checkOutTime !== undefined) {
      const v = String(body.policy.checkOutTime).trim();
      if (!TIME_RE.test(v)) {
        return NextResponse.json({ error: "checkOutTime must be HH:mm (24h), e.g. 11:00" }, { status: 400 });
      }
      data.checkOutTime = v;
    }
    if (body.policy.cancellationPolicy !== undefined) {
      const v = String(body.policy.cancellationPolicy).trim();
      if (v.length > 500) {
        return NextResponse.json({ error: "cancellationPolicy must be at most 500 characters" }, { status: 400 });
      }
      data.cancellationPolicy = v;
    }
    if (body.policy.minNights !== undefined) {
      const v = Number(body.policy.minNights);
      if (!Number.isInteger(v) || v < 1 || v > 30) {
        return NextResponse.json({ error: "minNights must be a whole number between 1 and 30" }, { status: 400 });
      }
      data.minNights = v;
    }

    if (Object.keys(data).length > 0) {
      await db.property.update({ where: { id: property.id }, data });
      changes.push(`policy (${Object.keys(data).join(", ")})`);
    }
  }

  // ── Room photos ──
  if (Array.isArray(body.photos) && body.photos.length > 0) {
    const owned = await db.roomType.findMany({
      where: { propertyId: property.id },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((rt) => rt.id));

    for (const entry of body.photos) {
      const roomTypeId = String(entry?.roomTypeId ?? "");
      if (!ownedIds.has(roomTypeId)) {
        return NextResponse.json({ error: `Room type ${roomTypeId} does not belong to this property` }, { status: 400 });
      }
      const rawList = Array.isArray(entry?.photos) ? entry.photos : [];
      if (rawList.length > MAX_PHOTOS) {
        return NextResponse.json({ error: `A room type can have at most ${MAX_PHOTOS} photos` }, { status: 400 });
      }
      const photos: string[] = [];
      for (const p of rawList) {
        if (!validPhotoUrl(p)) {
          return NextResponse.json(
            { error: "Each photo must start with /api/uploads/ or https:// and be at most 500 characters" },
            { status: 400 }
          );
        }
        photos.push(String(p).trim());
      }
      await db.roomType.update({ where: { id: roomTypeId }, data: { photos: JSON.stringify(photos) } });
      changes.push(`photos × ${photos.length} (${roomTypeId.slice(-6).toUpperCase()})`);
    }
  }

  if (changes.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  await logActivity({
    propertyId: property.id,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "booking.storefront_update",
    entity: "Property",
    entityId: property.id,
    details: `Storefront updated — ${changes.join(", ")}`,
  });

  return NextResponse.json({ ok: true });
}
