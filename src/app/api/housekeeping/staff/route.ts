import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/** GET /api/housekeeping/staff — active housekeeping staff for assignment dropdowns. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk", "housekeeping"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const staff = await db.staff.findMany({
    where: { propertyId, role: "housekeeping", active: true },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return NextResponse.json({ staff });
}
