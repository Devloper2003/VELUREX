import { CATEGORY_LABELS, amountInWordsINR } from "@/lib/format";

/**
 * Shared GST tax-invoice primitives — payload types, money formatting and the
 * standalone HTML document builder. Used by BillingView (folios & groups) and
 * the Reservations view (openable invoice from any reservation row), so every
 * surface renders one identical, white-labeled invoice format.
 */

export interface InvoiceLine {
  id: string;
  date: string;
  category: string;
  description: string;
  hsn: string;
  qty: number;
  rate: number;
  taxable: number;
  gstRate: number;
  gstAmount: number;
}

export interface InvoicePayload {
  invoiceNo: string;
  date: string;
  hotel: { name: string; address: string; city: string; state: string; gstin: string; phone: string; email: string };
  billTo: { fullName: string; phone: string; email: string; address: string; city: string; idType: string; idNumber: string };
  reservation: {
    id: string;
    confirmationNumber: string;
    status: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    nightlyRate: number;
    groupCode: string;
    room: { number: string; roomType: { name: string } } | null;
  };
  lineItems: InvoiceLine[];
  promoDiscount: { code: string; amount: number; description: string } | null;
  discountTotal: number;
  taxBreakup: { gstRate: number; taxable: number; tax: number }[];
  subtotal: number;
  taxableTotal: number;
  totalTax: number;
  grandTotal: number;
  payments: { id: string; amount: number; method: string; reference: string; status: string; createdAt: string }[];
  paid: number;
  balance: number;
}

