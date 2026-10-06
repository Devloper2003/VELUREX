import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { getTenantEntitlements, assertWritable, checkLimit } from "@/lib/entitlements";
import { ensurePayrollDrafts, currentYearMonth } from "@/lib/payroll-sync";

const ROLES = ["hotel_admin", "front_desk", "housekeeping", "restaurant_staff"];
const DEPARTMENTS = ["front_office", "housekeeping", "fnb", "maintenance", "accounts", "other"];

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

  // Optional HR profile fields — captured at add time so payroll is meaningful
  // the moment the staff member is created (no separate HR editing pass).
  const designation = String(body.designation ?? "").trim().slice(0, 80);
  const department = String(body.department ?? "").trim();
  if (department && !DEPARTMENTS.includes(department)) {
    return NextResponse.json(
      { error: `Department must be one of: ${DEPARTMENTS.join(", ")}` },
      { status: 400 }
    );
  }
  let salary = 0;
  if (body.salary !== undefined && String(body.salary).trim() !== "") {
    salary = Number(body.salary);
    if (!Number.isFinite(salary) || salary < 0 || salary > 100_000_000) {
      return NextResponse.json({ error: "Salary must be a non-negative number (monthly INR)" }, { status: 400 });
    }
    salary = Math.round(salary * 100) / 100;
  }
  let joinDate: Date | null = null;
  if (body.joinDate !== undefined && body.joinDate !== null && String(body.joinDate).trim() !== "") {
    const raw = String(body.joinDate).trim();
    const isoLike = /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw) ? raw : "";
    const parsed = isoLike ? new Date(isoLike) : new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return NextResponse.json({ error: "Join date must be a valid date (yyyy-mm-dd)" }, { status: 400 });
    }
    joinDate = parsed;
  }

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
      designation,
      department,
      salary,
      joinDate,
    },
  });

  // Instant payroll sync: the fresh staff member gets their current-cycle
  // payroll draft right here, so the register shows them the moment the
  // directory gains a row. Best-effort — never blocks or fails the create.
  let payrollSynced = false;
  try {
    const { year, month } = currentYearMonth();
    const r = await ensurePayrollDrafts(propertyId, year, month);
    payrollSynced = r.created > 0;
  } catch {
    // payroll sync is best-effort; the next payroll read will retry
  }

  await logActivity({
    propertyId,
    staffId: sub,
    staffName,
    action: "STAFF_CREATE",
    entity: "Staff",
    entityId: staff.id,
    details: `Created ${name} (${email}) as ${role}${salary > 0 ? ` · salary ₹${salary}` : ""}`,
  });

  return NextResponse.json(
    {
      staff: {
        id: staff.id, name: staff.name, email: staff.email, role: staff.role, active: staff.active,
        phone: staff.phone, googleEmail: staff.googleEmail, createdAt: staff.createdAt,
        designation: staff.designation, department: staff.department, salary: staff.salary,
        joinDate: staff.joinDate, payrollSynced,
      },
      tempPassword,
    },
    { status: 201 }
  );
}
