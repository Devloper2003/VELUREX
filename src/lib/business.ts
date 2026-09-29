import { db } from "@/lib/db";
import { emitRealtime } from "@/lib/realtime-server";

export async function logActivity(o: {
  propertyId: string;
  staffId?: string;
  staffName?: string;
  action: string;
  entity?: string;
  entityId?: string;
  details?: string;
}) {
  const entry = await db.activityLog.create({
    data: {
      propertyId: o.propertyId,
      staffId: o.staffId || "",
      staffName: o.staffName || "",
      action: o.action,
      entity: o.entity || "",
      entityId: o.entityId || "",
      details: o.details || "",
    },
  });
  // Live-push every activity log entry to connected clients (best-effort).
  emitRealtime("global", "activity:new", {
    id: entry.id,
    action: entry.action,
    details: entry.details,
    staffName: entry.staffName,
    createdAt: entry.createdAt,
  });
  return entry;
}

/** Resolve nightly rate for a date given room type + optional rate plan (seasonal / weekend aware). */
export function rateForDate(baseRate: number, plan: { weekendRate?: number | null; seasonalStart?: Date | null; seasonalEnd?: Date | null; seasonalRate?: number | null; baseRate?: number } | null, date: Date): number {
  if (!plan) return baseRate;
  const day = date.getDay();
  if (plan.weekendRate && (day === 5 || day === 6 || day === 0)) return plan.weekendRate;
  if (plan.seasonalRate && plan.seasonalStart && plan.seasonalEnd) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const s = new Date(plan.seasonalStart.getFullYear(), plan.seasonalStart.getMonth(), plan.seasonalStart.getDate()).getTime();
    const e = new Date(plan.seasonalEnd.getFullYear(), plan.seasonalEnd.getMonth(), plan.seasonalEnd.getDate()).getTime();
    if (d >= s && d <= e) return plan.seasonalRate;
  }
  return plan.baseRate && plan.baseRate > 0 ? plan.baseRate : baseRate;
}

export function nextConfirmationNumber(prefix = "RG"): string {
  return `${prefix}-${Date.now().toString().slice(-8)}`;
}

export function nextOrderNumber(): string {
  return `ORD-${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 90 + 10)}`;
}

export function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

export const GST_RATE = 12; // hotel accommodation GST (>₹7,500 room rate; simplified flat rate for demo)