export const money2 = (n: number) =>
  `₹${(Number.isFinite(n) ? n : 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const splitHalf = (total: number): number => Math.round((total / 2) * 100) / 100;

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Footnote lines explaining billing adjustments on the invoice — promo
 * discounts and early-departure credits — shown on screen and in print.
 */
export function invoiceNotes(inv: InvoicePayload): string[] {
  const notes: string[] = [];
  if (inv.promoDiscount) {
    notes.push(
      `Promotional discount ${inv.promoDiscount.code} applied (−${money2(inv.discountTotal)}). GST is computed on the discounted taxable value.`
    );
  }
  const early = inv.lineItems.find((li) => li.description.startsWith("Early departure adjustment"));
  if (early) {
    notes.push(
      `Early departure — the stay was re-billed for nights actually stayed and ${Math.abs(early.qty)} night(s) not stayed were credited automatically.`
    );
  }
  const departurePosted = inv.lineItems.filter((li) => li.description.includes("departure posting"));
  if (departurePosted.length > 0) {
    notes.push("Unbilled stay nights were posted at departure (night audit had not yet billed them).");
  }
  return notes;
}

/** Standalone styled HTML for the white-labeled GST tax invoice (download / email). */
export function invoiceHtml(inv: InvoicePayload): string {
  const dateStr = new Date(inv.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const placeOfSupply = inv.hotel.state || inv.hotel.city || "—";
  const lines = inv.lineItems
    .map(
      (li, i) => `<tr>
        <td>${i + 1}</td>
        <td><b>${esc(li.description)}</b><br/><span class="dim">${esc(CATEGORY_LABELS[li.category] ?? li.category)} · ${new Date(li.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span></td>
        <td>${esc(li.hsn)}</td>
        <td class="r">${li.qty % 1 === 0 ? li.qty : li.qty.toFixed(2)}</td>
        <td class="r">${money2(li.rate)}</td>
        <td class="r">${money2(li.taxable)}</td>
        <td class="r">${li.gstRate}%</td>
        <td class="r">${money2(li.gstAmount)}</td>
      </tr>`
    )
    .join("");
  const breakup = inv.taxBreakup
    .map(
      (t) =>
        `<tr><td>GST @ ${t.gstRate}%</td><td class="r">${money2(t.taxable)}</td><td class="r">${money2(splitHalf(t.tax))}</td><td class="r">${money2(t.tax - splitHalf(t.tax))}</td><td class="r">${money2(t.tax)}</td></tr>`
    )
    .join("");
  const pays = inv.payments.length
    ? inv.payments
        .map(
          (p) => `<tr><td>${new Date(p.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${esc(p.method.toUpperCase())}${p.reference ? ` · ${esc(p.reference)}` : ""}</td><td class="r">${money2(p.amount)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="dim">No payments recorded</td></tr>`;
  const notesHtml = invoiceNotes(inv).length
    ? `<div class="panel" style="margin-top:14px"><p class="dim" style="margin:0 0 6px">BILLING NOTES</p><ul style="margin:0;padding-left:16px;font-size:12px;color:#26302c">${invoiceNotes(inv).map((n) => `<li style="margin-bottom:3px">${esc(n)}</li>`).join("")}</ul></div>`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(inv.invoiceNo)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #26302c; background: #fbf8f2; margin: 40px auto; max-width: 760px; padding: 0 24px; }
  h1 { color: #1f4b43; font-size: 26px; margin: 0; }
  .tag { color: #b9873e; letter-spacing: 3px; font-size: 18px; font-weight: bold; }
  .head { border-bottom: 3px solid #1f4b43; padding-bottom: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .dim { color: #7a6f5d; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th { text-align: left; border-bottom: 2px solid #d3c3a4; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7a6f5d; }
  td { border-bottom: 1px solid #e3d7c1; padding: 8px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .tot { font-size: 15px; }
  .grand { border-top: 3px solid #1f4b43; font-weight: bold; font-size: 17px; color: #1f4b43; }
  .cols { display: flex; justify-content: space-between; gap: 24px; margin-top: 16px; flex-wrap: wrap; }
  .panel { border: 1px solid #e3d7c1; border-radius: 8px; padding: 12px 16px; background: #fff; }
  .words { margin-top: 14px; border: 1px solid #e3d7c1; border-radius: 8px; background: #fff; padding: 10px 16px; font-style: italic; font-size: 13px; }
  .sig { margin-top: 34px; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; font-size: 12px; color: #26302c; align-items: flex-end; }
  .sig .line { border-top: 1px solid #26302c; padding-top: 4px; min-width: 180px; text-align: center; color: #7a6f5d; font-size: 11px; }
  .foot { margin-top: 28px; border-top: 1px solid #e3d7c1; padding-top: 10px; color: #7a6f5d; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div><h1>${esc(inv.hotel.name)}</h1><p class="dim">${esc(inv.hotel.address)}${inv.hotel.address ? ", " : ""}${esc(inv.hotel.city)}${inv.hotel.state ? ", " + esc(inv.hotel.state) : ""}<br/>GSTIN: <b>${esc(inv.hotel.gstin) || "—"}</b>${inv.hotel.phone ? ` · Phone: ${esc(inv.hotel.phone)}` : ""}${inv.hotel.email ? ` · ${esc(inv.hotel.email)}` : ""}</p></div>
    <div style="text-align:right"><p class="tag">TAX INVOICE</p><p class="dim">Invoice No: <b style="color:#26302c">${esc(inv.invoiceNo)}</b><br/>Date: ${dateStr}<br/>Place of Supply: <b style="color:#26302c">${esc(placeOfSupply)}</b></p></div>
  </div>
  <div class="cols">
    <div><p class="dim" style="margin:0">BILL TO</p><b>${esc(inv.billTo.fullName)}</b><br/><span class="dim">${esc(inv.billTo.address)}${inv.billTo.address ? ", " : ""}${esc(inv.billTo.city)}<br/>${esc(inv.billTo.phone)}${inv.billTo.email ? " · " + esc(inv.billTo.email) : ""}${inv.billTo.idType ? "<br/>" + esc(inv.billTo.idType).toUpperCase() + " " + esc(inv.billTo.idNumber) : ""}</span></div>
    <div style="text-align:right"><p class="dim" style="margin:0">STAY</p>Room <b>${esc(inv.reservation.room?.number ?? "—")}</b> (${esc(inv.reservation.room?.roomType.name ?? "—")})<br/><span class="dim">${new Date(inv.reservation.checkIn).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} → ${new Date(inv.reservation.checkOut).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} · ${inv.reservation.nights} night(s)<br/>Conf #${esc(inv.reservation.confirmationNumber)}</span></div>
  </div>
  <table><thead><tr><th>#</th><th>Description</th><th>HSN/SAC</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Taxable</th><th class="r">GST%</th><th class="r">GST Amt</th></tr></thead><tbody>${lines}</tbody></table>
  <div class="cols">
    <div class="panel" style="flex:1;min-width:260px"><p class="dim" style="margin:0 0 4px">GST SUMMARY (CGST + SGST)</p><table style="margin:0"><thead><tr><th>Rate</th><th class="r">Taxable</th><th class="r">CGST</th><th class="r">SGST</th><th class="r">Total</th></tr></thead><tbody>${breakup}</tbody></table></div>
    <div class="panel" style="flex:1;min-width:240px">
      <table style="margin:0" class="tot">
        <tr><td>Subtotal</td><td class="r">${money2(inv.subtotal)}</td></tr>
        ${inv.promoDiscount ? `<tr><td>Discount (${esc(inv.promoDiscount.code)})</td><td class="r">−${money2(inv.discountTotal)}</td></tr>` : ""}
        <tr><td>Taxable Value</td><td class="r">${money2(inv.taxableTotal)}</td></tr>
        <tr><td>Total GST (CGST + SGST)</td><td class="r">${money2(inv.totalTax)}</td></tr>
        <tr><td>Grand Total</td><td class="r">${money2(inv.grandTotal)}</td></tr>
        <tr><td>Total Paid</td><td class="r">${money2(inv.paid)}</td></tr>
        <tr class="grand"><td>Balance Due</td><td class="r">${money2(inv.balance)}</td></tr>
      </table>
    </div>
  </div>
  <div class="words"><b>Amount in words:</b> ${esc(amountInWordsINR(inv.grandTotal))}</div>
  <p class="dim" style="margin-top:18px"><b>PAYMENTS</b></p>
  <table style="margin-top:4px"><tbody>${pays}</tbody></table>
  ${notesHtml}
  <div class="sig">
    <p style="max-width:300px;font-size:11px;color:#7a6f5d">Declaration: We declare that this invoice shows the actual price of the services described and that all particulars are true and correct. This is a computer-generated invoice.</p>
    <div style="text-align:center"><p style="margin:0"><b>For ${esc(inv.hotel.name)}</b></p><div style="height:44px"></div><p class="line" style="margin:0">Authorised Signatory</p></div>
  </div>
  <p class="foot">${esc(inv.hotel.name)} · ${esc(inv.hotel.address)}${inv.hotel.address ? ", " : ""}${esc(inv.hotel.city)} · GSTIN ${esc(inv.hotel.gstin) || "—"} — Invoice ${esc(inv.invoiceNo)}</p>
</body></html>`;
}
