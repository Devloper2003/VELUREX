/**
 * Payroll ⇆ Staff sync — the bridge that keeps the monthly payroll register in
 * lock-step with the HR directory.
 *
 * Before this module existed, payroll records were only ever created by the
 * explicit "Generate drafts" action, so a staff member added mid-cycle simply
 * did not exist in payroll until somebody remembered to regenerate. Every
 * entry point that creates or edits staff (or reads the register) now funnels
 * through `ensurePayrollDrafts` / `syncStaffPayrollDraft`, so the register is
 * always current the instant you look at it.
 */

import { db } from "@/lib/db";

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Current year/month in Asia/Kolkata (property timezone). */
export function currentYearMonth(): { year: number; month: number } {
  const ym = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7); // yyyy-mm
  const [y, m] = ym.split("-");
  return { year: Number(y), month: Number(m) };
}

/** Attendance tally for one staff member (late counts as a worked day). */
type Tally = { present: number; half: number; leave: number; absent: number };

function newTally(): Tally {
  return { present: 0, half: 0, leave: 0, absent: 0 };
}

function tallyAttendance(rows: { staffId: string; status: string }[]): Map<string, Tally> {
  const tally = new Map<string, Tally>();
  for (const r of rows) {
    const t = tally.get(r.staffId) ?? newTally();
    if (r.status === "present" || r.status === "late") t.present += 1;
    else if (r.status === "half_day") t.half += 1;
    else if (r.status === "leave") t.leave += 1;
    else if (r.status === "absent") t.absent += 1;
    tally.set(r.staffId, t);
  }
  return tally;
}

/**
 * Attendance-derived deductions for a cycle: absent × per-day + half-day × 0.5
 * × per-day, with per-day = salary / daysInMonth.
 */
export function attendanceDeductions(
  salary: number,
  t: Pick<Tally, "absent" | "half">,
  daysInMonth: number
): number {
  const perDay = daysInMonth > 0 ? salary / daysInMonth : 0;
  return round2(t.absent * perDay + t.half * 0.5 * perDay);
}

/**
 * Ensure every ACTIVE staff member of the property has a payroll record for
 * the given cycle — missing staff get a fresh draft created immediately
 * (attendance-derived deductions, current salary base).
 *
 * Deliberately conservative: existing records are NEVER touched here (drafts
 * may hold manual allowances/bonus/advance edits, and processed/paid records
 * are locked) — refreshing existing drafts remains the explicit
 * `POST /api/staff/payroll/generate` action.
 *
 * Best-effort by design: callers wrap this so a sync hiccup never blocks a
 * read or a staff write.
 */
export async function ensurePayrollDrafts(
  propertyId: string,
  year: number,
  month: number
): Promise<{ created: number }> {
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
    db.payrollRecord.findMany({ where: { propertyId, year, month }, select: { staffId: true } }),
  ]);

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const tally = tallyAttendance(rows);
  const have = new Set(existingRecords.map((r) => r.staffId));

  let created = 0;
  for (const s of activeStaff) {
    if (have.has(s.id)) continue;
    const t = tally.get(s.id) ?? newTally();
    const deductions = attendanceDeductions(s.salary, t, daysInMonth);
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
        netPay: round2(s.salary - deductions),
        presentDays: t.present,
        halfDays: t.half,
        leaveDays: t.leave,
        absentDays: t.absent,
        status: "draft",
      },
    });
    created += 1;
  }

  return { created };
}

/**
 * Keep ONE staff member's draft record for a cycle aligned with their HR
 * profile (called after salary changes): refresh baseSalary on a draft and
 * recompute netPay preserving the manual components. A processed or paid
 * record is never touched, and a missing draft is created so the staff member
 * shows up in payroll right away.
 */
export async function syncStaffPayrollDraft(
  propertyId: string,
  staffId: string,
  salary: number,
  year: number,
  month: number
): Promise<{ synced: boolean }> {
  const existing = await db.payrollRecord.findFirst({
    where: { propertyId, staffId, year, month },
  });

  if (existing && existing.status !== "draft") return { synced: false }; // processed/paid — frozen

  if (existing) {
    const netPay = round2(existing.baseSalary + existing.allowances + existing.bonus - existing.deductions - existing.advance);
    if (existing.baseSalary === salary && existing.netPay === netPay) return { synced: false };
    await db.payrollRecord.update({
      where: { id: existing.id },
      data: { baseSalary: salary, netPay: round2(salary + existing.allowances + existing.bonus - existing.deductions - existing.advance) },
    });
    return { synced: true };
  }

  // No record yet — create a draft so the staff member is visible instantly.
  const mm = String(month).padStart(2, "0");
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-31`;
  const rows = await db.staffAttendance.findMany({
    where: { propertyId, staffId, date: { gte: from, lte: to } },
    select: { status: true },
  });
  const t = tallyAttendance(rows).get(staffId) ?? newTally();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const deductions = attendanceDeductions(salary, t, daysInMonth);
  await db.payrollRecord.create({
    data: {
      propertyId,
      staffId,
      year,
      month,
      baseSalary: salary,
      allowances: 0,
      deductions,
      advance: 0,
      bonus: 0,
      netPay: round2(salary - deductions),
      presentDays: t.present,
      halfDays: t.half,
      leaveDays: t.leave,
      absentDays: t.absent,
      status: "draft",
    },
  });
  return { synced: true };
}
