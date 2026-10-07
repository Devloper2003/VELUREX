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

// ─── Print documents for the remaining POS surfaces ─────────────────────────

/** Structural shape needed to render a kitchen ticket (superset-compatible with the POS table rows). */
export interface KotPrintItem {
  name: string;
  qty: number;
  notes?: string | null;
  taxRate?: number | null;
}

export interface KotPrintOrder {
  orderNumber: string;
  createdAt: string;
  orderType: string;
  tableNumber?: string | null;
  roomNumber?: string | null;
  subtotal: number;
  discountMode?: string;
  discountValue?: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  items: KotPrintItem[];
}

function kotTypeLine(order: KotPrintOrder): string {
  if (order.orderType === "dine_in") return `Table ${order.tableNumber || "—"}`;
  if (order.orderType === "room_service") return `Room ${order.roomNumber || "—"}`;
  return "Takeaway";
}

function kotRateLabels(order: KotPrintOrder): { cgst: string; sgst: string } {
  const rates = new Set(order.items.map((i) => i.taxRate ?? 5));
  const uniform = rates.size === 1 ? [...rates][0] : null;
  return uniform === null
    ? { cgst: "CGST", sgst: "SGST" }
    : { cgst: `CGST @ ${uniform / 2}%`, sgst: `SGST @ ${uniform / 2}%` };
}

const PRINT_RECEIPT_CSS = `
  @page { margin: 8mm; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: 'Courier New', ui-monospace, monospace; color: #1c2622; background: #fff;
    margin: 0 auto; max-width: 78mm; font-size: 13px; line-height: 1.35; }
  .c { text-align: center; }
  .brand { font-size: 14px; font-weight: 700; letter-spacing: 2.5px; text-transform: uppercase; color: #0f2622; }
  .kicker { font-size: 9px; font-weight: 700; letter-spacing: 4px; text-transform: uppercase; color: #b9873e; }
  .ono { font-size: 26px; font-weight: 800; letter-spacing: 1px; color: #0f2622; }
  .sub { font-size: 11px; color: #6d6a5c; }
  .hr { border-top: 1px dashed #9a8f76; margin: 8px 0; }
  .row { display: flex; justify-content: space-between; gap: 8px; }
  .row .k { color: #55503f; }
  .qty { width: 26px; text-align: right; font-weight: 700; color: #b9873e; flex-shrink: 0; }
  .item { display: flex; gap: 8px; align-items: baseline; }
  .note { margin: 1px 0 0 34px; font-size: 11px; font-style: italic; color: #a1541d; }
  .total { border-top: 1px solid #1c2622; padding-top: 6px; font-weight: 800; text-transform: uppercase; letter-spacing: 1px; }
  .grand { font-size: 16px; color: #0f2622; }
  .foot { text-align: center; font-size: 9px; letter-spacing: 2px; text-transform: uppercase; color: #6d6a5c; }
`;

/**
 * Thermal-style KOT / receipt document — mirrors the on-screen KotReceipt and
 * prints on both 80mm thermal rolls and A4 (narrow, centered).
 */
export function kotPrintHtml(order: KotPrintOrder, propertyName: string): string {
  const items = order.items
    .map(
      (i) => `<div class="item"><span class="qty">${i.qty}×</span><span>${esc(i.name)}</span></div>${
        i.notes ? `<p class="note">↳ ${esc(i.notes)}</p>` : ""
      }`
    )
    .join("");
  const labels = kotRateLabels(order);
  const cgst = splitHalf(order.taxAmount);
  const time = new Date(order.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(order.orderNumber)}</title><style>${PRINT_RECEIPT_CSS}</style></head>
<body>
  <div class="c">
    <div class="brand">${esc(propertyName || "Restaurant")}</div>
    <div class="kicker">Kitchen Order Ticket</div>
    <div class="ono">${esc(order.orderNumber)}</div>
    <div class="sub">${esc(time)} · ${esc(kotTypeLine(order))}</div>
  </div>
  <div class="hr"></div>
  ${items}
  <div class="hr"></div>
  <div class="row"><span class="k">Gross amount</span><span>${money2(order.subtotal)}</span></div>
  ${order.discountAmount > 0 ? `<div class="row"><span class="k">${esc(discountLabel(order.discountMode ?? "none", order.discountValue ?? 0))}</span><span>−${money2(order.discountAmount)}</span></div>` : ""}
  <div class="row"><span class="k">Taxable value</span><span>${money2(order.subtotal - order.discountAmount)}</span></div>
  <div class="row"><span class="k">${esc(labels.cgst)}</span><span>${money2(cgst)}</span></div>
  <div class="row"><span class="k">${esc(labels.sgst)}</span><span>${money2(order.taxAmount - cgst)}</span></div>
  <div class="hr"></div>
  <div class="row total grand"><span>Total (incl. GST)</span><span>${money2(order.totalAmount)}</span></div>
  <div class="hr"></div>
  <p class="foot">Computer-generated · Velurex HMS POS</p>
</body></html>`;
}

/** Shape of the POS day-stats object needed for the Z-report print. */
export interface DayStatsPrint {
  count: number;
  unpaid: number;
  gross: number;
  discount: number;
  taxable: number;
  tax: number;
  net: number;
  byMethod: [string, number][];
}

/**
 * Day Sales Summary (Z-report) print document — same figures as the on-screen
 * dialog, with the CGST/SGST collection split an auditor expects.
 */
export function daySummaryPrintHtml(
  stats: DayStatsPrint,
  hotel: { name?: string; gstin?: string },
  propertyName: string
): string {
  const cgst = splitHalf(stats.tax);
  const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const methods = stats.byMethod.length
    ? stats.byMethod
        .map(
          ([m, amt]) =>
            `<div class="row"><span class="k">${esc(m)}</span><span>${money2(amt)}</span></div>`
        )
        .join("")
    : `<p class="sub">No settled payments yet today.</p>`;

  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>Day Sales Summary — Z-Report</title><style>${PRINT_RECEIPT_CSS}</style></head>
<body>
  <div class="c">
    <div class="brand">${esc(hotel.name || propertyName || "Restaurant")}</div>
    <div class="kicker">Day Sales Summary (Z-Report)</div>
    <div class="sub">${esc(today)} · GSTIN ${esc(hotel.gstin) || "—"}</div>
  </div>
  <div class="hr"></div>
  <div class="row"><span class="k">Orders</span><span>${stats.count}</span></div>
  <div class="row"><span class="k">Gross amount</span><span>${money2(stats.gross)}</span></div>
  ${stats.discount > 0 ? `<div class="row"><span class="k">Discounts given</span><span>−${money2(stats.discount)}</span></div>` : ""}
  <div class="row"><span class="k">Taxable value</span><span>${money2(stats.taxable)}</span></div>
  <div class="row"><span class="k">CGST collected</span><span>${money2(cgst)}</span></div>
  <div class="row"><span class="k">SGST collected</span><span>${money2(stats.tax - cgst)}</span></div>
  <div class="hr"></div>
  <div class="row total grand"><span>Net sales (incl. GST)</span><span>${money2(stats.net)}</span></div>
  <div class="hr"></div>
  <div class="kicker" style="letter-spacing:2px">Collections by method</div>
  ${methods}
  ${stats.unpaid > 0 ? `<p class="note" style="margin-left:0">${stats.unpaid} order(s) still unpaid / unsettled.</p>` : ""}
  <div class="hr"></div>
  <p class="foot">Computer-generated report · Velurex HMS POS</p>
</body></html>`;
}
