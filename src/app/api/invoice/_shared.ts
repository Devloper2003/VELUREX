/**
 * Shared Indian-GST invoice constants + helpers used by the per-reservation
 * invoice endpoint and the group consolidated invoice endpoint.
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * GST rate % per folio category — property policy: a single flat 5% slab on
 * every guest-facing charge (CGST 2.5% + SGST 2.5%). Discount / tax-adjust
 * buckets never attract GST.
 */
export const GST_BY_CATEGORY: Record<string, number> = {
  room: 5,
  bar: 5,
  no_show: 5,
  fnb: 5,
  laundry: 5,
  misc: 5,
  discount: 0,
  tax: 0,
};

/** Plausible SAC/HSN codes per category for the invoice line table. */
export const HSN_BY_CATEGORY: Record<string, string> = {
  room: "996311",
  no_show: "996311",
  fnb: "996331",
  bar: "996333",
  laundry: "998613",
  misc: "998519",
  discount: "—",
  tax: "—",
};

export interface TaxableLine {
  category: string;
  amount: number;
}

/**
 * Compute the GST breakup for a set of charge lines, netting `discountTotal`
 * against the room bucket first (room promos), then remaining buckets in
 * descending rate order — mirroring CGST §15 treatment of time-of-supply
 * discounts.
 */
export function buildTaxBreakup(lines: TaxableLine[], discountTotal = 0) {
  const byRate = new Map<number, { taxable: number; tax: number }>();
  for (const li of lines) {
    const gstRate = GST_BY_CATEGORY[li.category] ?? 0;
    const taxable = round2(li.amount);
    const cur = byRate.get(gstRate) ?? { taxable: 0, tax: 0 };
    cur.taxable = round2(cur.taxable + taxable);
    cur.tax = round2(cur.tax + (taxable * gstRate) / 100);
    byRate.set(gstRate, cur);
  }

  let discountLeft = round2(discountTotal);
  const roomBucket = byRate.get(GST_BY_CATEGORY.room);
  if (roomBucket && discountLeft > 0) {
    const applied = Math.min(roomBucket.taxable, discountLeft);
    roomBucket.taxable = round2(roomBucket.taxable - applied);
    roomBucket.tax = round2((roomBucket.taxable * GST_BY_CATEGORY.room) / 100);
    discountLeft = round2(discountLeft - applied);
  }
  for (const rate of [...byRate.keys()].sort((a, b) => b - a)) {
    if (discountLeft <= 0) break;
    const bucket = byRate.get(rate)!;
    const applied = Math.min(bucket.taxable, discountLeft);
    bucket.taxable = round2(bucket.taxable - applied);
    bucket.tax = round2((bucket.taxable * rate) / 100);
    discountLeft = round2(discountLeft - applied);
  }

  return [...byRate.entries()]
    .filter(([, v]) => v.taxable > 0 || v.tax > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([gstRate, v]) => ({ gstRate, taxable: v.taxable, tax: round2(v.tax) }));
}
