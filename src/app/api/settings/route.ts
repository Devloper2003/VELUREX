import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

function propertyPayload(p: {
  id: string;
  name: string;
  address: string;
  city: string;
  state: string;
  gstin: string;
  phone: string;
  email: string;
  propertyType: string;
  businessCategory: string;
  photoUrl: string;
  googleProfile: string;
  noShowPercent: number;
  auditCutoffHour: number;
  pricingEnabled: boolean;
  occupancyThreshold: number;
  rateIncreasePercent: number;
  businessDate: Date;
}) {
  let google: { connected: boolean; accountEmail?: string; profileName?: string; lastSyncedAt?: string | null } = { connected: false };
  try {
    if (p.googleProfile) google = { connected: false, ...JSON.parse(p.googleProfile) };
  } catch { /* corrupt JSON → treat as disconnected */ }
  return {
    id: p.id,
    name: p.name,
    address: p.address,
    city: p.city,
    state: p.state,
    gstin: p.gstin,
    phone: p.phone,
    email: p.email,
    propertyType: p.propertyType,
    businessCategory: p.businessCategory,
    photoUrl: p.photoUrl,
    googleProfile: google,
    noShowPercent: p.noShowPercent,
    auditCutoffHour: p.auditCutoffHour,
    pricingEnabled: p.pricingEnabled,
    occupancyThreshold: p.occupancyThreshold,
    rateIncreasePercent: p.rateIncreasePercent,
    businessDate: p.businessDate,
  };
}

/** GET /api/settings — property config (all roles) + staff directory (admin only). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const { propertyId, role } = auth.session;

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) {
    return NextResponse.json({ error: "Property not found" }, { status: 404 });
  }

  const canManageStaff = role === "hotel_admin";
  const staff = canManageStaff
    ? await db.staff.findMany({
        where: { propertyId },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, email: true, role: true, active: true, phone: true, googleEmail: true, createdAt: true },
      })
    : [];

  return NextResponse.json({ property: propertyPayload(property), staff, canManageStaff });
}

/** PUT /api/settings — [hotel_admin] update property fields. */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: Record<string, string | number> = {};
  const changed: string[] = [];

  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Property name is required" }, { status: 400 });
    data.name = name;
    if (name !== property.name) changed.push("name");
  }
  for (const f of ["address", "city", "gstin", "phone"] as const) {
    if (body[f] !== undefined) {
      const v = String(body[f]).trim();
      data[f] = v;
      if (v !== property[f]) changed.push(f);
    }
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    data.email = email;
    if (email !== property.email) changed.push("email");
  }
  if (body.propertyType !== undefined) {
    const v = String(body.propertyType).trim();
    if (!v) return NextResponse.json({ error: "Property type is required" }, { status: 400 });
    data.propertyType = v;
    if (v !== property.propertyType) changed.push("propertyType");
  }
  if (body.businessCategory !== undefined) {
    const v = String(body.businessCategory).trim();
    if (!v) return NextResponse.json({ error: "Business category is required" }, { status: 400 });
    data.businessCategory = v;
    if (v !== property.businessCategory) changed.push("businessCategory");
  }
  if (body.photoUrl !== undefined) {
    const v = String(body.photoUrl).trim();
    if (v && !v.startsWith("/uploads/")) {
      return NextResponse.json({ error: "photoUrl must be an uploaded file path" }, { status: 400 });
    }
    data.photoUrl = v;
    if (v !== property.photoUrl) changed.push("photoUrl");
  }
  if (body.noShowPercent !== undefined) {
    const v = Number(body.noShowPercent);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      return NextResponse.json({ error: "No-show percent must be between 0 and 100" }, { status: 400 });
    }
    data.noShowPercent = round2(v);
    if (round2(v) !== property.noShowPercent) changed.push("noShowPercent");
  }
  if (body.auditCutoffHour !== undefined) {
    const v = Number(body.auditCutoffHour);
    if (!Number.isInteger(v) || v < 0 || v > 23) {
      return NextResponse.json({ error: "Audit cutoff hour must be an integer 0–23" }, { status: 400 });
    }
    data.auditCutoffHour = v;
    if (v !== property.auditCutoffHour) changed.push("auditCutoffHour");
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
  }

  const updated = await db.property.update({ where: { id: propertyId }, data });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "SETTINGS_UPDATE",
    entity: "Property",
    entityId: propertyId,
    details: changed.length > 0 ? `Updated: ${changed.join(", ")}` : "Saved without changes",
  });

  return NextResponse.json({ property: propertyPayload(updated) });
}
