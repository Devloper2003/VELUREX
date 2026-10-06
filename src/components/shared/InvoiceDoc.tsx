"use client";

import { cn } from "@/lib/utils";
import { fmtDate, fmtDateShort, fmtDateTime, CATEGORY_LABELS, amountInWordsINR } from "@/lib/format";
import { money2, splitHalf, invoiceNotes, type InvoicePayload } from "@/lib/invoice-format";

/**
 * White-labeled GST tax invoice document (screen + print).
 * Every printed line belongs to the tenant's own hotel — no platform branding.
 * Shared by BillingView (invoice tab) and ReservationsView (row actions).
 */
export function InvoiceDoc({ inv }: { inv: InvoicePayload }) {
  const placeOfSupply = inv.hotel.state || inv.hotel.city || "—";
  return (
    <div className="max-w-3xl mx-auto text-sm">
      {/* Header */}
      <div className="flex flex-wrap justify-between gap-4 border-b-2 border-pine-700 pb-4">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-semibold text-pine">{inv.hotel.name}</h2>
          <p className="text-xs text-muted-ink mt-1">
            {inv.hotel.address}{inv.hotel.address ? ", " : ""}{inv.hotel.city}{inv.hotel.state ? `, ${inv.hotel.state}` : ""}
          </p>
          <p className="text-xs text-muted-ink">
            GSTIN: <b className="text-ink">{inv.hotel.gstin || "—"}</b>
            {inv.hotel.phone ? <> · Phone: {inv.hotel.phone}</> : null}
            {inv.hotel.email ? <> · {inv.hotel.email}</> : null}
          </p>
        </div>
        <div className="sm:text-right">
          <p className="font-display text-lg font-semibold text-brass tracking-[0.2em]">TAX INVOICE</p>
          <p className="text-xs text-muted-ink mt-1">Invoice No: <b className="text-ink">{inv.invoiceNo}</b></p>
          <p className="text-xs text-muted-ink">Date: {fmtDateTime(inv.date)}</p>
          <p className="text-xs text-muted-ink">Place of Supply: <b className="text-ink">{placeOfSupply}</b></p>
        </div>
      </div>

      {/* Bill to + stay */}
      <div className="grid sm:grid-cols-2 gap-4 py-4 border-b border-line">
        <div>
          <p className="field-label">Bill To</p>
          <p className="font-medium text-pine">{inv.billTo.fullName}</p>
          <p className="text-xs text-muted-ink">{inv.billTo.address}{inv.billTo.address ? ", " : ""}{inv.billTo.city || "—"}</p>
          <p className="text-xs text-muted-ink">{inv.billTo.phone}{inv.billTo.email ? ` · ${inv.billTo.email}` : ""}</p>
          {inv.billTo.idType && (
            <p className="text-xs text-muted-ink capitalize">{inv.billTo.idType} {inv.billTo.idNumber}</p>
          )}
        </div>
        <div className="sm:text-right">
          <p className="field-label">Stay Details</p>
          <p className="text-xs">
            Room <b>{inv.reservation.room?.number ?? "—"}</b> ({inv.reservation.room?.roomType.name ?? "—"}) · Conf #{inv.reservation.confirmationNumber}
          </p>
          <p className="text-xs text-muted-ink">
            {fmtDate(inv.reservation.checkIn)} → {fmtDate(inv.reservation.checkOut)} · {inv.reservation.nights} night(s)
          </p>
          {inv.reservation.groupCode && <p className="text-xs text-brass">Group: {inv.reservation.groupCode}</p>}
        </div>
      </div>

      {/* Line items */}
      <table className="w-full mt-4 min-w-[560px]">
        <thead>
          <tr className="border-b border-line-strong">
            <th className="text-left py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink pr-2">#</th>
            <th className="text-left py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Description</th>
            <th className="text-left py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">HSN/SAC</th>
            <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Qty</th>
            <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Rate</th>
            <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Taxable</th>
            <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">GST%</th>
            <th className="text-right py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">GST Amt</th>
          </tr>
        </thead>
        <tbody>
          {inv.lineItems.length === 0 && (
            <tr><td colSpan={8} className="py-6 text-center text-muted-ink">No billable items on this folio.</td></tr>
          )}
          {inv.lineItems.map((li, idx) => (
            <tr key={li.id} className="border-b border-line/70 align-top">
              <td className="py-2 text-xs text-muted-ink">{idx + 1}</td>
              <td className="py-2">
                <span className="font-medium">{li.description}</span>
                <span className="block text-[11px] text-muted-ink">
                  {CATEGORY_LABELS[li.category] ?? li.category} · {fmtDateShort(li.date)}
                </span>
              </td>
              <td className="py-2 text-xs">{li.hsn}</td>
              <td className="py-2 text-right whitespace-nowrap">{li.qty % 1 === 0 ? li.qty : li.qty.toFixed(2)}</td>
              <td className="py-2 text-right whitespace-nowrap">{money2(li.rate)}</td>
              <td className="py-2 text-right whitespace-nowrap">{money2(li.taxable)}</td>
              <td className="py-2 text-right">{li.gstRate}%</td>
              <td className="py-2 text-right whitespace-nowrap">{money2(li.gstAmount)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals + CGST/SGST breakup */}
      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <div className="border border-line rounded-md p-3">
          <p className="field-label">GST Summary</p>
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left py-1.5 text-[10px] uppercase tracking-wider text-muted-ink">Rate</th>
                <th className="text-right py-1.5 text-[10px] uppercase tracking-wider text-muted-ink">Taxable</th>
                <th className="text-right py-1.5 text-[10px] uppercase tracking-wider text-muted-ink">CGST</th>
                <th className="text-right py-1.5 text-[10px] uppercase tracking-wider text-muted-ink">SGST</th>
              </tr>
            </thead>
            <tbody>
              {inv.taxBreakup.map((t) => (
                <tr key={t.gstRate} className="border-b border-line/60">
                  <td className="py-1.5">GST @ {t.gstRate}%</td>
                  <td className="py-1.5 text-right">{money2(t.taxable)}</td>
                  <td className="py-1.5 text-right">{money2(splitHalf(t.tax))}</td>
                  <td className="py-1.5 text-right">{money2(t.tax - splitHalf(t.tax))}</td>
                </tr>
              ))}
              {inv.taxBreakup.length === 0 && (
                <tr><td colSpan={4} className="py-3 text-center text-muted-ink">No taxable items</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border border-line rounded-md p-3 self-start w-full">
          <p className="field-label">Invoice Totals</p>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between"><span className="text-muted-ink">Subtotal</span><span>{money2(inv.subtotal)}</span></div>
            {inv.promoDiscount && (
              <div className="flex justify-between text-ok">
                <span>Discount ({inv.promoDiscount.code})</span><span>−{money2(inv.discountTotal)}</span>
              </div>
            )}
            <div className="flex justify-between"><span className="text-muted-ink">Taxable Value</span><span>{money2(inv.taxableTotal)}</span></div>
            <div className="flex justify-between"><span className="text-muted-ink">Total GST (CGST + SGST)</span><span>{money2(inv.totalTax)}</span></div>
            <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-pine">
              <span>Grand Total</span><span className="font-display text-base">{money2(inv.grandTotal)}</span>
            </div>
            <div className="flex justify-between"><span className="text-muted-ink">Total Paid</span><span className="text-ok">{money2(inv.paid)}</span></div>
            <div className="flex justify-between border-t-2 border-pine-700 pt-1.5 font-semibold">
              <span className={inv.balance > 0 ? "text-warn" : "text-ok"}>Balance Due</span>
              <span className={cn("font-display text-base", inv.balance > 0 ? "text-warn" : "text-ok")}>{money2(inv.balance)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Amount in words */}
      <div className="mt-4 border border-line rounded-md bg-plaster/40 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Amount in words</p>
        <p className="text-xs font-medium text-pine italic">{amountInWordsINR(inv.grandTotal)}</p>
      </div>

      {/* Payments */}
      <div className="mt-4">
        <p className="field-label">Payment Summary</p>
        <table className="w-full text-xs">
          <tbody>
            {inv.payments.length === 0 && (
              <tr><td className="py-2 text-muted-ink">No payments recorded against this invoice.</td></tr>
            )}
            {inv.payments.map((p) => (
              <tr key={p.id} className="border-b border-line/60">
                <td className="py-1.5">{fmtDateTime(p.createdAt)}</td>
                <td className="py-1.5 uppercase font-medium">{p.method}</td>
                <td className="py-1.5 font-mono">{p.reference || "—"}</td>
                <td className="py-1.5 text-right whitespace-nowrap">{money2(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Billing notes — promo / early-departure / departure-posting explanations */}
      {invoiceNotes(inv).length > 0 && (
        <div className="mt-4 border border-brass/30 bg-brass-50/40 rounded-md p-3 print:break-inside-avoid">
          <p className="field-label text-brass">Billing Notes</p>
          <ul className="mt-1 space-y-1 text-xs text-ink list-disc pl-4">
            {invoiceNotes(inv).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Declaration + signature block */}
      <div className="mt-6 flex flex-wrap justify-between items-end gap-6">
        <p className="text-[11px] text-muted-ink max-w-xs">
          Declaration: We declare that this invoice shows the actual price of the services described and that all
          particulars are true and correct. This is a computer-generated invoice.
        </p>
        <div className="text-center">
          <p className="text-xs font-medium text-ink">For <span className="font-semibold text-pine">{inv.hotel.name}</span></p>
          <div className="h-12" aria-hidden />
          <p className="text-[11px] text-muted-ink border-t border-line pt-1 min-w-[180px]">Authorised Signatory</p>
        </div>
      </div>

      <p className="text-center text-[11px] text-muted-ink border-t border-line mt-6 pt-3">
        {inv.hotel.name} · {inv.hotel.address}{inv.hotel.address ? ", " : ""}{inv.hotel.city} · GSTIN {inv.hotel.gstin || "—"} — Invoice {inv.invoiceNo}
      </p>
    </div>
  );
}
