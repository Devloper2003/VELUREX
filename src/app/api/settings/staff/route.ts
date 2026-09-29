import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { getTenantEntitlements, assertWritable, checkLimit } from "@/lib/entitlements";

const ROLES = ["hotel_admin", "front_desk", "housekeeping", "restaurant_staff"];

/** POST /api/settings/staff — [hotel_admin] create a staff account. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  // Plan enforcement: staff seats are capped per plan; workspace must be writable.
  const ent = await getTenantEntitlements(propertyId);
  const ro = assertWritable(ent);
  if (ro) return ro;
  const staffCount = await db.staff.count({ where: { propertyId } });
  const capped = checkLimit(ent, "staff", staffCount, "staff accounts");
  if (capped) return capped;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim();
  const email = String(body.email ?? "").trim().toLowerCase();
  const role = String(body.role ?? "").trim();
  const phone = String(body.phone ?? "").trim();
  const googleEmail = String(body.googleEmail ?? "").trim().toLowerCase() || null;

  // SECURITY: every new staff account ALWAYS starts on a generated temporary
  // password (format `Vlx@XXXXXXXX`). Any password typed by the admin is
  // ignored — the staff member must set their own permanent password on first
  // login. Only the scrypt hash is stored; the temp value is returned once.

  if (googleEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(googleEmail)) {
    return NextResponse.json({ error: "Google account must be a valid email" }, { status: 400 });
  }

  if (!name) return NextResponse.json({ error: "Name is required" }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }
  if (!ROLES.includes(role)) {
    return NextResponse.json({ error: `Role must be one of: ${ROLES.join(", ")}` }, { status: 400 });
  }

  const tempPassword = generateTempPassword();

  const existing = await db.staff.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "A staff account with this email already exists" }, { status: 409 });
  }

  const staff = await db.staff.create({
    data: {
      propertyId,
      name,
      email,
      role,
      phone,
      googleEmail,
      passwordHash: hashPassword(tempPassword),
      mustChangePassword: true,
      active: true,
    },
  });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "STAFF_CREATE",
    entity: "Staff",
    entityId: staff.id,
    details: `Created ${name} (${email}) as ${role}`,
  });

  return NextResponse.json(
    { staff: { id: staff.id, name: staff.name, email: staff.email, role: staff.role, active: staff.active, phone: staff.phone, googleEmail: staff.googleEmail, createdAt: staff.createdAt }, tempPassword },
    { status: 201 }
  );
}
