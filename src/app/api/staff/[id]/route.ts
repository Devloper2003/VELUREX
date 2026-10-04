import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const DEPARTMENTS = ["front_office", "housekeeping", "fnb", "maintenance", "accounts", "other"];

/** Fields this HR route must NEVER touch — they belong to the settings module. */
const FORBIDDEN_FIELDS = ["email", "role", "active", "name", "phone", "password", "passwordHash", "googleEmail"];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * PATCH /api/staff/[id] — update HR profile fields only.
 * Allowed: designation, department, salary, joinDate.
 * email / role / active / credentials are explicitly rejected — those are owned
 * by the settings module (/api/settings/staff/[id]).
 * Roles: hotel_admin.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: adminName, email: adminEmail } = auth.session;

  const { id } = await ctx.params;

  const staff = await db.staff.findFirst({ where: { id, propertyId } });
  if (!staff) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Hard guard: this endpoint must never mutate identity/credentials.
  const intruder = FORBIDDEN_FIELDS.find((f) => body[f] !== undefined);
  if (intruder) {
    return NextResponse.json(
      { error: `Field "${intruder}" cannot be changed here — use the Team & Roles settings module` },
      { status: 400 }
    );
  }

  const data: { designation?: string; department?: string; salary?: number; joinDate?: Date | null } = {};
  const changed: string[] = [];

  if (body.designation !== undefined) {
    const designation = typeof body.designation === "string" ? body.designation.trim() : "";
    if (designation.length > 80) {
      return NextResponse.json({ error: "Designation must be 80 characters or fewer" }, { status: 400 });
    }
    data.designation = designation;
    if (designation !== staff.designation) changed.push(`designation → ${designation || "—"}`);
  }

  if (body.department !== undefined) {
    const department = typeof body.department === "string" ? body.department.trim() : "";
    if (department && !DEPARTMENTS.includes(department)) {
      return NextResponse.json({ error: `Department must be one of: ${DEPARTMENTS.join(", ")}` }, { status: 400 });
    }
    data.department = department;
    if (department !== staff.department) changed.push(`department → ${department || "—"}`);
  }

  if (body.salary !== undefined) {
    const salary = Number(body.salary);
    if (!Number.isFinite(salary) || salary < 0 || salary > 100_000_000) {
      return NextResponse.json({ error: "Salary must be a non-negative number (monthly INR)" }, { status: 400 });
    }
    data.salary = round2(salary);
    if (data.salary !== staff.salary) changed.push(`salary → ₹${data.salary}`);
  }

  if (body.joinDate !== undefined) {
    if (body.joinDate === null || body.joinDate === "") {
      data.joinDate = null;
      if (staff.joinDate) changed.push("join date cleared");
    } else {
      const raw = typeof body.joinDate === "string" ? body.joinDate.trim() : "";
      // Accept yyyy-mm-dd (from <input type=date>) or a full ISO datetime.
      const isoLike = /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(raw) ? raw : "";
      const parsed = isoLike ? new Date(isoLike) : new Date(raw);
      if (!raw || Number.isNaN(parsed.getTime())) {
        return NextResponse.json({ error: "Join date must be a valid ISO date (yyyy-mm-dd)" }, { status: 400 });
      }
      data.joinDate = parsed;
      if (!staff.joinDate || staff.joinDate.getTime() !== parsed.getTime()) {
        changed.push(`join date → ${isoLike.slice(0, 10)}`);
      }
    }
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "No HR fields to update (allowed: designation, department, salary, joinDate)" }, { status: 400 });
  }

  const updated = await db.staff.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName || adminEmail,
    action: "staff.hr_update",
    entity: "Staff",
    entityId: id,
    details: `${updated.name}: ${changed.join(", ") || "no changes"}`,
  });

  return NextResponse.json({
    staff: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone,
      role: updated.role,
      designation: updated.designation,
      department: updated.department,
      salary: updated.salary,
      joinDate: updated.joinDate,
      active: updated.active,
    },
  });
}
