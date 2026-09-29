import { amountInWordsINR } from "@/lib/format";

/**
 * Shared payment-receipt document builder — used by the folio Payments tab
 * (BillingView) and the group drawer's Deposits & Receipts section
 * (ReservationsView GroupDialog) so both render the identical branded receipt.
 */

export interface ReceiptPayload {
  receiptNo: string;
  date: string;
  amount: number;
  method: string;
  reference: string;
  receivedBy: string;
  isAdvance: boolean;
  hotel: { name: string; address: string; city: string; gstin: string; phone: string };
  guest: { fullName: string; phone: string; email: string; address: string; city: string };
  reservation: {
    id: string;
    confirmationNumber: string;
    status: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    groupCode: string;
    room: { number: string; roomTypeName: string } | null;
  };
  totals: { charges: number; paid: number; balance: number };
}

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export const money2 = (n: number) =>
  `₹${(Number.isFinite(n) ? n : 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Standalone styled HTML for the payment receipt download (₹, Indian format, amount in words). */
export function receiptHtml(r: ReceiptPayload): string {
  const dateStr = new Date(r.date).toLocaleString("en-IN", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const towards = r.isAdvance
    ? `Advance deposit${r.reservation.groupCode ? ` — group booking ${esc(r.reservation.groupCode)}` : ""}`
    : `Payment on stay ${esc(r.reservation.confirmationNumber)}${r.reservation.groupCode ? ` (group ${esc(r.reservation.groupCode)})` : ""}`;
  const balanceLine =
    r.totals.balance > 0
      ? `<tr class="grand"><td>Balance Due</td><td class="r">${money2(r.totals.balance)}</td></tr>`
      : r.totals.balance < 0
        ? `<tr class="grand"><td>Advance / Credit Balance</td><td class="r">${money2(-r.totals.balance)}</td></tr>`
        : `<tr class="grand"><td>Balance Due</td><td class="r">Settled ✓</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(r.receiptNo)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #26302c; background: #fbf8f2; margin: 40px auto; max-width: 680px; padding: 0 24px; }
  h1 { color: #1f4b43; font-size: 24px; margin: 0; }
  .tag { color: #b9873e; letter-spacing: 3px; font-size: 17px; font-weight: bold; }
  .head { border-bottom: 3px solid #1f4b43; padding-bottom: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .dim { color: #7a6f5d; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
  th { text-align: left; border-bottom: 2px solid #d3c3a4; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7a6f5d; }
  td { border-bottom: 1px solid #e3d7c1; padding: 8px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .grand { border-top: 3px solid #1f4b43; font-weight: bold; font-size: 16px; color: #1f4b43; }
  .amount { margin: 22px 0; border: 2px solid #b9873e; border-radius: 10px; background: #fff; padding: 16px 20px; text-align: center; }
  .amount .big { font-size: 30px; color: #1f4b43; font-weight: bold; }
  .words { font-style: italic; color: #7a6f5d; font-size: 13px; margin-top: 4px; }
  .advtag { background: #b9873e; color: #fff; font-size: 10px; letter-spacing: 1px; padding: 2px 8px; border-radius: 3px; vertical-align: middle; }
  .sig { margin-top: 34px; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; font-size: 12px; color: #26302c; }
  .sig .line { border-top: 1px solid #26302c; padding-top: 4px; min-width: 180px; text-align: center; }
  .foot { margin-top: 28px; border-top: 1px solid #e3d7c1; padding-top: 10px; color: #7a6f5d; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div><h1>${esc(r.hotel.name)}</h1><p class="dim">${esc(r.hotel.address)}${r.hotel.address ? ", " : ""}${esc(r.hotel.city)}<br/>GSTIN: <b>${esc(r.hotel.gstin) || "—"}</b> · Phone: ${esc(r.hotel.phone) || "—"}</p></div>
    <div style="text-align:right"><p class="tag">PAYMENT RECEIPT</p><p class="dim">Receipt No: <b style="color:#26302c">${esc(r.receiptNo)}</b><br/>Date: ${dateStr}</p></div>
  </div>
  <div class="cols" style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;margin-top:16px">
    <div><p class="dim" style="margin:0">RECEIVED FROM</p><b>${esc(r.guest.fullName)}</b><br/><span class="dim">${esc(r.guest.phone)}${r.guest.email ? " · " + esc(r.guest.email) : ""}</span></div>
    <div style="text-align:right"><p class="dim" style="margin:0">TOWARDS</p>${towards}${r.isAdvance ? ' <span class="advtag">ADVANCE</span>' : ""}<br/><span class="dim">Conf #${esc(r.reservation.confirmationNumber)}${r.reservation.room ? ` · Room ${esc(r.reservation.room.number)}` : ""}${r.reservation.groupCode ? ` · Group ${esc(r.reservation.groupCode)}` : ""}</span></div>
  </div>
  <div class="amount">
    <span class="big">${money2(r.amount)}</span> <span class="dim" style="font-size:14px">via ${esc(r.method.toUpperCase())}</span>
    <div class="words">${esc(amountInWordsINR(r.amount))}${r.reference ? `<br/>Reference: ${esc(r.reference)}` : ""}</div>
  </div>
  <table style="margin-top:6px">
    <tr><td>Folio charges (incl. GST)</td><td class="r">${money2(r.totals.charges)}</td></tr>
    <tr><td>Total received to date</td><td class="r">${money2(r.totals.paid)}</td></tr>
    ${balanceLine}
  </table>
  <div class="sig">
    <div class="line">Guest signature</div>
    <div class="line">For ${esc(r.hotel.name)}${r.receivedBy ? `<br/><span class="dim">Received by ${esc(r.receivedBy)}</span>` : ""}</div>
  </div>
  <p class="foot">Computer-generated receipt — ${esc(r.receiptNo)} · ${esc(r.hotel.name)} · This is not a tax invoice.</p>
</body></html>`;
}
