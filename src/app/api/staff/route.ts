import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/staff — HR directory for the session property.
 * Returns login + HR fields only; passwordHash / TOTP secrets never leave the server.
 * Roles: hotel_admin (HR management is an admin function).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const staff = await db.staff.findMany({
    where: { propertyId },
    orderBy: [{ department: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      designation: true,
      department: true,
      salary: true,
      joinDate: true,
      active: true,
    },
  });

  return NextResponse.json({ staff });
}
