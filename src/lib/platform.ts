import { db } from "@/lib/db";
import { decryptJSON } from "@/lib/crypto";

/**
 * Platform-side helpers: audit trail, settings, invoice numbering.
 * Used by /api/owner/* routes and the daily jobs.
 */

export async function logPlatformAction(o: {
  actorId?: string;
  actorName: string;
  action: string;
  entity?: string;
  entityId?: string;
  details?: string;
  propertyId?: string;
}) {
  await db.platformAuditLog.create({
    data: {
      actorId: o.actorId ?? "",
      actorName: o.actorName,
      action: o.action,
      entity: o.entity ?? "",
      entityId: o.entityId ?? "",
      details: o.details ?? "",
      propertyId: o.propertyId ?? "",
    },
  });
}

/** Read a platform setting (decrypts when encrypted). */
export async function getPlatformSetting(key: string): Promise<string | null> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  if (!row) return null;
  if (!row.encrypted) return row.value;
  return decryptJSON<{ v?: string }>(row.value).v ?? null;
}

export async function getPlatformSettingNumber(key: string, fallback: number): Promise<number> {
  const v = await getPlatformSetting(key);
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Upsert a platform setting (encrypts when sensitive=true). */
export async function setPlatformSetting(key: string, value: string, o?: {
  encrypted?: boolean;
  updatedBy?: string;
}) {
  await db.platformSetting.upsert({
    where: { key },
    create: { key, value, encrypted: o?.encrypted ?? false, updatedBy: o?.updatedBy ?? "" },
    update: { value, encrypted: o?.encrypted ?? false, updatedBy: o?.updatedBy ?? "" },
  });
}

/** Next sequential GST invoice number: VXL-<year>-<0001>. */
export async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `VXL-${year}-`;
  const last = await db.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: "desc" },
  });
  const lastSeq = last ? parseInt(last.number.slice(prefix.length), 10) : 0;
  return `${prefix}${String((Number.isFinite(lastSeq) ? lastSeq : 0) + 1).padStart(4, "0")}`;
}

/** GST rate for platform invoices (default 18). */
export async function platformGstRate(): Promise<number> {
  const v = await getPlatformSettingNumber("gst_rate", 18);
  return v;
}

/** Effective per-cycle price for a plan (applies configured cycle discounts). */
export async function cyclePrice(planMonthly: number, cycle: string): Promise<number> {
  if (cycle === "yearly") {
    const disc = await getPlatformSettingNumber("yearly_discount_percent", 10);
    return Math.round(planMonthly * 12 * (1 - disc / 100));
  }
  if (cycle === "quarterly") {
    const disc = await getPlatformSettingNumber("quarterly_discount_percent", 5);
    return Math.round(planMonthly * 3 * (1 - disc / 100));
  }
  return planMonthly;
}
