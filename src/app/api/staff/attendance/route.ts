import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const STATUSES = ["present", "absent", "leave", "half_day", "late", "week_off"] as const;
type Status = (typeof STATUSES)[number];

/** yyyy-mm in Asia/Kolkata (the property timezone). */
function currentMonth(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7);
}

/** "2026-02" → "2026-02-01"…"2026-02-31" string range (lexical compare is safe for fixed-width dates). */
function monthRange(month: string): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-31` };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function isISODate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function isISOTimestamp(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(new Date(v).getTime());
}

/**
 * GET /api/staff/attendance?month=YYYY-MM
 * Month attendance board: staff list + attendance rows + per-staff summary.
 * Roles: hotel_admin (manage), front_desk (read).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const month = req.nextUrl.searchParams.get("month") || currentMonth();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ error: "month must be in YYYY-MM format" }, { status: 400 });
  }
  const { from, to } = monthRange(month);

  const [staff, rows] = await Promise.all([
    db.staff.findMany({
      where: { propertyId },
      orderBy: [{ department: "asc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, role: true, designation: true, department: true, active: true },
    }),
    db.staffAttendance.findMany({
      where: { propertyId, date: { gte: from, lte: to } },
      orderBy: [{ date: "asc" }],
    }),
  ]);

  // Per-staff month summary. `present` counts strict present; `late` is tracked
  // separately (late still counts towards attendance % as a full attended day).
  const summaries: Record<string, { present: number; absent: number; leave: number; halfDays: number; late: number; weekOffs: number; pct: number }> = {};
  for (const s of staff) summaries[s.id] = { present: 0, absent: 0, leave: 0, halfDays: 0, late: 0, weekOffs: 0, pct: 0 };
  for (const r of rows) {
    const sum = summaries[r.staffId];
    if (!sum) continue;
    if (r.status === "present") sum.present += 1;
    else if (r.status === "late") sum.late += 1;
    else if (r.status === "absent") sum.absent += 1;
    else if (r.status === "leave") sum.leave += 1;
    else if (r.status === "half_day") sum.halfDays += 1;
    else if (r.status === "week_off") sum.weekOffs += 1;
  }
  for (const s of staff) {
    const sum = summaries[s.id];
    const attended = sum.present + sum.late + 0.5 * sum.halfDays;
    const denominator = sum.present + sum.late + sum.halfDays + sum.absent + sum.leave; // week_offs excluded
    sum.pct = denominator > 0 ? round1((attended / denominator) * 100) : 0;
  }

  return NextResponse.json({ month, staff, rows, summaries });
}

/**
 * POST /api/staff/attendance — mark one staff member's attendance for a date.
 * Body: { staffId, date (yyyy-mm-dd), status, checkInAt?, checkOutAt?, hoursWorked?, notes? }
 * Upserts by (staffId, date). Roles: hotel_admin.
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
  const date = typeof body.date === "string" ? body.date.trim() : "";
  const status = typeof body.status === "string" ? body.status.trim() : "";

  if (!staffId || !date || !status) {
    return NextResponse.json({ error: "staffId, date and status are required" }, { status: 400 });
  }
  if (!isISODate(date)) {
    return NextResponse.json({ error: "date must be a valid calendar date in YYYY-MM-DD format" }, { status: 400 });
  }
  if (!STATUSES.includes(status as Status)) {
    return NextResponse.json({ error: `status must be one of: ${STATUSES.join(", ")}` }, { status: 400 });
  }

  const staff = await db.staff.findFirst({ where: { id: staffId, propertyId } });
  if (!staff) return NextResponse.json({ error: "Staff member not found on this property" }, { status: 404 });

  // Optional punch timestamps → derive hoursWorked from the pair.
  let checkInAt: Date | undefined;
  let checkOutAt: Date | undefined;
  let hoursWorked: number | undefined;
  if (body.checkInAt !== undefined && body.checkInAt !== null && body.checkInAt !== "") {
    if (!isISOTimestamp(body.checkInAt)) return NextResponse.json({ error: "checkInAt must be a valid ISO timestamp" }, { status: 400 });
    checkInAt = new Date(body.checkInAt);
  }
  if (body.checkOutAt !== undefined && body.checkOutAt !== null && body.checkOutAt !== "") {
    if (!isISOTimestamp(body.checkOutAt)) return NextResponse.json({ error: "checkOutAt must be a valid ISO timestamp" }, { status: 400 });
    checkOutAt = new Date(body.checkOutAt);
  }
  if (checkInAt && checkOutAt) {
    const diffH = (checkOutAt.getTime() - checkInAt.getTime()) / 3_600_000;
    if (diffH < 0) return NextResponse.json({ error: "checkOutAt cannot be before checkInAt" }, { status: 400 });
    hoursWorked = round1(diffH);
  } else if (body.hoursWorked !== undefined && body.hoursWorked !== null && body.hoursWorked !== "") {
    // Manual override — wins over derivation when punches aren't both given.
    const h = Number(body.hoursWorked);
    if (!Number.isFinite(h) || h < 0 || h > 24) {
      return NextResponse.json({ error: "hoursWorked must be a number between 0 and 24" }, { status: 400 });
    }
    hoursWorked = round2(h);
  }

  const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : undefined;

  // Off-duty statuses wash out any punches unless explicit punch data arrived.
  const offDuty = status === "absent" || status === "leave" || status === "week_off";
  const washPunches = offDuty && checkInAt === undefined && checkOutAt === undefined && body.hoursWorked === undefined;

  const data = {
    status,
    markedBy: adminEmail,
    ...(checkInAt !== undefined ? { checkInAt } : {}),
    ...(checkOutAt !== undefined ? { checkOutAt } : {}),
    ...(hoursWorked !== undefined ? { hoursWorked } : {}),
    ...(notes !== undefined ? { notes } : {}),
  };

  const existing = await db.staffAttendance.findUnique({ where: { staffId_date: { staffId, date } } });

  const row = existing
    ? await db.staffAttendance.update({
        where: { staffId_date: { staffId, date } },
        data: washPunches ? { ...data, checkInAt: null, checkOutAt: null, hoursWorked: 0 } : data,
      })
    : await db.staffAttendance.create({
        data: {
          propertyId,
          staffId,
          date,
          ...(washPunches ? { hoursWorked: 0 } : {}),
          ...data,
        },
      });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName || adminEmail,
    action: "staff.attendance_mark",
    entity: "StaffAttendance",
    entityId: row.id,
    details: `${staff.name} · ${date} → ${status}${hoursWorked !== undefined ? ` (${hoursWorked}h)` : ""}`,
  });

  return NextResponse.json({ record: row }, { status: existing ? 200 : 201 });
}
