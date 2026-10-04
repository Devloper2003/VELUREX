import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/** Property timezone for the business date — all Velurex properties run on IST. */
const TZ = "Asia/Kolkata";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * POST /api/staff/attendance/punch — clock a staff member in or out for today.
 * Body: { staffId, direction: "in" | "out" }
 * The business date is computed server-side in Asia/Kolkata (en-CA → yyyy-mm-dd).
 * Roles: hotel_admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: adminName, email: adminEmail } = auth.session;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const staffId = typeof body.staffId === "string" ? body.staffId.trim() : "";
  const direction = typeof body.direction === "string" ? body.direction.trim() : "";
  if (!staffId || (direction !== "in" && direction !== "out")) {
    return NextResponse.json({ error: 'staffId and direction ("in" or "out") are required' }, { status: 400 });
  }

  const staff = await db.staff.findFirst({ where: { id: staffId, propertyId } });
  if (!staff) return NextResponse.json({ error: "Staff member not found on this property" }, { status: 404 });

  const date = new Date().toLocaleDateString("en-CA", { timeZone: TZ }); // yyyy-mm-dd
  const now = new Date();
  const existing = await db.staffAttendance.findUnique({ where: { staffId_date: { staffId, date } } });

  let row;
  if (direction === "in") {
    if (existing?.checkInAt) {
      return NextResponse.json({ error: `${staff.name} already punched in today` }, { status: 409 });
    }
    row = existing
      ? await db.staffAttendance.update({
          where: { staffId_date: { staffId, date } },
          data: { checkInAt: now, markedBy: adminEmail },
        })
      : await db.staffAttendance.create({
          data: {
            propertyId,
            staffId,
            date,
            status: "present", // a physical punch-in implies present
            checkInAt: now,
            markedBy: adminEmail,
          },
        });
  } else {
    if (!existing?.checkInAt) {
      return NextResponse.json({ error: `${staff.name} has no punch-in recorded today` }, { status: 409 });
    }
    if (existing.checkOutAt) {
      return NextResponse.json({ error: `${staff.name} already punched out today` }, { status: 409 });
    }
    const hours = round1((now.getTime() - existing.checkInAt.getTime()) / 3_600_000);
    row = await db.staffAttendance.update({
      where: { staffId_date: { staffId, date } },
      data: { checkOutAt: now, hoursWorked: Math.max(0, hours), markedBy: adminEmail },
    });
  }

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName || adminEmail,
    action: "staff.attendance_punch",
    entity: "StaffAttendance",
    entityId: row.id,
    details: `${staff.name} punched ${direction.toUpperCase()} at ${now.toLocaleTimeString("en-IN", { timeZone: TZ })}`,
  });

  return NextResponse.json({ record: row }, { status: existing ? 200 : 201 });
}
