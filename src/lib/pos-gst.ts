import { amountInWordsINR, CATEGORY_LABELS } from "@/lib/format";
import { esc, money2, splitHalf } from "@/lib/invoice-format";

/**
 * POS GST engine — one shared computation + one official restaurant tax-invoice
 * document, so the terminal, the KOT receipt and the printed guest bill all
 * mark GST exactly the way the folio tax invoice does:
 *
 *   taxable value → CGST @ 2.5% + SGST @ 2.5% (flat 5% slab) → grand total.
 *
 * A single discount applies BEFORE GST — mirroring CGST §15: tax is computed
 * on the discounted taxable value, never on the gross.
 */

export const round2 = (n: number) => Math.round(n * 100) / 100;

export type PosDiscountMode = "none" | "percent" | "flat";

export interface PosTaxedLine {
  price: number;
  qty: number;
  taxRate: number;
}

export interface PosTotals {
  subtotal: number;
  discountAmount: number;
  taxable: number;
  tax: number;
  total: number;
}

/** Clamp + compute a discount amount from a mode/value pair against gross. */
export function posDiscountAmount(
  mode: string,
  value: number,
  subtotal: number
): number {
  if (subtotal <= 0) return 0;
  if (mode === "percent") return round2((subtotal * Math.min(Math.max(value, 0), 100)) / 100);
  if (mode === "flat") return round2(Math.min(Math.max(value, 0), subtotal));
  return 0;
}

/**
 * Canonical POS bill math — used verbatim by the order API (authoritative)
 * and by the terminal (live preview), so the numbers can never diverge.
 * GST is charged per item on the line's share of the discounted taxable
 * value (proportional allocation across mixed rates).
 */
export function computePosTotals(
  lines: PosTaxedLine[],
  discountMode: string = "none",
  discountValue: number = 0
): PosTotals {
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const discountAmount = posDiscountAmount(discountMode, discountValue, subtotal);
  const ratio = subtotal > 0 && discountAmount > 0 ? discountAmount / subtotal : 0;
  let tax = 0;
  for (const l of lines) {
    tax += (l.price * l.qty * (1 - ratio) * l.taxRate) / 100;
  }
  tax = round2(tax);
  const taxable = round2(subtotal - discountAmount);
  return { subtotal, discountAmount, taxable, tax, total: round2(taxable + tax) };
}

/** Rate-level GST breakup for bills/summaries — mirrors the folio invoice's. */
export interface PosRateRow {
  gstRate: number;
  taxable: number;
  tax: number;
}

export function posRateBreakup(
  lines: (PosTaxedLine & { category?: string })[],
  discountAmount = 0
): PosRateRow[] {
  const subtotal = round2(lines.reduce((s, l) => s + l.price * l.qty, 0));
  const ratio = subtotal > 0 && discountAmount > 0 ? discountAmount / subtotal : 0;
  const byRate = new Map<number, { taxable: number; tax: number }>();
  for (const l of lines) {
    const rate = l.taxRate ?? 0;
    const taxable = round2(l.price * l.qty * (1 - ratio));
    const cur = byRate.get(rate) ?? { taxable: 0, tax: 0 };
    cur.taxable = round2(cur.taxable + taxable);
    cur.tax = round2(cur.tax + (taxable * rate) / 100);
    byRate.set(rate, cur);
  }
  return [...byRate.entries()]
    .filter(([rate]) => rate > 0)
    .sort((a, b) => a[0] - b[0])
    .map(([gstRate, v]) => ({ gstRate, taxable: v.taxable, tax: round2(v.tax) }));
}

// ─── Official restaurant tax invoice (standalone HTML, print / download) ─────

export interface PosHotel {
  name: string;
  address: string;
  city: string;
  state?: string;
  gstin: string;
  phone: string;
  email: string;
}

export interface PosBillItem {
  name: string;
  category?: string;
  qty: number;
  price: number;
  amount: number;
  taxRate?: number;
  notes?: string;
}

export interface PosBill {
  billNo: string;
  date: string;
  orderType: string;
  tableNumber: string;
  roomNumber: string;
  guestName: string;
  servedBy: string;
  hotel: PosHotel;
  items: PosBillItem[];
  subtotal: number;
  discountMode: string;
  discountValue: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  settledAt?: string | null;
}

const ORDER_TYPE_LABEL: Record<string, string> = {
  dine_in: "Dine-in",
  room_service: "Room Service",
  takeaway: "Takeaway",
};

export function discountLabel(mode: string, value: number): string {
  if (mode === "percent") return `Discount (${value}% off)`;
  if (mode === "flat") return "Discount (flat)";
  return "Discount";
}

