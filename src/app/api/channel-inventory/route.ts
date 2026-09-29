import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { buildInventoryGrid } from "@/lib/inventory-core";
import { enqueueChannelJobs, retryChannelJob } from "@/lib/channel-worker";
import { logActivity } from "@/lib/business";

/**
 * GET /api/channel-inventory?days=30|60|90 — the Inventory Control grid:
 * room types × dates with availability, open/close state, channel rate and
 * per-cell push status (pending/failed job counters).
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;

  const daysParam = Number(new URL(req.url).searchParams.get("days") ?? 30);
  const days = (daysParam === 60 || daysParam === 90 ? daysParam : 30) as 30 | 60 | 90;

  const grid = await buildInventoryGrid(auth.session.propertyId, days);
  return NextResponse.json(grid);
}

/**
 * POST /api/channel-inventory — single-cell toggle, count edit or bulk apply.
 * Body:
 *   { mode: "toggle", roomTypeId, date }                    → flip open/close (one cell)
 *   { mode: "count",  roomTypeId, date, availableCount }    → manual room-count edit (one cell)
 *   { mode: "bulk", roomTypeIds: [], dateFrom, dateTo, isOpen } → set open/close across a rectangle
 *   { mode: "bulk-count", roomTypeIds: [], dateFrom, dateTo, availableCount }
 *   { mode: "rate",  roomTypeId, date, rate }               → set channel rate (one cell)
 *   { mode: "bulk-rate", roomTypeIds: [], dateFrom, dateTo, rate }
 *
 * Every affected row is upserted and pushed to all connected+active channels
 * via the async queue — the response returns immediately with a queued count.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    mode?: "toggle" | "bulk" | "rate" | "bulk-rate" | "count" | "bulk-count";
    roomTypeId?: string;
    roomTypeIds?: string[];
    date?: string;
    dateFrom?: string;
    dateTo?: string;
    isOpen?: boolean;
    rate?: number;
    availableCount?: number;
  } | null;
  if (!body?.mode) return NextResponse.json({ error: "mode is required" }, { status: 400 });

  const roomTypes = await db.roomType.findMany({
    where: { propertyId },
    orderBy: { baseRate: "asc" },
    select: { id: true, name: true, code: true, baseRate: true },
  });
  const typeById = new Map(roomTypes.map((rt) => [rt.id, rt]));

  // Resolve the affected room types × dates rectangle
  let typeIds: string[] = [];
  let dates: string[] = [];
  let isOpen: boolean | null = null;
  let rate: number | null = null;
  let availableCount: number | null = null;

  if (body.mode === "toggle") {
    if (!body.roomTypeId || !body.date) return NextResponse.json({ error: "roomTypeId and date are required" }, { status: 400 });
    typeIds = [body.roomTypeId];
    dates = [body.date];
  } else if (body.mode === "rate") {
    if (!body.roomTypeId || !body.date) return NextResponse.json({ error: "roomTypeId and date are required" }, { status: 400 });
    const r = Number(body.rate);
    if (!Number.isFinite(r) || r < 0) return NextResponse.json({ error: "rate must be a positive number" }, { status: 400 });
    typeIds = [body.roomTypeId];
    dates = [body.date];
    rate = Math.round(r * 100) / 100;
  } else if (body.mode === "count") {
    if (!body.roomTypeId || !body.date) return NextResponse.json({ error: "roomTypeId and date are required" }, { status: 400 });
    const c = Number(body.availableCount);
    if (!Number.isInteger(c) || c < 0) return NextResponse.json({ error: "availableCount must be a non-negative whole number" }, { status: 400 });
    typeIds = [body.roomTypeId];
    dates = [body.date];
    availableCount = c;
  } else if (body.mode === "bulk" || body.mode === "bulk-rate" || body.mode === "bulk-count") {
    typeIds = (body.roomTypeIds ?? (body.roomTypeId ? [body.roomTypeId] : [])).filter((t) => typeById.has(t));
    if (typeIds.length === 0) return NextResponse.json({ error: "At least one room type is required" }, { status: 400 });
    if (body.mode === "bulk") {
      if (typeof body.isOpen !== "boolean") return NextResponse.json({ error: "isOpen is required for bulk mode" }, { status: 400 });
      isOpen = body.isOpen;
    } else if (body.mode === "bulk-rate") {
      const r = Number(body.rate);
      if (!Number.isFinite(r) || r < 0) return NextResponse.json({ error: "rate must be a positive number" }, { status: 400 });
      rate = Math.round(r * 100) / 100;
    } else {
      const c = Number(body.availableCount);
      if (!Number.isInteger(c) || c < 0) return NextResponse.json({ error: "availableCount must be a non-negative whole number" }, { status: 400 });
      availableCount = c;
    }
    if (!body.dateFrom || !body.dateTo || body.dateFrom > body.dateTo) {
      return NextResponse.json({ error: "dateFrom ≤ dateTo is required" }, { status: 400 });
    }
    const MAX_DAYS = 90;
    const from = new Date(`${body.dateFrom}T12:00:00`);
    const to = new Date(`${body.dateTo}T12:00:00`);
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86400000) + 1;
    if (spanDays > MAX_DAYS) return NextResponse.json({ error: `Range is limited to ${MAX_DAYS} days` }, { status: 400 });
    for (let i = 0; i < spanDays; i++) {
      const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    }
  }

  const todayISO = (() => {
    const t = new Date();
    return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
  })();
  dates = dates.filter((d) => d >= todayISO);
  if (dates.length === 0) return NextResponse.json({ error: "Dates must be today or in the future" }, { status: 400 });

  // Load existing rows + live availability context for upserts
  const existingRows = await db.roomInventory.findMany({
    where: { propertyId, roomTypeId: { in: typeIds }, date: { in: dates } },
  });
  const existingKey = new Map(existingRows.map((r) => [`${r.roomTypeId}|${r.date}`, r]));

  const rooms = await db.room.findMany({ where: { propertyId }, select: { roomTypeId: true } });
  const activeRes = await db.reservation.findMany({
    where: {
      propertyId,
      status: { in: ["confirmed", "checked_in", "hold"] },
      checkIn: { lt: new Date(new Date(`${dates[dates.length - 1]}T12:00:00`).getTime() + 86400000) },
      checkOut: { gt: new Date(new Date(`${dates[0]}T12:00:00`).getTime() - 86400000) },
    },
    select: { roomTypeId: true, checkIn: true, checkOut: true },
  });

  const results: { inventoryId: string; roomTypeId: string; roomTypeName: string; date: string; isOpen: boolean; availableCount: number; rate: number | null; queued: number }[] = [];
  let totalQueued = 0;

  for (const typeId of typeIds) {
    const rt = typeById.get(typeId)!;
    const capacity = rooms.filter((r) => r.roomTypeId === typeId).length;
    for (const date of dates) {
      const dObj = new Date(`${date}T12:00:00`);
      let row = existingKey.get(`${typeId}|${date}`);
      if (!row) {
        const booked = activeRes.filter(
          (r) => r.roomTypeId === typeId && date >= isoOf(r.checkIn) && date < isoOf(r.checkOut)
        ).length;
        row = await db.roomInventory.create({
          data: {
            propertyId, roomTypeId: typeId, date,
            availableCount: Math.max(0, capacity - booked),
            isOpen: true,
            rate: rt.baseRate,
          },
        });
        existingKey.set(`${typeId}|${date}`, row);
      }

      const nextIsOpen = rate !== null || availableCount !== null ? row.isOpen : isOpen !== null ? isOpen : !row.isOpen;
      // Manual count edits are clamped to physical capacity — you cannot sell
      // 12 rooms of a 10-room type on any channel.
      const nextCount = availableCount !== null ? Math.max(0, Math.min(availableCount, capacity)) : row.availableCount;
      const nextRate = rate !== null ? rate : row.rate;

      const updated = await db.roomInventory.update({
        where: { id: row.id },
        data: { isOpen: nextIsOpen, rate: nextRate, availableCount: nextCount },
      });

      const action = rate !== null ? "rate_update" : nextIsOpen ? "open" : "close";
      const queued = await enqueueChannelJobs({
        propertyId,
        inventoryId: updated.id,
        action,
        payload: {
          dateISO: updated.date,
          roomTypeId: updated.roomTypeId,
          availableCount: updated.availableCount,
          isOpen: updated.isOpen,
          rate: updated.rate,
        },
      });
      totalQueued += queued;
      results.push({
        inventoryId: updated.id,
        roomTypeId: typeId,
        roomTypeName: rt.name,
        date,
        isOpen: updated.isOpen,
        availableCount: updated.availableCount,
        rate: updated.rate,
        queued,
      });
    }
  }

  const verb =
    rate !== null ? "rate update"
    : availableCount !== null ? "availability edit"
    : isOpen === null ? "toggle"
    : isOpen ? "open" : "close";
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: rate !== null ? "INVENTORY_RATE" : "INVENTORY_TOGGLE",
    entity: "RoomInventory",
    entityId: results[0]?.inventoryId ?? "",
    details: `${verb.charAt(0).toUpperCase() + verb.slice(1)} · ${results.length} room-type-day${results.length === 1 ? "" : "s"} across ${typeIds.length} room type${typeIds.length === 1 ? "" : "s"} — ${totalQueued} channel push${totalQueued === 1 ? "" : "es"} queued`,
  });

  return NextResponse.json({ ok: true, cells: results, queued: totalQueued });
}

/** POST /api/channel-inventory — retry variant for a failed job. */
export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;

  const body = (await req.json().catch(() => null)) as { jobId?: string } | null;
  if (!body?.jobId) return NextResponse.json({ error: "jobId is required" }, { status: 400 });

  const ok = await retryChannelJob(body.jobId, auth.session.propertyId);
  if (!ok) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
