import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { startOfDay, endOfDay } from "@/lib/business";
import { buildSummary, parseDayParam, csvRow, csvResponse, dayKey } from "../_shared";
import { getTenantEntitlements, requireFeature } from "@/lib/entitlements";

const EXPORT_TYPES = ["revenue", "occupancy", "folio"] as const;
type ExportType = (typeof EXPORT_TYPES)[number];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: Excel/CSV export is a Pro+ feature.
  const ent = await getTenantEntitlements(propertyId);
  const locked = requireFeature(ent, "excel_export", "Report export (Excel)");
  if (locked) return locked;

  const sp = req.nextUrl.searchParams;
  const type = (sp.get("type") ?? "revenue") as ExportType;
  if (!EXPORT_TYPES.includes(type)) {
    return NextResponse.json({ error: `Invalid type — expected one of ${EXPORT_TYPES.join(", ")}` }, { status: 400 });
  }

  const fromRaw = sp.get("from") ?? "";
  const toRaw = sp.get("to") ?? "";
  if ((fromRaw && !parseDayParam(fromRaw)) || (toRaw && !parseDayParam(toRaw))) {
    return NextResponse.json({ error: "Invalid date range — expected YYYY-MM-DD" }, { status: 400 });
  }

  const from = startOfDay(parseDayParam(fromRaw) ?? new Date(Date.now() - 13 * 86400000));
  const to = endOfDay(parseDayParam(toRaw) ?? new Date());
  const filename = `velurex-${type}-${dayKey(from)}-${dayKey(to)}.csv`;

  try {
    let body: string;

    if (type === "revenue" || type === "occupancy") {
      const { rows, totals, channelMix } = await buildSummary(propertyId, dayKey(from), dayKey(to), { comparison: false });
      if (type === "revenue") {
        body = [
          csvRow(["Date", "Room Revenue", "F&B Revenue", "Misc Revenue", "Total Revenue", "Occupancy %", "ADR", "RevPAR", "No-Shows"]),
          ...rows.map((r) =>
            csvRow([r.date, r.roomRevenue, r.fnbRevenue, r.miscRevenue, r.totalRevenue, r.occupancyPercent, r.adr, r.revpar, r.noShowCount])
          ),
          csvRow([]),
          csvRow(["Range Totals"]),
          csvRow(["Total Revenue", totals.revenue, "Room", totals.room, "F&B", totals.fnb, "Misc", totals.misc]),
          csvRow(["Avg Occupancy %", totals.avgOccupancy, "Avg ADR", totals.avgAdr, "Avg RevPAR", totals.avgRevpar, "No-Shows", totals.noShows]),
          csvRow([]),
          csvRow(["Channel Mix", "Bookings", "Room Nights", "Room Revenue", "ADR"]),
          ...channelMix.map((c) =>
            csvRow([c.source, c.bookings, c.nights, c.roomRevenue, c.adr])
          ),
        ].join("\n");
      } else {
        body = [
          csvRow(["Date", "Occupied Rooms", "Total Rooms", "Occupancy %", "ADR", "RevPAR"]),
          ...rows.map((r) =>
            csvRow([r.date, r.occupiedRooms, r.totalRooms, r.occupancyPercent, r.adr, r.revpar])
          ),
        ].join("\n");
      }
    } else {
      // folio export — every folio item in the range
      const items = await db.folioItem.findMany({
        where: { propertyId, businessDate: { gte: from, lte: to } },
        orderBy: [{ businessDate: "asc" }, { createdAt: "asc" }],
        select: {
          businessDate: true,
          category: true,
          description: true,
          qty: true,
          rate: true,
          amount: true,
          reservation: { select: { confirmationNumber: true, guest: { select: { fullName: true } } } },
          guest: { select: { fullName: true } },
        },
      });
      body = [
        csvRow(["Date", "Category", "Description", "Qty", "Rate", "Amount", "Reservation", "Guest"]),
        ...items.map((i) =>
          csvRow([
            dayKey(i.businessDate),
            i.category,
            i.description,
            i.qty,
            i.rate,
            i.amount,
            i.reservation?.confirmationNumber ?? "",
            i.guest?.fullName ?? i.reservation?.guest?.fullName ?? "",
          ])
        ),
      ].join("\n");
    }

    return csvResponse(body, filename);
  } catch (e) {
    console.error("[reports/export]", e);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
