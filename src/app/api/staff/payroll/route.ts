import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Current year/month in Asia/Kolkata (property timezone). */
function currentYearMonth(): { year: number; month: number } {
  const ym = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).slice(0, 7); // yyyy-mm
  const [y, m] = ym.split("-");
  return { year: Number(y), month: Number(m) };
}

/**
 * GET /api/staff/payroll?year=2026&month=2
 * Payroll register for one cycle: records joined with staff + cycle summary.
 * Roles: hotel_admin.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const fallback = currentYearMonth();
  const year = Number(req.nextUrl.searchParams.get("year") ?? fallback.year);
  const month = Number(req.nextUrl.searchParams.get("month") ?? fallback.month);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: "year (2000-2100) and month (1-12) are required as valid numbers" }, { status: 400 });
  }

  const records = await db.payrollRecord.findMany({
    where: { propertyId, year, month },
    orderBy: [{ status: "asc" }, { staffId: "asc" }],
    include: {
      staff: { select: { name: true, designation: true, department: true, email: true, active: true } },
    },
  });

  const totalNet = round2(records.reduce((s, r) => s + r.netPay, 0));
  const paid = round2(records.filter((r) => r.status === "paid").reduce((s, r) => s + r.netPay, 0));
  const pending = round2(records.filter((r) => r.status !== "paid").reduce((s, r) => s + r.netPay, 0));

  return NextResponse.json({
    year,
    month,
    records,
    summary: { totalNet, paid, pending, headcount: records.length },
  });
}
