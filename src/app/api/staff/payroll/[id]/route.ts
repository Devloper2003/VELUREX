import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

const MONEY_FIELDS = ["allowances", "deductions", "advance", "bonus"] as const;
const PAID_METHODS = ["cash", "bank", "upi"] as const;
const SETTABLE_STATUSES = ["processed", "paid"] as const;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * PATCH /api/staff/payroll/[id] — adjust a payroll record and/or move its status along.
 *
 * Money fields (allowances, deductions, advance, bonus) and notes may be edited while
 * the record is in draft/processed; netPay is always recomputed after any money change.
 * status transitions: draft|processed → processed, or draft|processed → paid
 * (paid requires paidMethod ∈ cash|bank|upi and stamps paidAt).
 * A paid record is frozen — any edit is rejected with 403.
 * Roles: hotel_admin.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: adminName } = auth.session;

  const { id } = await ctx.params;

  const record = await db.payrollRecord.findFirst({
    where: { id, propertyId },
    include: { staff: { select: { name: true } } },
  });
  if (!record) return NextResponse.json({ error: "Payroll record not found" }, { status: 404 });

  if (record.status === "paid") {
    return NextResponse.json({ error: "This payroll record is already paid and frozen" }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const data: {
    allowances?: number;
    deductions?: number;
    advance?: number;
    bonus?: number;
    notes?: string;
    status?: string;
    paidAt?: Date | null;
    paidMethod?: string;
    netPay?: number;
  } = {};
  const changed: string[] = [];
  let moneyChanged = false;

  for (const field of MONEY_FIELDS) {
    if (body[field] === undefined) continue;
    const v = Number(body[field]);
    if (!Number.isFinite(v) || v < 0 || v > 100_000_000) {
      return NextResponse.json({ error: `${field} must be a non-negative number` }, { status: 400 });
    }
    data[field] = round2(v);
    if (data[field] !== record[field]) {
      changed.push(`${field} → ₹${data[field]}`);
      moneyChanged = true;
    }
  }

  if (body.notes !== undefined) {
    const notes = typeof body.notes === "string" ? body.notes.trim().slice(0, 500) : "";
    data.notes = notes;
    if (notes !== record.notes) changed.push("notes updated");
  }

  let wantsPaid = false;
  if (body.status !== undefined) {
    const status = typeof body.status === "string" ? body.status.trim() : "";
    if (!SETTABLE_STATUSES.includes(status as (typeof SETTABLE_STATUSES)[number])) {
      return NextResponse.json({ error: 'status must be "processed" or "paid"' }, { status: 400 });
    }
    data.status = status;
    if (status !== record.status) changed.push(`status → ${status}`);
    if (status === "paid") wantsPaid = true;
  }

  if (body.paidMethod !== undefined) {
    const method = typeof body.paidMethod === "string" ? body.paidMethod.trim() : "";
    if (!PAID_METHODS.includes(method as (typeof PAID_METHODS)[number])) {
      return NextResponse.json({ error: "paidMethod must be one of: cash, bank, upi" }, { status: 400 });
    }
    data.paidMethod = method;
    if (method !== record.paidMethod) changed.push(`paid method → ${method}`);
  }

  if (wantsPaid) {
    // Method must arrive in this request (or already be on the record).
    const method = data.paidMethod ?? record.paidMethod;
    if (!PAID_METHODS.includes(method as (typeof PAID_METHODS)[number])) {
      return NextResponse.json({ error: "Marking paid requires paidMethod: cash, bank or upi" }, { status: 400 });
    }
    if (!data.paidMethod) data.paidMethod = method;
    data.paidAt = new Date();
  } else if (data.status === "processed") {
    // Moving back from a payment-adjacent state should never carry a paid stamp.
    data.paidAt = null;
    data.paidMethod = "";
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json(
      { error: "Nothing to update — send allowances/deductions/advance/bonus/notes and/or status" },
      { status: 400 }
    );
  }

  if (moneyChanged) {
    const allowances = data.allowances ?? record.allowances;
    const deductions = data.deductions ?? record.deductions;
    const advance = data.advance ?? record.advance;
    const bonus = data.bonus ?? record.bonus;
    data.netPay = round2(record.baseSalary + allowances + bonus - deductions - advance);
    changed.push(`netPay → ₹${data.netPay}`);
  }

  const updated = await db.payrollRecord.update({ where: { id }, data });

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName,
    action: "staff.payroll_update",
    entity: "PayrollRecord",
    entityId: id,
    details: `${record.staff.name} (${record.month}/${record.year}): ${changed.join(", ") || "no changes"}`,
  });

  return NextResponse.json({ record: updated });
}
