import { db } from "@/lib/db";
import { rateForDate } from "@/lib/business";

/**
 * Room-inventory core — the source of truth behind the Inventory Control grid.
 *
 * Rows are lazily seeded for the requested window: `availableCount` starts at
 * the live internal availability for that night (type capacity − overlapping
 * active reservations) and `rate` at the plan-derived nightly rate. From then
 * on the row is staff-controlled: open/close flips and rate edits win, and the
 * booking engine + channels read the same state.
 */

export const isoDate = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const addDays = (d: Date, n: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export interface GridCell {
  inventoryId: string;
  date: string;
  availableCount: number;
  capacity: number;
  isOpen: boolean;
  rate: number;
  rateOverride: boolean;
  /** 0 = none, else number of pending push jobs for this cell. */
  pending: number;
  /** permanently failed push jobs (retryable) */
  failed: number;
}

export interface GridRow {
  roomTypeId: string;
  name: string;
  code: string;
  capacity: number;
  cells: GridCell[];
}

export interface GridPayload {
  dates: string[];
  rows: GridRow[];
  summary: {
    totalRooms: number;
    openToday: number;
    closedToday: number;
    syncing: number;
    failed: number;
    channelsConnected: number;
    channelsActive: number;
  };
}

/** Build the availability grid for `days` starting today. */
export async function buildInventoryGrid(propertyId: string, days: 30 | 60 | 90): Promise<GridPayload> {
  const today = new Date();
  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(isoDate(addDays(today, i)));
  const windowStart = addDays(today, -1); // reservations overlapping yesterday might cover tonight
  const windowEnd = addDays(today, days + 1);

  const [roomTypes, rooms, activeReservations, existing, connections, pendingJobs, failedJobs] = await Promise.all([
    db.roomType.findMany({ where: { propertyId }, orderBy: { baseRate: "asc" } }),
    db.room.findMany({ where: { propertyId }, select: { roomTypeId: true } }),
    db.reservation.findMany({
      where: {
        propertyId,
        status: { in: ["confirmed", "checked_in", "hold"] },
        checkIn: { lt: windowEnd },
        checkOut: { gt: windowStart },
      },
      select: { roomTypeId: true, checkIn: true, checkOut: true },
    }),
    db.roomInventory.findMany({
      where: { propertyId, date: { in: dates } },
      include: { roomType: { select: { name: true, code: true } } },
    }),
    db.channelConnection.findMany({ where: { propertyId } }),
    db.channelSyncJob.groupBy({
      by: ["roomInventoryId", "status"],
      where: { propertyId, status: { in: ["pending", "processing"] }, inventory: { date: { in: dates } } },
      _count: { _all: true },
    }),
    db.channelSyncJob.findMany({
      where: { propertyId, status: "failed", inventory: { date: { in: dates } } },
      select: { id: true, roomInventoryId: true },
    }),
  ]);

  // Capacity + booked-count maps per room type
  const capacityByType = new Map<string, number>();
  for (const rt of roomTypes) capacityByType.set(rt.id, rooms.filter((r) => r.roomTypeId === rt.id).length);

  const bookedByTypeDate = new Map<string, number>(); // `${rtId}|${iso}` → booked rooms
  for (const res of activeReservations) {
    if (!res.roomTypeId) continue;
    const start = isoDate(res.checkIn);
    const end = isoDate(res.checkOut);
    for (const d of dates) {
      if (d >= start && d < end) {
        const key = `${res.roomTypeId}|${d}`;
        bookedByTypeDate.set(key, (bookedByTypeDate.get(key) ?? 0) + 1);
      }
    }
  }

  // Rate plans for default rates
  const plans = await db.ratePlan.findMany({ where: { propertyId, active: true } });
  const planForType = (roomTypeId: string) =>
    plans.find((p) => p.roomTypeId === roomTypeId && p.baseRate > 0)
      ?? plans.find((p) => !p.roomTypeId && p.baseRate > 0)
      ?? null;

  // Existing rows keyed by `${roomTypeId}|${date}`
  const existingKey = new Map<string, (typeof existing)[number]>();
  for (const row of existing) existingKey.set(`${row.roomTypeId}|${row.date}`, row);

  // Seed missing rows (lazy provisioning — first grid load provisions the window)
  const missing: { propertyId: string; roomTypeId: string; date: string; availableCount: number; isOpen: boolean; rate: number }[] = [];
  for (const rt of roomTypes) {
    const capacity = capacityByType.get(rt.id) ?? 0;
    const plan = planForType(rt.id);
    for (const d of dates) {
      if (existingKey.has(`${rt.id}|${d}`)) continue;
      const booked = bookedByTypeDate.get(`${rt.id}|${d}`) ?? 0;
      const rate = rateForDate(rt.baseRate, plan, new Date(`${d}T12:00:00`));
      missing.push({
        propertyId,
        roomTypeId: rt.id,
        date: d,
        availableCount: Math.max(0, capacity - booked),
        isOpen: true,
        rate: Math.round(rate * 100) / 100,
      });
    }
  }
  if (missing.length > 0) {
    await db.roomInventory.createMany({ data: missing });
    for (const m of missing) {
      existingKey.set(`${m.roomTypeId}|${m.date}`, {
        id: `pending-${m.roomTypeId}-${m.date}`,
        propertyId, roomTypeId: m.roomTypeId, date: m.date,
        availableCount: m.availableCount, isOpen: m.isOpen, rate: m.rate,
        roomType: { name: "", code: "" },
      } as (typeof existing)[number]);
    }
  }

  // Job counters per inventory row
  const pendingByInv = new Map<string, number>();
  for (const g of pendingJobs) {
    if (g.roomInventoryId) pendingByInv.set(g.roomInventoryId, (pendingByInv.get(g.roomInventoryId) ?? 0) + (g._count?._all ?? 0));
  }
  const failedByInv = new Map<string, number>();
  for (const j of failedJobs) failedByInv.set(j.roomInventoryId, (failedByInv.get(j.roomInventoryId) ?? 0) + 1);

  const rows: GridRow[] = roomTypes.map((rt) => {
    const capacity = capacityByType.get(rt.id) ?? 0;
    const cells: GridCell[] = dates.map((d) => {
      const row = existingKey.get(`${rt.id}|${d}`);
      if (row && !row.id.startsWith("pending-")) {
        return {
          inventoryId: row.id,
          date: d,
          availableCount: row.availableCount,
          capacity,
          isOpen: row.isOpen,
          rate: row.rate ?? rateForDate(rt.baseRate, planForType(rt.id), new Date(`${d}T12:00:00`)),
          rateOverride: row.rate != null,
          pending: pendingByInv.get(row.id) ?? 0,
          failed: failedByInv.get(row.id) ?? 0,
        };
      }
      const booked = bookedByTypeDate.get(`${rt.id}|${d}`) ?? 0;
      return {
        inventoryId: row?.id ?? "",
        date: d,
        availableCount: Math.max(0, capacity - booked),
        capacity,
        isOpen: row?.isOpen ?? true,
        rate: row?.rate ?? rateForDate(rt.baseRate, planForType(rt.id), new Date(`${d}T12:00:00`)),
        rateOverride: row?.rate != null,
        pending: 0,
        failed: 0,
      };
    });
    return { roomTypeId: rt.id, name: rt.name, code: rt.code, capacity, cells };
  });

  // Summary bar
  const todayISO = dates[0];
  const totalRooms = rooms.length;
  let openToday = 0, closedToday = 0;
  for (const row of rows) {
    const c = row.cells[0];
    if (c && c.date === todayISO) {
      if (c.isOpen) openToday += Math.min(c.availableCount, row.capacity);
      else closedToday += row.capacity;
    }
  }
  const syncing = pendingByInv.size > 0 ? Array.from(pendingByInv.values()).reduce((a, b) => a + b, 0) : 0;
  const failed = Array.from(failedByInv.values()).reduce((a, b) => a + b, 0);
  const channelsConnected = connections.filter((c) => c.status === "connected").length;
  const channelsActive = connections.filter((c) => c.isActive && c.status === "connected").length;

  return {
    dates,
    rows,
    summary: { totalRooms, openToday, closedToday, syncing, failed, channelsConnected, channelsActive },
  };
}
