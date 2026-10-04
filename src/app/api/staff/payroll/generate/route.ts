import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * POST /api/staff/payroll/generate — build/refresh draft payroll for a cycle.
 * Body: { year, month }
 *
 * Rules (safe regeneration):
 *  - no record yet            → create a fresh draft from attendance (created)
 *  - existing status=draft    → refresh baseSalary + day counters + attendance-derived
 *                               deductions; manual allowances/bonus/advance are preserved
 *                               and netPay recomputed (updated)
 *  - existing status=processed→ untouched — numbers already locked for approval (skipped)
 *  - existing status=paid     → NEVER regenerated (skipped)
 *
 * Attendance math: presentDays = count(present) + count(late) — late counts as a
 * worked day; per-day rate = salary / daysInMonth; deductions = absent*perDay + half*0.5*perDay.
 * Roles: hotel_admin.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: adminName } = auth.session;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const year = Number(body?.year);
  const month = Number(body?.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "year (2000-2100) and month (1-12) are required as valid numbers" }, { status: 400 });
  }

  const mm = String(month).padStart(2, "0");
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-31`; // lexical upper bound — fixed-width yyyy-mm-dd compares safely

  const [activeStaff, rows, existingRecords] = await Promise.all([
    db.staff.findMany({
      where: { propertyId, active: true },
      orderBy: [{ department: "asc" }, { name: "asc" }],
      select: { id: true, name: true, salary: true },
    }),
    db.staffAttendance.findMany({
      where: { propertyId, date: { gte: from, lte: to } },
      select: { staffId: true, status: true },
    }),
    db.payrollRecord.findMany({ where: { propertyId, year, month } }),
  ]);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Tally attendance per staff: late counts as present.
  const tally = new Map<string, { present: number; half: number; leave: number; absent: number }>();
  for (const s of activeStaff) tally.set(s.id, { present: 0, half: 0, leave: 0, absent: 0 });
  for (const r of rows) {
    const t = tally.get(r.staffId);
    if (!t) continue; // inactive or departed staff rows are ignored for generation
    if (r.status === "present" || r.status === "late") t.present += 1;
    else if (r.status === "half_day") t.half += 1;
    else if (r.status === "leave") t.leave += 1;
    else if (r.status === "absent") t.absent += 1;
  }

  const existingByStaff = new Map(existingRecords.map((r) => [r.staffId, r]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of activeStaff) {
    const existing = existingByStaff.get(s.id);
    // Paid is frozen forever; processed is locked until reverted by an admin decision.
    if (existing && (existing.status === "paid" || existing.status === "processed")) {
      skipped += 1;
      continue;
    }

    const t = tally.get(s.id) ?? { present: 0, half: 0, leave: 0, absent: 0 };
    const presentDays = t.present; // late already merged in
    const perDay = daysInMonth > 0 ? s.salary / daysInMonth : 0;
    const deductions = round2(t.absent * perDay + t.half * 0.5 * perDay);

    if (existing) {
      // Draft: refresh attendance-derived numbers, keep manual allowances/bonus/advance.
      const netPay = round2(existing.baseSalary + existing.allowances + existing.bonus - deductions - existing.advance);
      await db.payrollRecord.update({
        where: { id: existing.id },
        data: {
          baseSalary: s.salary,
          deductions,
          presentDays,
          halfDays: t.half,
          leaveDays: t.leave,
          absentDays: t.absent,
          netPay,
        },
      });
      updated += 1;
    } else {
      // Fresh draft — start with zero manual components.
      const netPay = round2(s.salary - deductions);
      await db.payrollRecord.create({
        data: {
          propertyId,
          staffId: s.id,
          year,
          month,
          baseSalary: s.salary,
          allowances: 0,
          deductions,
          advance: 0,
          bonus: 0,
          netPay,
          presentDays,
          halfDays: t.half,
          leaveDays: t.leave,
          absentDays: t.absent,
          status: "draft",
        },
      });
      created += 1;
    }
  }

  const all = await db.payrollRecord.findMany({
    where: { propertyId, year, month },
    select: { netPay: true },
  });
  const totalPayroll = round2(all.reduce((sum, r) => sum + r.netPay, 0));

  await logActivity({
    propertyId,
    staffId: sub,
    staffName: adminName,
    action: "staff.payroll_generate",
    entity: "PayrollRecord",
    entityId: `${year}-${mm}`,
    details: `Payroll ${year}-${mm}: ${created} created · ${updated} updated · ${skipped} skipped · total ₹${totalPayroll}`,
  });

  return NextResponse.json({ created, updated, skipped, totalPayroll });
}
