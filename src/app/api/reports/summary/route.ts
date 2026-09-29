import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { buildSummary } from "../_shared";

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";

  // buildSummary falls back to the trailing 14 days when params are absent/invalid
  if ((from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) || (to && !/^\d{4}-\d{2}-\d{2}$/.test(to))) {
    return NextResponse.json({ error: "Invalid date range — expected YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const summary = await buildSummary(propertyId, from, to);
    return NextResponse.json(summary);
  } catch (e) {
    console.error("[reports/summary]", e);
    return NextResponse.json({ error: "Could not build report summary" }, { status: 500 });
  }
}