/** Standalone styled HTML — same visual language as the folio tax invoice. */
export function posBillHtml(bill: PosBill): string {
  const dateStr = new Date(bill.date).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const placeOfSupply = bill.hotel.state || bill.hotel.city || "—";
  const lines = bill.items
    .map(
      (li, i) => `<tr>
        <td>${i + 1}</td>
        <td><b>${esc(li.name)}</b>${li.category ? `<br/><span class="dim">${esc(CATEGORY_LABELS[li.category] ?? li.category)}</span>` : ""}${li.notes ? `<br/><span class="dim">↳ ${esc(li.notes)}</span>` : ""}</td>
        <td class="r">${li.qty}</td>
        <td class="r">${money2(li.price)}</td>
        <td class="r">${money2(li.amount)}</td>
      </tr>`
    )
    .join("");

  const breakup = posRateBreakup(bill.items, bill.discountAmount)
    .map(
      (t) =>
        `<tr><td>GST @ ${t.gstRate}%</td><td class="r">${money2(t.taxable)}</td><td class="r">${money2(splitHalf(t.tax))}</td><td class="r">${money2(t.tax - splitHalf(t.tax))}</td><td class="r">${money2(t.tax)}</td></tr>`
    )
    .join("");

  const settled = bill.paymentStatus !== "unpaid";
  const payLine = settled
    ? `<tr><td>Payment</td><td class="r">${esc(bill.paymentMethod ? bill.paymentMethod.toUpperCase() : "ROOM FOLIO")}${bill.settledAt ? ` · ${new Date(bill.settledAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}</td></tr>`
    : `<tr><td>Payment</td><td class="r">DUE</td></tr>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(bill.billNo)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #26302c; background: #fbf8f2; margin: 40px auto; max-width: 720px; padding: 0 24px; }
  h1 { color: #1f4b43; font-size: 24px; margin: 0; }
  .tag { color: #b9873e; letter-spacing: 3px; font-size: 18px; font-weight: bold; }
  .head { border-bottom: 3px solid #1f4b43; padding-bottom: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .dim { color: #7a6f5d; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th { text-align: left; border-bottom: 2px solid #d3c3a4; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7a6f5d; }
  td { border-bottom: 1px solid #e3d7c1; padding: 8px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .grand { border-top: 3px solid #1f4b43; font-weight: bold; font-size: 16px; color: #1f4b43; }
  .cols { display: flex; justify-content: space-between; gap: 24px; margin-top: 16px; flex-wrap: wrap; }
  .panel { border: 1px solid #e3d7c1; border-radius: 8px; padding: 12px 16px; background: #fff; flex: 1; min-width: 240px; }
  .panel table { margin: 0; }
  .words { margin-top: 14px; border: 1px solid #e3d7c1; border-radius: 8px; background: #fff; padding: 10px 16px; font-style: italic; font-size: 13px; }
  .sig { margin-top: 30px; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; font-size: 12px; color: #26302c; align-items: flex-end; }
  .sig .line { border-top: 1px solid #26302c; padding-top: 4px; min-width: 180px; text-align: center; color: #7a6f5d; font-size: 11px; }
  .foot { margin-top: 26px; border-top: 1px solid #e3d7c1; padding-top: 10px; color: #7a6f5d; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div><h1>${esc(bill.hotel.name)}</h1><p class="dim">${esc(bill.hotel.address)}${bill.hotel.address ? ", " : ""}${esc(bill.hotel.city)}<br/>GSTIN: <b>${esc(bill.hotel.gstin) || "—"}</b>${bill.hotel.phone ? ` · Phone: ${esc(bill.hotel.phone)}` : ""}${bill.hotel.email ? ` · ${esc(bill.hotel.email)}` : ""}</p></div>
    <div style="text-align:right"><p class="tag">RESTAURANT TAX INVOICE</p><p class="dim">Bill No: <b style="color:#26302c">${esc(bill.billNo)}</b><br/>Date: ${dateStr}<br/>Place of Supply: <b style="color:#26302c">${esc(placeOfSupply)}</b></p></div>
  </div>
  <div class="cols">
    <div><p class="dim" style="margin:0 0 2px">GUEST / TABLE</p><b>${esc(bill.guestName || "Walk-in Guest")}</b><br/><span class="dim">${esc(ORDER_TYPE_LABEL[bill.orderType] ?? bill.orderType)}${bill.orderType === "dine_in" && bill.tableNumber ? ` · Table ${esc(bill.tableNumber)}` : ""}${bill.orderType === "room_service" && bill.roomNumber ? ` · Room ${esc(bill.roomNumber)}` : ""}${bill.servedBy ? ` · Served by ${esc(bill.servedBy)}` : ""}</span></div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead><tbody>${lines}</tbody></table>
  <div class="cols">
    <div class="panel">
      <p class="dim" style="margin:0 0 4px">GST SUMMARY (CGST + SGST)</p>
      <table><thead><tr><th>Rate</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Total</th></tr></thead><tbody>${breakup || `<tr><td colspan="5" class="dim">No taxable items</td></tr>`}</tbody></table>
    </div>
    <div class="panel">
      <table>
        <tr><td>Gross Amount</td><td class="r">${money2(bill.subtotal)}</td></tr>
        ${bill.discountAmount > 0 ? `<tr><td>${esc(discountLabel(bill.discountMode, bill.discountValue))}</td><td class="r">−${money2(bill.discountAmount)}</td></tr>` : ""}
        <tr><td>Taxable Value</td><td class="r">${money2(bill.subtotal - bill.discountAmount)}</td></tr>
        <tr><td>Total GST (CGST + SGST)</td><td class="r">${money2(bill.taxAmount)}</td></tr>
        <tr class="grand"><td>Grand Total</td><td class="r">${money2(bill.totalAmount)}</td></tr>
        ${payLine}
      </table>
    </div>
  </div>
  <div class="words"><b>Amount in words:</b> ${esc(amountInWordsINR(bill.totalAmount))}</div>
  <div class="sig">
    <p style="max-width:300px;font-size:11px;color:#7a6f5d">Declaration: We declare that this invoice shows the actual price of the food &amp; beverages served and that all particulars are true and correct. GST is charged on the discounted taxable value. This is a computer-generated bill.</p>
    <div style="text-align:center"><p style="margin:0"><b>For ${esc(bill.hotel.name)}</b></p><div style="height:44px"></div><p class="line" style="margin:0">Authorised Signatory</p></div>
  </div>
  <p class="foot">${esc(bill.hotel.name)} · GSTIN ${esc(bill.hotel.gstin) || "—"} · Bill ${esc(bill.billNo)} — Thank you! Visit again.</p>
</body></html>`;
}
