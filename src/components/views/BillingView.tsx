"use client";

import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from "react";
import { api } from "@/lib/api-client";
import { mutate, flushQueue, getQueue } from "@/lib/offline-queue";
import { inr, fmtDate, fmtDateTime, fmtDateShort, STATUS_LABELS, CATEGORY_LABELS, amountInWordsINR } from "@/lib/format";
import { receiptHtml, type ReceiptPayload } from "@/lib/receipt-html";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { useRealtime, type RealtimeStatus } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import {
  Plus, Search, Lock, Pencil, Trash2, Printer, Download, Wallet, ReceiptText,
  Loader2, ArrowLeftRight, Phone, CalendarDays, Hash, BedDouble, HandCoins,
  CloudOff, RefreshCw, Layers, Crown, ArrowLeft, ArrowRightLeft, ChevronDown,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface FolioRow {
  reservationId: string;
  confirmationNumber: string;
  guestName: string;
  roomNumber: string;
  checkIn: string;
  checkOut: string;
  status: string;
  totalAmount: number;
  paidAmount: number;
  groupCode: string;
  groupMaster: boolean;
  balance: number;
}

interface FolioItemRow {
  id: string;
  reservationId: string;
  category: string;
  description: string;
  qty: number;
  rate: number;
  amount: number;
  businessDate: string;
  locked: boolean;
  posOrderId: string;
  postedBy: string;
  createdAt: string;
}

interface PaymentRow {
  id: string;
  amount: number;
  method: string;
  status: string;
  reference: string;
  receivedBy: string;
  createdAt: string;
}

interface FolioDetail {
  reservation: {
    id: string;
    confirmationNumber: string;
    status: string;
    checkIn: string;
    checkOut: string;
    nights: number;
    nightlyRate: number;
    totalAmount: number;
    paidAmount: number;
    groupCode: string;
    groupMaster: boolean;
    guest: { fullName: string; phone: string; email: string; address: string; city: string; idType: string; idNumber: string };
    room: { number: string; roomType: { name: string } } | null;
  };
  items: FolioItemRow[];
  payments: PaymentRow[];
  totals: { charges: number; paid: number; balance: number };
}

interface InvoiceLine {
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

interface InvoicePayload {
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

interface RouteableItem {
  id: string;
  category: string;
  description: string;
  amount: number;
  businessDate: string;
}

interface GroupMemberRow {
  reservationId: string;
  confirmationNumber: string;
  guestName: string;
  roomNumber: string;
  roomTypeName: string;
  status: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  nightlyRate: number;
  totalAmount: number;
  charges: number;
  paid: number;
  balance: number;
  isMaster: boolean;
  routeableAmount: number;
  routeableItems: RouteableItem[];
}

interface GroupPayload {
  group: {
    code: string;
    masterReservationId: string | null;
    masterGuestName: string | null;
    masterRoomNumber: string | null;
    members: GroupMemberRow[];
    grand: { charges: number; paid: number; rooms: number; balance: number };
  };
}

interface GroupInvoiceRoom {
  reservationId: string;
  confirmationNumber: string;
  guestName: string;
  roomNumber: string;
  roomTypeName: string;
  status: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  isMaster: boolean;
  lineItems: InvoiceLine[];
  promoDiscount: { code: string; amount: number; description: string } | null;
  charges: number;
  paid: number;
  balance: number;
  subtotal: number;
}

interface GroupInvoicePayload {
  invoiceNo: string;
  date: string;
  hotel: { name: string; address: string; city: string; gstin: string; phone: string };
  group: { code: string; masterGuestName: string | null; masterRoomNumber: string | null; roomCount: number; notes: string[] };
  billTo: { fullName: string; phone: string; email: string; address: string; city: string };
  rooms: GroupInvoiceRoom[];
  taxBreakup: { gstRate: number; taxable: number; tax: number }[];
  subtotal: number;
  discountTotal: number;
  taxableTotal: number;
  totalTax: number;
  grandTotal: number;
  paid: number;
  balance: number;
  payments: { id: string; reservationId: string; amount: number; method: string; reference: string; status: string; createdAt: string }[];
}

type TabKey = "folio" | "payments" | "invoice";
type StatusFilter = "all" | "in_house" | "departed";

const CHARGE_CATEGORIES = ["room", "fnb", "laundry", "misc", "bar", "discount", "no_show"] as const;
const PAYMENT_METHODS = ["cash", "upi", "card", "netbanking", "razorpay"] as const;
const round2 = (n: number) => Math.round(n * 100) / 100;
const money2 = (n: number) => `₹${(Number.isFinite(n) ? n : 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const STATUS_BADGE: Record<string, string> = {
  // (group rows reuse the shared badge map)
  checked_in: "border-ok/40 bg-ok/10 text-ok",
  checked_out: "border-line-strong bg-plaster text-muted-ink",
};

const CATEGORY_BADGE: Record<string, string> = {
  room: "border-pine-700/30 bg-pine-100 text-pine-700",
  fnb: "border-brass/40 bg-brass-50 text-brass",
  bar: "border-warn/40 bg-warn/10 text-warn",
  laundry: "border-line-strong bg-plaster text-muted-ink",
  misc: "border-line-strong bg-plaster text-muted-ink",
  discount: "border-ok/40 bg-ok/10 text-ok",
  no_show: "border-danger/30 bg-danger/10 text-danger",
  tax: "border-line-strong bg-plaster text-muted-ink",
};

const METHOD_BADGE: Record<string, string> = {
  cash: "border-ok/40 bg-ok/10 text-ok",
  upi: "border-pine-700/30 bg-pine-100 text-pine-700",
  card: "border-brass/40 bg-brass-50 text-brass",
  netbanking: "border-line-strong bg-plaster text-ink",
  razorpay: "border-warn/40 bg-warn/10 text-warn",
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

/** Online payment gateway assigned to this property by the platform owner. */
interface GatewayInfo {
  id: string;
  provider: string;
  label: string;
  mode: string;
  isDefault: boolean;
}

const GATEWAY_LABELS: Record<string, string> = {
  razorpay: "Razorpay",
  cashfree: "Cashfree",
  payu: "PayU",
  paytm: "Paytm",
  phonepe: "PhonePe",
  stripe: "Stripe",
  upi_qr: "UPI QR",
  bank_transfer: "Bank transfer",
  custom: "Custom",
};
const gatewayLabel = (p: string) => GATEWAY_LABELS[p] ?? p.replace(/_/g, " ");

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Footnote lines explaining billing adjustments on the invoice — promo
 * discounts and early-departure credits — shown on screen and in print.
 */
function invoiceNotes(inv: InvoicePayload): string[] {
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

/** Standalone styled HTML for the consolidated group invoice download. */
function groupInvoiceHtml(gi: GroupInvoicePayload): string {
  const dateStr = new Date(gi.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const roomSections = gi.rooms
    .map((r) => {
      const lines = r.lineItems
        .map(
          (li) => `<tr>
        <td><b>${esc(li.description)}</b><br/><span class="dim">${esc(CATEGORY_LABELS[li.category] ?? li.category)} · ${new Date(li.date).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</span></td>
        <td>${esc(li.hsn)}</td>
        <td class="r">${money2(li.taxable)}</td>
        <td class="r">${li.gstRate}%</td>
        <td class="r">${money2(li.gstAmount)}</td>
      </tr>`
        )
        .join("");
      return `<div class="roomhead">
      <div><span class="roomtag">ROOM ${esc(r.roomNumber)}</span> <b>${esc(r.guestName)}</b>${r.isMaster ? ' <span class="mastertag">MASTER PAYER</span>' : ""}<br/><span class="dim">${esc(r.roomTypeName)} · ${new Date(r.checkIn).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} → ${new Date(r.checkOut).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })} · ${r.nights} night(s) · Conf #${esc(r.confirmationNumber)}</span></div>
      <div class="r dim">Subtotal ${money2(r.subtotal)}${r.promoDiscount ? `<br/>Discount ${esc(r.promoDiscount.code)} −${money2(r.promoDiscount.amount)}` : ""}</div>
    </div>
    <table><thead><tr><th>Description</th><th>HSN/SAC</th><th class="r">Taxable</th><th class="r">GST%</th><th class="r">GST Amt</th></tr></thead><tbody>${lines || '<tr><td colspan="5" class="dim">No charges</td></tr>'}</tbody></table>`;
    })
    .join("");
  const breakup = gi.taxBreakup
    .map((t) => `<tr><td>GST @ ${t.gstRate}%</td><td class="r">${money2(t.taxable)}</td><td class="r">${money2(t.tax)}</td></tr>`)
    .join("");
  const roomTotals = gi.rooms
    .map((r) => `<tr><td>Room ${esc(r.roomNumber)} · ${esc(r.guestName)}</td><td class="r">${money2(r.charges)}</td><td class="r">${money2(r.paid)}</td><td class="r">${money2(r.balance)}</td></tr>`)
    .join("");
  const pays = gi.payments.length
    ? gi.payments
        .map(
          (p) => `<tr><td>${new Date(p.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td>${esc(p.method.toUpperCase())}${p.reference ? ` · ${esc(p.reference)}` : ""}</td><td class="r">${money2(p.amount)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="dim">No payments recorded</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${esc(gi.invoiceNo)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #26302c; background: #fbf8f2; margin: 40px auto; max-width: 820px; padding: 0 24px; }
  h1 { color: #1f4b43; font-size: 26px; margin: 0; }
  .tag { color: #b9873e; letter-spacing: 3px; font-size: 18px; font-weight: bold; }
  .head { border-bottom: 3px solid #1f4b43; padding-bottom: 14px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .dim { color: #7a6f5d; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th { text-align: left; border-bottom: 2px solid #d3c3a4; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7a6f5d; }
  td { border-bottom: 1px solid #e3d7c1; padding: 7px 8px; vertical-align: top; }
  .r { text-align: right; white-space: nowrap; }
  .roomhead { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; flex-wrap: wrap; margin-top: 22px; padding-bottom: 6px; border-bottom: 1px dashed #d3c3a4; }
  .roomtag { background: #1f4b43; color: #fbf8f2; font-size: 11px; letter-spacing: 1.5px; padding: 2px 8px; border-radius: 3px; margin-right: 6px; }
  .mastertag { background: #b9873e; color: #fff; font-size: 10px; letter-spacing: 1px; padding: 2px 7px; border-radius: 3px; }
  .grand { border-top: 3px solid #1f4b43; font-weight: bold; font-size: 16px; color: #1f4b43; }
  .cols { display: flex; justify-content: space-between; gap: 24px; margin-top: 18px; flex-wrap: wrap; }
  .panel { border: 1px solid #e3d7c1; border-radius: 8px; padding: 12px 16px; background: #fff; }
  .foot { margin-top: 28px; border-top: 1px solid #e3d7c1; padding-top: 10px; color: #7a6f5d; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div><h1>${esc(gi.hotel.name)}</h1><p class="dim">${esc(gi.hotel.address)}${gi.hotel.address ? ", " : ""}${esc(gi.hotel.city)}<br/>GSTIN: <b>${esc(gi.hotel.gstin) || "—"}</b> · Phone: ${esc(gi.hotel.phone) || "—"}</p></div>
    <div style="text-align:right"><p class="tag">CONSOLIDATED TAX INVOICE</p><p class="dim">Invoice No: <b style="color:#26302c">${esc(gi.invoiceNo)}</b><br/>Group: <b style="color:#26302c">${esc(gi.group.code)}</b> · ${gi.group.roomCount} room(s)<br/>Date: ${dateStr}</p></div>
  </div>
  <p class="dim" style="margin-top:12px">BILLED TO</p>
  <p style="margin:2px 0 0"><b>${esc(gi.billTo.fullName)}</b> ${gi.group.masterGuestName ? `<span class="dim">— group master payer${gi.group.masterRoomNumber ? ` · Room ${esc(gi.group.masterRoomNumber)}` : ""}</span>` : ""}<br/><span class="dim">${esc(gi.billTo.phone)}${gi.billTo.email ? " · " + esc(gi.billTo.email) : ""}</span></p>
  ${roomSections}
  <div class="cols">
    <div class="panel" style="flex:1;min-width:250px"><p class="dim" style="margin:0 0 4px">TAX BREAKUP (GROUP)</p><table style="margin:0">${breakup}</table></div>
    <div class="panel" style="flex:1;min-width:250px">
      <table style="margin:0">
        <tr><td>Subtotal</td><td class="r">${money2(gi.subtotal)}</td></tr>
        ${gi.discountTotal > 0 ? `<tr><td>Promo discounts</td><td class="r">−${money2(gi.discountTotal)}</td></tr>` : ""}
        <tr><td>Taxable Value</td><td class="r">${money2(gi.taxableTotal)}</td></tr>
        <tr><td>Total GST</td><td class="r">${money2(gi.totalTax)}</td></tr>
        <tr><td>Grand Total</td><td class="r">${money2(gi.grandTotal)}</td></tr>
        <tr><td>Total Paid</td><td class="r">${money2(gi.paid)}</td></tr>
        <tr class="grand"><td>Balance Due</td><td class="r">${money2(gi.balance)}</td></tr>
      </table>
    </div>
  </div>
  <p class="dim" style="margin-top:18px"><b>PER-ROOM SETTLEMENT</b></p>
  <table style="margin-top:4px"><thead><tr><th>Room</th><th class="r">Charges</th><th class="r">Paid</th><th class="r">Balance</th></tr></thead><tbody>${roomTotals}</tbody></table>
  <p class="dim" style="margin-top:14px"><b>PAYMENTS (ALL ROOMS)</b></p>
  <table style="margin-top:4px"><tbody>${pays}</tbody></table>
  ${gi.group.notes.length ? `<div class="panel" style="margin-top:14px"><p class="dim" style="margin:0 0 6px">BILLING NOTES</p><ul style="margin:0;padding-left:16px;font-size:12px;color:#26302c">${gi.group.notes.map((n) => `<li style="margin-bottom:3px">${esc(n)}</li>`).join("")}</ul></div>` : ""}
  <div class="words" style="margin-top:14px;border:1px solid #e3d7c1;border-radius:8px;background:#fff;padding:10px 16px;font-style:italic;font-size:13px"><b>Amount in words:</b> ${esc(amountInWordsINR(gi.grandTotal))}</div>
  <div class="sig" style="margin-top:34px;display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;font-size:12px;color:#26302c;align-items:flex-end">
    <p style="max-width:300px;font-size:11px;color:#7a6f5d">Declaration: We declare that this invoice shows the actual price of the services described and that all particulars are true and correct. This is a computer-generated invoice.</p>
    <div style="text-align:center"><p style="margin:0"><b>For ${esc(gi.hotel.name)}</b></p><div style="height:44px"></div><p style="margin:0;border-top:1px solid #26302c;padding-top:4px;min-width:180px;text-align:center;color:#7a6f5d;font-size:11px">Authorised Signatory</p></div>
  </div>
  <p class="foot">${esc(gi.hotel.name)} · GSTIN ${esc(gi.hotel.gstin) || "—"} — Invoice ${esc(gi.invoiceNo)}</p>
</body></html>`;
}

/** Standalone styled HTML for the invoice download. */
function invoiceHtml(inv: InvoicePayload): string {
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
        `<tr><td>GST @ ${t.gstRate}%</td><td class="r">${money2(t.taxable)}</td><td class="r">${money2(t.tax / 2)}</td><td class="r">${money2(t.tax - t.tax / 2)}</td><td class="r">${money2(t.tax)}</td></tr>`
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

// ─── Payment receipt ─────────────────────────────────────────────────────────
// Payload type + document builder live in lib/receipt-html.ts (shared with the
// group drawer's Deposits & Receipts section).

// ─── View ────────────────────────────────────────────────────────────────────

export default function BillingView() {
  const user = useSession((s) => s.user);
  const { toast } = useToast();

  // List state
  const [folios, setFolios] = useState<FolioRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  // Detail state
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FolioDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState<TabKey>("folio");
  const [refreshTick, setRefreshTick] = useState(0);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  // Dialog state
  const [chargeOpen, setChargeOpen] = useState(false);
  const [chargeEdit, setChargeEdit] = useState<FolioItemRow | null>(null);
  const [form, setForm] = useState({ category: "fnb", description: "", qty: "1", rate: "" });
  const [saving, setSaving] = useState(false);

  const [splitOpen, setSplitOpen] = useState(false);
  const [splitItem, setSplitItem] = useState<FolioItemRow | null>(null);
  const [splitTarget, setSplitTarget] = useState("");
  const [splitQty, setSplitQty] = useState("1");

  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("cash");
  const [payReference, setPayReference] = useState("");

  // Online payment gateways assigned to this property by the platform owner
  const [gateways, setGateways] = useState<GatewayInfo[]>([]);
  useEffect(() => {
    let cancelled = false;
    api<{ gateways: GatewayInfo[] }>("/api/payments/gateways")
      .then((d) => {
        if (!cancelled) setGateways(d.gateways ?? []);
      })
      .catch(() => {
        /* optional feature — stay quiet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [voidItem, setVoidItem] = useState<FolioItemRow | null>(null);
  const [voiding, setVoiding] = useState(false);

  // Offline queue: pending-op count + online/offline flag for the banner
  const [queuedCount, setQueuedCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);

  const bumpQueueCount = useCallback(() => {
    getQueue()
      .then((q) => setQueuedCount(q.length))
      .catch(() => {});
  }, []);

  // Track connectivity for the offline banner
  useEffect(() => {
    setIsOnline(navigator.onLine);
    bumpQueueCount();
    const goOffline = () => setIsOnline(false);
    window.addEventListener("offline", goOffline);
    return () => window.removeEventListener("offline", goOffline);
  }, [bumpQueueCount]);

  // Invoice state
  const [invoice, setInvoice] = useState<InvoicePayload | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);

  // Group billing state (master folio, routing, consolidated invoice)
  const [groupMode, setGroupMode] = useState(false);
  const [group, setGroup] = useState<GroupPayload["group"] | null>(null);
  const [groupLoading, setGroupLoading] = useState(false);
  const [groupBusy, setGroupBusy] = useState(false);
  const [groupInvoiceDownloading, setGroupInvoiceDownloading] = useState(false);

  // Group payment collection (master folio or auto-distributed across rooms)
  const [groupPayOpen, setGroupPayOpen] = useState(false);
  const [groupPayBusy, setGroupPayBusy] = useState(false);
  const [groupPayAmount, setGroupPayAmount] = useState("");
  const [groupPayMethod, setGroupPayMethod] = useState("cash");
  const [groupPayReference, setGroupPayReference] = useState("");
  const [groupPayMode, setGroupPayMode] = useState<"master" | "distribute">("distribute");

  // Selective charge routing — which member's charge picker is expanded + selected item ids
  const [routeSelectFor, setRouteSelectFor] = useState<string | null>(null);
  const [routeSelected, setRouteSelected] = useState<Set<string>>(new Set());

  // Payment receipt downloads (per payment row in the Payments tab)
  const [receiptBusyId, setReceiptBusyId] = useState<string | null>(null);

  async function downloadReceipt(payment: PaymentRow) {
    setReceiptBusyId(payment.id);
    try {
      const d = await api<{ receipt: ReceiptPayload }>(`/api/receipt/${payment.id}`);
      const blob = new Blob([receiptHtml(d.receipt)], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.receipt.receiptNo}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `Receipt ${d.receipt.receiptNo} downloaded`, description: `${money2(d.receipt.amount)} · ${d.receipt.method.toUpperCase()} · ${d.receipt.guest.fullName}` });
    } catch (e) {
      toast({ title: "Could not build receipt", description: errMessage(e), variant: "destructive" });
    } finally {
      setReceiptBusyId(null);
    }
  }

  // Debounce search
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadList = useCallback(async () => {
    try {
      setListLoading(true);
      const data = await api<{ folios: FolioRow[] }>(
        `/api/folio?status=${statusFilter}&search=${encodeURIComponent(searchDebounced)}`
      );
      setFolios(data.folios);
    } catch {
      /* offline: keep stale list */
    } finally {
      setListLoading(false);
    }
  }, [statusFilter, searchDebounced]);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const d = await api<FolioDetail>(`/api/folio?reservationId=${id}`);
      setDetail(d);
    } catch (e) {
      toast({ title: "Could not load folio", description: errMessage(e), variant: "destructive" });
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // Load / reload invoice whenever the tab is active or data mutates
  useEffect(() => {
    if (tab !== "invoice" || !selectedId) return;
    let cancelled = false;
    setInvoiceLoading(true);
    api<InvoicePayload>(`/api/invoice/${selectedId}`)
      .then((inv) => {
        if (!cancelled) setInvoice(inv);
      })
      .catch(() => {
        if (!cancelled) setInvoice(null);
      })
      .finally(() => {
        if (!cancelled) setInvoiceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab, selectedId, refreshTick]);

  const refresh = useCallback(() => {
    loadList();
    if (selectedIdRef.current) loadDetail(selectedIdRef.current);
    setRefreshTick((t) => t + 1);
  }, [loadList, loadDetail]);

  // ─── Live folio updates (socket.io) ───────────────────────────────────────
  // folio:update fires from folio charges, POS post-to-folio and payments.
  // Refresh + flash the touched row; 45s polling keeps things fresh offline.
  const [flashId, setFlashId] = useState<string | null>(null);
  const [rtStatus, setRtStatus] = useState<RealtimeStatus>("offline");
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useRealtime(
    (event, data) => {
      if (event !== "folio:update") return;
      const rid = (data as { reservationId?: string })?.reservationId ?? null;
      refresh();
      if (flashTimer.current) clearTimeout(flashTimer.current);
      setFlashId(rid);
      flashTimer.current = setTimeout(() => setFlashId(null), 2600);
    },
    setRtStatus
  );

  useEffect(() => {
    if (rtStatus !== "online") {
      const t = setInterval(loadList, 45_000);
      return () => clearInterval(t);
    }
  }, [rtStatus, loadList]);

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current); }, []);

  // ─── Offline sync ─────────────────────────────────────────────────────────
  // Flush the IndexedDB queue when connectivity returns (folio charges +
  // payments recorded offline replay idempotently via clientRef).
  const syncNow = useCallback(async () => {
    const r = await flushQueue();
    if (r.ok > 0) toast({ title: `Synced ${r.ok} offline folio change${r.ok === 1 ? "" : "s"}` });
    if (r.failed > 0) {
      toast({ title: `${r.failed} change${r.failed === 1 ? "" : "s"} failed to sync`, description: "They stay queued — try again shortly.", variant: "destructive" });
    }
    bumpQueueCount();
    refresh();
  }, [bumpQueueCount, refresh, toast]);

  useEffect(() => {
    if (isOnline) return; // only listen while we're marked offline
    const goOnline = () => { setIsOnline(true); syncNow(); };
    window.addEventListener("online", goOnline);
    return () => window.removeEventListener("online", goOnline);
  }, [isOnline, syncNow]);

  // Background sync (service worker) finished replaying the queue — even when
  // this tab was hidden while connectivity returned, refresh + celebrate.
  useEffect(() => {
    const onSwSync = (e: Event) => {
      const d = (e as CustomEvent<{ ok: number; failed: number }>).detail;
      if (d.ok > 0) toast({ title: `Background sync: ${d.ok} offline change${d.ok === 1 ? "" : "s"} synced` });
      if (d.failed > 0) toast({ title: `${d.failed} offline change${d.failed === 1 ? "" : "s"} still queued`, description: "Retry next time you're online.", variant: "destructive" });
      bumpQueueCount();
      refresh();
      loadList();
    };
    window.addEventListener("velurex:sw-sync-done", onSwSync);
    return () => window.removeEventListener("velurex:sw-sync-done", onSwSync);
  }, [bumpQueueCount, refresh, loadList, toast]);

  function selectFolio(id: string) {
    setSelectedId(id);
    setTab("folio");
    setInvoice(null);
    setGroupMode(false);
    setGroup(null);
    loadDetail(id);
  }

  // Deep-link: "Open Group Folio" from the Reservations group drawer. The
  // drawer also stashes the request in sessionStorage because BillingView may
  // not be mounted when the event fires — consume it on mount.
  useEffect(() => {
    const raw = sessionStorage.getItem("velurex_pending_group");
    if (!raw) return;
    sessionStorage.removeItem("velurex_pending_group");
    try {
      const d = JSON.parse(raw) as { groupCode?: string; reservationId?: string };
      if (!d.groupCode) return;
      if (d.reservationId) {
        setSelectedId(d.reservationId);
        loadDetail(d.reservationId);
      }
      setTab("folio");
      setInvoice(null);
      setGroupMode(true);
      loadGroup(d.groupCode);
    } catch {
      /* malformed handover — ignore */
    }
  }, [loadDetail]);
  useEffect(() => {
    const onOpenGroup = (e: Event) => {
      const d = (e as CustomEvent<{ groupCode?: string; reservationId?: string }>).detail;
      if (!d?.groupCode) return;
      if (d.reservationId) {
        setSelectedId(d.reservationId);
        loadDetail(d.reservationId);
      }
      setTab("folio");
      setInvoice(null);
      setGroupMode(true);
      loadGroup(d.groupCode);
    };
    window.addEventListener("velurex:open-group", onOpenGroup);
    return () => window.removeEventListener("velurex:open-group", onOpenGroup);
  }, [loadDetail]);

  // ─── Group billing ────────────────────────────────────────────────────────

  // Function declaration (hoisted) so the deep-link effect below/above can use it.
  async function loadGroup(code: string) {
    setGroupLoading(true);
    try {
      const d = await api<GroupPayload>(`/api/groups/${encodeURIComponent(code)}`);
      setGroup(d.group);
    } catch (e) {
      toast({ title: "Could not load group folio", description: errMessage(e), variant: "destructive" });
      setGroupMode(false);
    } finally {
      setGroupLoading(false);
    }
  }

  function openGroup() {
    const code = detail?.reservation.groupCode;
    if (!code) return;
    setGroupMode(true);
    loadGroup(code);
  }

  async function designateMaster(reservationId: string) {
    const code = group?.code;
    if (!code) return;
    setGroupBusy(true);
    try {
      await api(`/api/groups/${encodeURIComponent(code)}`, {
        method: "POST",
        body: JSON.stringify({ action: "designate-master", reservationId }),
      });
      const m = group?.members.find((x) => x.reservationId === reservationId);
      toast({
        title: "Master payer folio set",
        description: `${m?.guestName ?? "Folio"} · Room ${m?.roomNumber ?? "—"} now settles the group bill.`,
      });
      await loadGroup(code);
      if (selectedIdRef.current) loadDetail(selectedIdRef.current);
      loadList();
    } catch (e) {
      toast({ title: "Could not set master folio", description: errMessage(e), variant: "destructive" });
    } finally {
      setGroupBusy(false);
    }
  }

  async function routeToMaster(fromReservationId: string, itemIds?: string[]) {
    const code = group?.code;
    if (!code) return;
    setGroupBusy(true);
    try {
      const r = await api<{ routedCount: number; routedAmount: number; masterReservationId: string }>(
        `/api/groups/${encodeURIComponent(code)}/route-to-master`,
        { method: "POST", body: JSON.stringify({ fromReservationId, ...(itemIds && itemIds.length > 0 ? { itemIds } : {}) }) }
      );
      const m = group?.members.find((x) => x.reservationId === fromReservationId);
      toast({
        title: `Routed ${r.routedCount} charge${r.routedCount === 1 ? "" : "s"} to master folio`,
        description: `${money2(r.routedAmount)} moved from Room ${m?.roomNumber ?? "—"} to ${group?.masterGuestName ?? "master"}.`,
      });
      setRouteSelectFor(null);
      setRouteSelected(new Set());
      await loadGroup(code);
      if (selectedIdRef.current) loadDetail(selectedIdRef.current);
      loadList();
    } catch (e) {
      toast({ title: "Could not route charges", description: errMessage(e), variant: "destructive" });
    } finally {
      setGroupBusy(false);
    }
  }

  function toggleRouteItem(itemId: string) {
    setRouteSelected((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  function openRouteSelect(m: GroupMemberRow) {
    if (routeSelectFor === m.reservationId) {
      setRouteSelectFor(null);
      setRouteSelected(new Set());
    } else {
      setRouteSelectFor(m.reservationId);
      setRouteSelected(new Set(m.routeableItems.map((i) => i.id))); // pre-select all
    }
  }

  function openGroupPayment() {
    if (!group) return;
    setGroupPayAmount(String(Math.max(0, round2(group.grand.balance))));
    setGroupPayMethod("cash");
    setGroupPayReference("");
    setGroupPayMode(group.masterReservationId ? "master" : "distribute");
    setGroupPayOpen(true);
  }

  // Client-side preview of how a distributed payment will waterfall across rooms
  const groupPayPreview = useMemo(() => {
    if (!group || groupPayMode !== "distribute") return [];
    const amt = Math.round(Number(groupPayAmount) * 100) / 100;
    if (!Number.isFinite(amt) || amt <= 0) return [];
    let remaining = Math.round(Math.min(amt, group.grand.balance) * 100);
    const rows = group.members
      .filter((m) => m.balance > 0)
      .sort((a, b) => b.balance - a.balance)
      .map((m) => {
        if (remaining <= 0) return { roomNumber: m.roomNumber, guestName: m.guestName, balance: m.balance, allocated: 0 };
        const give = Math.min(Math.round(m.balance * 100), remaining);
        remaining -= give;
        return { roomNumber: m.roomNumber, guestName: m.guestName, balance: m.balance, allocated: give / 100 };
      })
      .filter((r) => r.allocated > 0);
    return rows;
  }, [group, groupPayAmount, groupPayMode]);

  async function submitGroupPayment() {
    const code = group?.code;
    if (!code) return;
    const amount = Number(groupPayAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return toast({ title: "Enter a valid amount", variant: "destructive" });
    }
    setGroupPayBusy(true);
    try {
      const r = await api<{ mode: string; allocations: { reservationId: string; amount: number }[]; totals: { charges: number; paid: number; balance: number } }>(
        `/api/groups/${encodeURIComponent(code)}/payment`,
        {
          method: "POST",
          body: JSON.stringify({
            amount,
            method: groupPayMethod,
            reference: groupPayReference.trim(),
            mode: groupPayMode,
            clientRef: `grp-pay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          }),
        }
      );
      toast({
        title: r.mode === "master" ? "Payment recorded on master folio" : `Payment split across ${r.allocations.length} room folio(s)`,
        description: `${money2(amount)} via ${groupPayMethod.toUpperCase()} · group balance ${money2(r.totals.balance)}`,
      });
      setGroupPayOpen(false);
      await loadGroup(code);
      if (selectedIdRef.current) loadDetail(selectedIdRef.current);
      loadList();
    } catch (e) {
      toast({ title: "Could not record group payment", description: errMessage(e), variant: "destructive" });
    } finally {
      setGroupPayBusy(false);
    }
  }

  async function downloadGroupInvoice() {
    const code = group?.code;
    if (!code) return;
    setGroupInvoiceDownloading(true);
    try {
      const gi = await api<GroupInvoicePayload>(`/api/groups/${encodeURIComponent(code)}/invoice`);
      const blob = new Blob([groupInvoiceHtml(gi)], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${gi.invoiceNo}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Group invoice downloaded", description: `${gi.invoiceNo} · ${gi.rooms.length} room(s) · ${money2(gi.grandTotal)}` });
    } catch (e) {
      toast({ title: "Could not build group invoice", description: errMessage(e), variant: "destructive" });
    } finally {
      setGroupInvoiceDownloading(false);
    }
  }

  // ─── Dialog openers ────────────────────────────────────────────────────────

  function openAddCharge() {
    setChargeEdit(null);
    setForm({ category: "fnb", description: "", qty: "1", rate: "" });
    setChargeOpen(true);
  }

  function openEditCharge(item: FolioItemRow) {
    setChargeEdit(item);
    setForm({ category: item.category, description: item.description, qty: String(item.qty), rate: String(item.rate) });
    setChargeOpen(true);
  }

  function openSplit(item: FolioItemRow) {
    setSplitItem(item);
    setSplitQty(String(item.qty));
    setSplitTarget("");
    setSplitOpen(true);
  }

  function openPayment() {
    if (!detail) return;
    setPayAmount(String(Math.max(0, round2(detail.totals.balance))));
    setPayMethod("cash");
    setPayReference("");
    setPayOpen(true);
  }

  // ─── Mutations ─────────────────────────────────────────────────────────────

  async function submitCharge() {
    if (!detail) return;
    const qty = Number(form.qty);
    const rate = Number(form.rate);
    const description = form.description.trim();
    if (!description) return toast({ title: "Description is required", variant: "destructive" });
    if (!Number.isFinite(qty) || qty <= 0) return toast({ title: "Qty must be a positive number", variant: "destructive" });
    if (!Number.isFinite(rate) || rate === 0) return toast({ title: "Rate must be a non-zero number", variant: "destructive" });
    setSaving(true);
    try {
      if (chargeEdit) {
        // Edits stay online-only — replaying a blind overwrite offline is unsafe.
        await api(`/api/folio/${chargeEdit.id}`, {
          method: "PATCH",
          body: JSON.stringify({ qty, rate, description }),
        });
        toast({ title: "Charge updated", description: `${description} · ${money2(qty * rate)}` });
      } else {
        const r = await mutate("/api/folio", "POST", {
          reservationId: detail.reservation.id,
          category: form.category,
          description,
          qty,
          rate,
        }, `Charge · ${description}`);
        if (r.queued) {
          toast({
            title: "Offline — charge queued",
            description: `${description} · ${money2(qty * rate)} will sync automatically when you're back online.`,
          });
          bumpQueueCount();
        } else {
          toast({ title: "Charge posted", description: `${CATEGORY_LABELS[form.category] ?? form.category} · ${money2(qty * rate)}` });
        }
      }
      setChargeOpen(false);
      refresh();
    } catch (e) {
      toast({ title: "Could not save charge", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitSplit() {
    if (!splitItem || !detail) return;
    const qtyToMove = Number(splitQty);
    if (!splitTarget) return toast({ title: "Choose a target folio", variant: "destructive" });
    if (!Number.isFinite(qtyToMove) || qtyToMove <= 0) return toast({ title: "Qty to move must be positive", variant: "destructive" });
    if (qtyToMove > splitItem.qty) return toast({ title: `Cannot move more than ${splitItem.qty}`, variant: "destructive" });
    setSaving(true);
    try {
      const target = folios.find((f) => f.reservationId === splitTarget);
      await api("/api/folio/split", {
        method: "POST",
        body: JSON.stringify({ itemId: splitItem.id, targetReservationId: splitTarget, qtyToMove }),
      });
      toast({
        title: "Charge split",
        description: `Moved ${qtyToMove} × ${money2(splitItem.rate)} to ${target?.guestName ?? "target folio"}${target ? ` · Room ${target.roomNumber}` : ""}`,
      });
      setSplitOpen(false);
      refresh();
    } catch (e) {
      toast({ title: "Could not split charge", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function submitPayment() {
    if (!detail) return;
    const amount = Number(payAmount);
    if (!Number.isFinite(amount) || amount <= 0) return toast({ title: "Enter a valid amount", variant: "destructive" });
    setSaving(true);
    try {
      const payload = {
        reservationId: detail.reservation.id,
        amount: round2(amount),
        method: payMethod,
        reference: payReference.trim(),
      };
      const r = await mutate<{ totals: { balance: number } }>("/api/payments", "POST", payload, `Payment · ${money2(amount)} ${payMethod}`);
      if (r.queued) {
        toast({
          title: "Offline — payment queued",
          description: `${money2(amount)} via ${payMethod.toUpperCase()} will sync automatically when you're back online.`,
        });
        bumpQueueCount();
      } else {
        toast({
          title: "Payment recorded",
          description: `${money2(amount)} via ${payMethod.toUpperCase()} · balance ${money2(r.data?.totals.balance ?? 0)}`,
        });
      }
      setPayOpen(false);
      refresh();
    } catch (e) {
      toast({ title: "Could not record payment", description: errMessage(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function confirmVoid() {
    if (!voidItem) return;
    setVoiding(true);
    try {
      await api(`/api/folio/${voidItem.id}`, { method: "DELETE" });
      toast({ title: "Charge voided", description: voidItem.description });
      setVoidItem(null);
      refresh();
    } catch (e) {
      toast({ title: "Could not void charge", description: errMessage(e), variant: "destructive" });
    } finally {
      setVoiding(false);
    }
  }

  function printInvoice() {
    window.print();
  }

  function downloadInvoice() {
    if (!invoice) return;
    const blob = new Blob([invoiceHtml(invoice)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${invoice.invoiceNo}.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Invoice downloaded", description: `${invoice.invoiceNo}.html` });
  }

  // ─── Derived ───────────────────────────────────────────────────────────────

  const outstanding = useMemo(() => folios.reduce((s, f) => s + Math.max(0, f.balance), 0), [folios]);

  const splitTargets = useMemo(() => {
    const others = folios.filter((f) => f.reservationId !== detail?.reservation.id);
    const gc = detail?.reservation.groupCode ?? "";
    return {
      group: gc ? others.filter((f) => f.groupCode === gc) : [],
      rest: gc ? others.filter((f) => f.groupCode !== gc) : others,
      groupCode: gc,
    };
  }, [folios, detail]);

  const previewAmount = (Number(form.qty) || 0) * (Number(form.rate) || 0);

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col lg:flex-row gap-4 items-start">
      {/* Offline / queued-sync banner */}
      {(!isOnline || queuedCount > 0) && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "fixed bottom-4 left-1/2 -translate-x-1/2 z-50 print:hidden flex items-center gap-2.5 rounded-full border px-4 py-2 text-xs font-medium shadow-lg backdrop-blur",
            !isOnline
              ? "border-warn/40 bg-warn/10 text-warn"
              : "border-ok/40 bg-ok/10 text-ok"
          )}
        >
          {!isOnline ? (
            <>
              <CloudOff className="h-3.5 w-3.5" />
              <span>
                Offline{queuedCount > 0 ? ` — ${queuedCount} folio change${queuedCount === 1 ? "" : "s"} queued` : " — charges & payments will queue"}
              </span>
            </>
          ) : (
            <>
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{queuedCount} offline change{queuedCount === 1 ? "" : "s"} waiting to sync</span>
            </>
          )}
          {isOnline && queuedCount > 0 && (
            <button
              onClick={syncNow}
              className="rounded-full bg-ok/15 px-2.5 py-1 text-[11px] font-semibold text-ok hover:bg-ok/25 transition-colors"
            >
              Sync now
            </button>
          )}
        </div>
      )}
      {/* Left — folio list */}
      <aside className="panel w-full lg:w-80 shrink-0 print:hidden">
        <div className="p-3 border-b border-line space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search guest, room, conf #"
                className="pl-8"
              />
            </div>
            <span
              className={cn(
                "flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider shrink-0",
                rtStatus === "online" ? "text-ok" : "text-muted-ink"
              )}
              title={rtStatus === "online" ? "Live folio updates connected" : "Live updates offline — polling every 45s"}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", rtStatus === "online" ? "bg-ok animate-pulse" : "bg-line-strong")} />
              {rtStatus === "online" ? "Live" : "Poll"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-1 rounded-md border border-line-strong bg-plaster/60 p-0.5">
            {(["all", "in_house", "departed"] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setStatusFilter(f)}
                className={cn(
                  "h-7 rounded text-xs font-medium transition",
                  statusFilter === f ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine-700"
                )}
              >
                {f === "all" ? "All" : f === "in_house" ? "In-house" : "Departed"}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[380px] lg:max-h-[calc(100vh-300px)] overflow-y-auto scroll-slim divide-y divide-line/70">
          {listLoading && folios.length === 0
            ? [...Array(6)].map((_, i) => (
                <div key={i} className="px-4 py-3 space-y-2">
                  <div className="skeleton h-4 rounded w-2/3" />
                  <div className="skeleton h-3 rounded w-1/2" />
                </div>
              ))
            : folios.length === 0
              ? <div className="px-4 py-10 text-center text-sm text-muted-ink">No open folios match.</div>
              : folios.map((f) => {
                  const active = f.reservationId === selectedId;
                  const settled = f.balance <= 0;
                  const flashing = f.reservationId === flashId;
                  return (
                    <button
                      key={f.reservationId}
                      type="button"
                      onClick={() => selectFolio(f.reservationId)}
                      className={cn(
                        "w-full text-left px-4 py-3 transition hover:bg-plaster-deep/40",
                        active && "bg-pine-100/70 hover:bg-pine-100/70 border-l-2 border-pine-700",
                        !active && flashing && "flash-row border-l-2 border-brass"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-[13px] font-medium text-pine truncate flex items-center gap-1.5">
                          {f.guestName}
                          {flashing && <span className="badge border-brass/50 bg-brass/15 text-brass text-[9px] px-1.5 py-0">UPDATED</span>}
                        </p>
                        <span className={cn("text-[13px] font-semibold whitespace-nowrap", settled ? "text-ok" : "text-warn")}>
                          {settled ? "Settled" : inr(f.balance)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <p className="text-[11px] text-muted-ink truncate flex items-center gap-1">
                          {f.groupMaster && <Crown className="h-3 w-3 text-brass shrink-0" aria-label="Group master folio" />}
                          Room {f.roomNumber} · <span className="font-mono">{f.confirmationNumber}</span>
                        </p>
                        <span className={cn("badge shrink-0", STATUS_BADGE[f.status] ?? "border-line-strong bg-plaster text-muted-ink")}>
                          {STATUS_LABELS[f.status] ?? f.status}
                        </span>
                      </div>
                    </button>
                  );
                })}
        </div>

        <div className="border-t border-line px-4 py-2 flex items-center justify-between text-[11px] text-muted-ink">
          <span>{listLoading ? "…" : `${folios.length} folios`}</span>
          <span>Outstanding: <b className="text-brass">{inr(outstanding)}</b></span>
        </div>
      </aside>

      {/* Right — folio detail */}
      <section className="flex-1 min-w-0 w-full space-y-4">
        {!selectedId ? (
          <div className="panel p-12 flex flex-col items-center justify-center text-center print:hidden">
            <div className="h-12 w-12 rounded-md bg-pine-100 flex items-center justify-center mb-3">
              <ReceiptText className="h-6 w-6 text-pine-700" />
            </div>
            <p className="font-display text-lg font-semibold text-pine">Guest Folio</p>
            <p className="text-sm text-muted-ink mt-1 max-w-xs">
              Select a folio from the list to view charges, record payments and generate the GST tax invoice.
            </p>
          </div>
        ) : detailLoading && !detail ? (
          <div className="space-y-4 print:hidden">
            <div className="panel p-5 space-y-3">
              <div className="skeleton h-6 rounded w-1/3" />
              <div className="skeleton h-4 rounded w-2/3" />
              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="skeleton h-14 rounded" /><div className="skeleton h-14 rounded" /><div className="skeleton h-14 rounded" />
              </div>
            </div>
            <div className="panel p-5"><div className="skeleton h-48 rounded" /></div>
          </div>
        ) : detail ? (
          groupMode ? (
            /* ── Group master-folio panel ── */
            <div className="space-y-4" aria-label="Group billing">
              <div className="panel border-brass/50 overflow-hidden">
                <div className="panel-header bg-brass-50/60 border-b border-brass/30 flex-wrap gap-y-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Layers className="h-4 w-4 text-brass shrink-0" />
                    <p className="panel-title truncate">
                      Group Folio · <span className="font-mono">{group?.code ?? detail.reservation.groupCode}</span>
                    </p>
                    {group && (
                      <span className="badge border-brass/40 bg-panel text-brass shrink-0">{group.grand.rooms} room{group.grand.rooms === 1 ? "" : "s"}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-pine h-8"
                      onClick={openGroupPayment}
                      disabled={!group || group.grand.charges === 0}
                      title="Collect a payment against the group — on the master folio or auto-distributed across rooms"
                    >
                      <HandCoins className="h-4 w-4" />
                      <span className="hidden sm:inline">Collect Payment</span>
                    </button>
                    <button
                      type="button"
                      className="btn-brass h-8"
                      onClick={downloadGroupInvoice}
                      disabled={groupInvoiceDownloading || !group}
                      title="Download the consolidated GST tax invoice for the whole group"
                    >
                      {groupInvoiceDownloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      <span className="hidden sm:inline">Group Invoice</span>
                    </button>
                    <button type="button" className="btn-ghost h-8" onClick={() => setGroupMode(false)}>
                      <ArrowLeft className="h-4 w-4" /> Back to folio
                    </button>
                  </div>
                </div>

                {groupLoading && !group ? (
                  <div className="p-4 space-y-3">
                    <div className="skeleton h-20 rounded" />
                    <div className="skeleton h-40 rounded" />
                  </div>
                ) : !group ? (
                  <p className="p-6 text-sm text-danger text-center">Could not load the group.</p>
                ) : (
                  <>
                    {/* Grand totals strip + settlement progress */}
                    <div className="p-4 border-b border-line bg-plaster/40 space-y-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div className="rounded-md border border-line bg-panel px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wider text-muted-ink">Group charges</p>
                          <p className="font-display font-semibold text-lg text-pine">{inr(group.grand.charges, { decimals: true })}</p>
                        </div>
                        <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wider text-muted-ink">Collected</p>
                          <p className="font-display font-semibold text-lg text-ok">{inr(group.grand.paid, { decimals: true })}</p>
                        </div>
                        <div className={cn("rounded-md border px-3 py-2", group.grand.balance > 0 ? "border-warn/40 bg-warn/10" : "border-ok/40 bg-ok/10")}>
                          <p className="text-[11px] uppercase tracking-wider text-muted-ink">Group balance</p>
                          <p className={cn("font-display font-semibold text-lg", group.grand.balance > 0 ? "text-warn" : "text-ok")}>
                            {inr(group.grand.balance, { decimals: true })}
                          </p>
                        </div>
                        <div className="rounded-md border border-brass/40 bg-brass-50/60 px-3 py-2">
                          <p className="text-[11px] uppercase tracking-wider text-muted-ink">Master payer</p>
                          <p className="text-sm font-semibold text-brass truncate" title={group.masterGuestName ?? "Not designated"}>
                            {group.masterGuestName ? `Room ${group.masterRoomNumber} · ${group.masterGuestName}` : "— not designated"}
                          </p>
                        </div>
                      </div>
                      {/* Settlement progress — how much of the group bill is collected */}
                      {group.grand.charges > 0 && (
                        <div className="flex items-center gap-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((group.grand.paid / group.grand.charges) * 100)} aria-label="Group settlement progress">
                          <div
                              className="h-2 flex-1 rounded-full bg-plaster-deep overflow-hidden border border-line"
                            >
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-pine-700 to-ok transition-all duration-700 bar-grow"
                              style={{ width: `${Math.min(100, Math.max(0, (group.grand.paid / group.grand.charges) * 100))}%` }}
                            />
                          </div>
                          <span className="text-[11px] font-semibold text-muted-ink whitespace-nowrap tabular-nums">
                            {Math.round((group.grand.paid / group.grand.charges) * 100)}% settled
                          </span>
                        </div>
                      )}
                    </div>

                    {!group.masterReservationId && (
                      <div className="mx-4 mt-3 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn flex items-start gap-2">
                        <Crown className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>Designate a master payer folio below to enable charge routing and a single consolidated bill for the group.</span>
                      </div>
                    )}

                    {/* Members table (desktop) */}
                    <div className="p-4 overflow-x-auto scroll-slim hidden md:block">
                      <table className="w-full min-w-[760px]">
                        <thead>
                          <tr>
                            <th className="th">Room</th>
                            <th className="th">Guest</th>
                            <th className="th">Stay</th>
                            <th className="th text-right">Charges</th>
                            <th className="th text-right">Paid</th>
                            <th className="th text-right">Balance</th>
                            <th className="th text-right">Actions</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.members.map((m) => {
                            const routeable = group.masterReservationId && !m.isMaster && m.routeableAmount > 0;
                            const expanded = routeSelectFor === m.reservationId;
                            const selectedAmt = m.routeableItems
                              .filter((i) => routeSelected.has(i.id))
                              .reduce((s, i) => s + i.amount, 0);
                            return (
                              <Fragment key={m.reservationId}>
                              <tr className={cn("hover:bg-plaster/50 transition-colors", m.isMaster ? "bg-brass-50/40 border-l-2 border-l-brass" : "")}>
                                <td className="td">
                                  <span className="inline-flex items-center gap-1.5 font-medium text-pine">
                                    {m.isMaster && <Crown className="h-3.5 w-3.5 text-brass" aria-label="Group master folio" />}
                                    {m.roomNumber}
                                  </span>
                                  <br />
                                  <span className="text-[11px] text-muted-ink">{m.roomTypeName}</span>
                                </td>
                                <td className="td">
                                  {m.guestName}
                                  <br />
                                  <span className="text-[11px] font-mono text-muted-ink">{m.confirmationNumber}</span>
                                </td>
                                <td className="td whitespace-nowrap text-[13px]">
                                  {fmtDateShort(m.checkIn)} – {fmtDateShort(m.checkOut)}
                                  <br />
                                  <span className="text-[11px] text-muted-ink">{m.nights}N · {STATUS_LABELS[m.status] ?? m.status}</span>
                                </td>
                                <td className="td text-right font-medium whitespace-nowrap">{inr(m.charges, { decimals: true })}</td>
                                <td className="td text-right whitespace-nowrap">
                                  <span className="text-ok">{inr(m.paid, { decimals: true })}</span>
                                  {/* mini settlement bar: paid vs charges */}
                                  {m.charges > 0 && (
                                    <span className="block mt-1 h-1 w-full rounded-full bg-plaster-deep border border-line overflow-hidden" aria-hidden>
                                      <span
                                        className="block h-full bg-ok/80 transition-all duration-500"
                                        style={{ width: `${Math.min(100, (m.paid / m.charges) * 100)}%` }}
                                      />
                                    </span>
                                  )}
                                </td>
                                <td className={cn("td text-right font-semibold whitespace-nowrap", m.balance > 0 ? "text-warn" : "text-ok")}>
                                  {inr(m.balance, { decimals: true })}
                                </td>
                                <td className="td text-right whitespace-nowrap">
                                  {m.isMaster ? (
                                    <span className="badge border-brass/40 bg-brass-50 text-brass"><Crown className="h-3 w-3" /> Master</span>
                                  ) : routeable ? (
                                    <button
                                      type="button"
                                      className={cn("btn-outline h-8", expanded && "border-brass bg-brass/10 text-brass")}
                                      disabled={groupBusy}
                                      aria-expanded={expanded}
                                      title={`Pick which of the ${inr(m.routeableAmount, { decimals: true })} unlocked charges move to the master folio`}
                                      onClick={() => openRouteSelect(m)}
                                    >
                                      <ArrowRightLeft className="h-3.5 w-3.5" /> Route ₹{Math.round(m.routeableAmount).toLocaleString("en-IN")}
                                      <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
                                    </button>
                                  ) : (
                                    <span className="inline-flex items-center gap-1 text-[11px] text-muted-ink" title="No unlocked charges to route (or no master designated)">
                                      <Lock className="h-3 w-3" /> {group.masterReservationId ? "Nothing to route" : "No master yet"}
                                    </span>
                                  )}
                                  {!m.isMaster && group.masterReservationId !== m.reservationId && (
                                    <button
                                      type="button"
                                      className="btn-ghost h-8 ml-1"
                                      disabled={groupBusy}
                                      title="Make this folio the group master payer"
                                      onClick={() => designateMaster(m.reservationId)}
                                    >
                                      <Crown className="h-3.5 w-3.5" />
                                    </button>
                                  )}
                                </td>
                              </tr>
                              {expanded && (
                                <tr className="bg-plaster/60">
                                  <td colSpan={7} className="px-4 py-3 border-b border-line">
                                    <div className="rounded-md border border-dashed border-brass/50 bg-panel p-3 expand-in" role="group" aria-label={`Select charges from Room ${m.roomNumber} to route`}>
                                      <div className="flex items-center justify-between gap-2 mb-2">
                                        <p className="text-xs font-semibold text-pine flex items-center gap-1.5">
                                          <Layers className="h-3.5 w-3.5 text-brass" />
                                          Unlocked charges · Room {m.roomNumber} ({m.guestName})
                                        </p>
                                        <button
                                          type="button"
                                          className="text-[11px] text-brass hover:underline font-medium"
                                          onClick={() =>
                                            setRouteSelected((prev) => {
                                              const all = m.routeableItems.every((i) => prev.has(i.id));
                                              const next = new Set(prev);
                                              for (const i of m.routeableItems) {
                                                if (all) next.delete(i.id);
                                                else next.add(i.id);
                                              }
                                              return next;
                                            })
                                          }
                                        >
                                          {m.routeableItems.every((i) => routeSelected.has(i.id)) ? "Deselect all" : "Select all"}
                                        </button>
                                      </div>
                                      <div className="max-h-40 overflow-y-auto scroll-slim divide-y divide-line/60 rounded border border-line">
                                        {m.routeableItems.map((it) => (
                                          <label
                                            key={it.id}
                                            className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-brass-50/40 cursor-pointer text-[13px] transition-colors"
                                          >
                                            <input
                                              type="checkbox"
                                              className="h-3.5 w-3.5 accent-[#1F4B43]"
                                              checked={routeSelected.has(it.id)}
                                              onChange={() => toggleRouteItem(it.id)}
                                            />
                                            <span className="badge border-line bg-plaster text-muted-ink capitalize shrink-0">{CATEGORY_LABELS[it.category] ?? it.category}</span>
                                            <span className="flex-1 min-w-0 truncate" title={it.description}>{it.description}</span>
                                            <span className="text-[11px] text-muted-ink whitespace-nowrap">{fmtDateShort(it.businessDate)}</span>
                                            <span className="font-medium text-pine whitespace-nowrap tabular-nums">{inr(it.amount, { decimals: true })}</span>
                                          </label>
                                        ))}
                                      </div>
                                      <div className="flex items-center justify-between gap-2 mt-2.5">
                                        <p className="text-[11px] text-muted-ink">
                                          Locked (night-audit) charges and promo credits never route · routed lines carry “routed from Room {m.roomNumber}” provenance.
                                        </p>
                                        <div className="flex items-center gap-2 shrink-0">
                                          <button type="button" className="btn-ghost h-8" onClick={() => { setRouteSelectFor(null); setRouteSelected(new Set()); }}>
                                            Cancel
                                          </button>
                                          <button
                                            type="button"
                                            className="btn-brass h-8"
                                            disabled={groupBusy || routeSelected.size === 0}
                                            title={routeSelected.size === 0 ? "Select at least one charge" : `Move ${inr(selectedAmt, { decimals: true })} to the master folio`}
                                            onClick={() => routeToMaster(m.reservationId, [...routeSelected])}
                                          >
                                            {groupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                                            Route {routeSelected.size} selected · {inr(selectedAmt, { decimals: true })}
                                          </button>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                            );
                          })}
                        </tbody>
                        <tfoot>
                          <tr className="bg-plaster/50">
                            <td className="td font-medium" colSpan={3}>Group total · {group.grand.rooms} room(s)</td>
                            <td className="td text-right font-semibold">{inr(group.grand.charges, { decimals: true })}</td>
                            <td className="td text-right font-semibold text-ok">{inr(group.grand.paid, { decimals: true })}</td>
                            <td className={cn("td text-right font-semibold", group.grand.balance > 0 ? "text-warn" : "text-ok")}>{inr(group.grand.balance, { decimals: true })}</td>
                            <td className="td" />
                          </tr>
                        </tfoot>
                      </table>
                    </div>

                    {/* Member cards (mobile) */}
                    <div className="p-4 space-y-2.5 md:hidden">
                      {group.members.map((m) => {
                        const routeable = group.masterReservationId && !m.isMaster && m.routeableAmount > 0;
                        const expanded = routeSelectFor === m.reservationId;
                        const selectedAmt = m.routeableItems
                          .filter((i) => routeSelected.has(i.id))
                          .reduce((s, i) => s + i.amount, 0);
                        return (
                          <div key={m.reservationId} className={cn("rounded-md border p-3 space-y-2", m.isMaster ? "border-brass/50 bg-brass-50/40 border-l-2 border-l-brass" : "border-line bg-panel")}>
                            <div className="flex items-center justify-between gap-2">
                              <p className="font-medium text-pine flex items-center gap-1.5">
                                {m.isMaster && <Crown className="h-3.5 w-3.5 text-brass" />}
                                Room {m.roomNumber} · {m.guestName}
                              </p>
                              <span className={cn("badge", STATUS_BADGE[m.status] ?? "border-line-strong bg-plaster text-muted-ink")}>{STATUS_LABELS[m.status] ?? m.status}</span>
                            </div>
                            <div className="grid grid-cols-3 gap-2 text-center text-[13px]">
                              <div><p className="text-[10px] uppercase text-muted-ink">Charges</p><p className="font-semibold">{inr(m.charges)}</p></div>
                              <div><p className="text-[10px] uppercase text-muted-ink">Paid</p><p className="font-semibold text-ok">{inr(m.paid)}</p></div>
                              <div><p className="text-[10px] uppercase text-muted-ink">Balance</p><p className={cn("font-semibold", m.balance > 0 ? "text-warn" : "text-ok")}>{inr(m.balance)}</p></div>
                            </div>
                            {m.isMaster ? (
                              <p className="badge border-brass/40 bg-brass-50 text-brass w-fit"><Crown className="h-3 w-3" /> Master payer</p>
                            ) : routeable ? (
                              <button
                                type="button"
                                className={cn("btn-outline w-full h-9", expanded && "border-brass bg-brass/10 text-brass")}
                                disabled={groupBusy}
                                aria-expanded={expanded}
                                onClick={() => openRouteSelect(m)}
                              >
                                <ArrowRightLeft className="h-3.5 w-3.5" /> Route {inr(m.routeableAmount)} to master
                                <ChevronDown className={cn("h-3 w-3 ml-auto transition-transform", expanded && "rotate-180")} />
                              </button>
                            ) : null}
                            {expanded && (
                              <div className="rounded-md border border-dashed border-brass/50 bg-panel p-2.5 space-y-2 expand-in" role="group" aria-label={`Select charges from Room ${m.roomNumber} to route`}>
                                <div className="max-h-36 overflow-y-auto scroll-slim divide-y divide-line/60 rounded border border-line">
                                  {m.routeableItems.map((it) => (
                                    <label key={it.id} className="flex items-center gap-2 px-2 py-1.5 hover:bg-brass-50/40 cursor-pointer text-[12px] transition-colors">
                                      <input
                                        type="checkbox"
                                        className="h-3.5 w-3.5 accent-[#1F4B43] shrink-0"
                                        checked={routeSelected.has(it.id)}
                                        onChange={() => toggleRouteItem(it.id)}
                                      />
                                      <span className="flex-1 min-w-0 truncate">{it.description}</span>
                                      <span className="font-medium text-pine tabular-nums">{inr(it.amount)}</span>
                                    </label>
                                  ))}
                                </div>
                                <div className="flex gap-2">
                                  <button type="button" className="btn-ghost h-9 flex-1" onClick={() => { setRouteSelectFor(null); setRouteSelected(new Set()); }}>
                                    Cancel
                                  </button>
                                  <button
                                    type="button"
                                    className="btn-brass h-9 flex-[2]"
                                    disabled={groupBusy || routeSelected.size === 0}
                                    onClick={() => routeToMaster(m.reservationId, [...routeSelected])}
                                  >
                                    {groupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRightLeft className="h-4 w-4" />}
                                    Route {routeSelected.size} · {inr(selectedAmt)}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div className="px-4 pb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-ink">
                      <p>
                        Tap <b className="text-brass">Route</b> to pick which unlocked charges move to the master folio — routed lines carry “routed from Room …” provenance on the consolidated invoice.
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
          <>
            {/* Header card */}
            <div className="panel p-4 sm:p-5 print:hidden">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="font-display text-xl font-semibold text-pine flex items-center gap-1.5">
                      {detail.reservation.groupMaster && <Crown className="h-4 w-4 text-brass" aria-label="Group master payer folio" />}
                      {detail.reservation.guest.fullName}
                    </h2>
                    <span className={cn("badge", STATUS_BADGE[detail.reservation.status] ?? "border-line-strong bg-plaster text-muted-ink")}>
                      {STATUS_LABELS[detail.reservation.status] ?? detail.reservation.status}
                    </span>
                    {detail.reservation.groupCode && (
                      <button
                        type="button"
                        onClick={openGroup}
                        className="badge border-brass/40 bg-brass-50 text-brass hover:bg-brass/20 transition-colors cursor-pointer"
                        title="Open the group master folio — routing, master payer and consolidated invoice"
                      >
                        <Layers className="h-3 w-3" />
                        {detail.reservation.groupCode}
                        <span className="text-[10px] opacity-70">· group folio ›</span>
                      </button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 mt-1.5 text-[13px] text-muted-ink">
                    <span className="inline-flex items-center gap-1">
                      <BedDouble className="h-3.5 w-3.5" />
                      Room <b className="text-ink">{detail.reservation.room?.number ?? "—"}</b> · {detail.reservation.room?.roomType.name ?? "—"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3.5 w-3.5" />{detail.reservation.guest.phone || "—"}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <CalendarDays className="h-3.5 w-3.5" />
                      {fmtDateShort(detail.reservation.checkIn)} – {fmtDateShort(detail.reservation.checkOut)} · {detail.reservation.nights}N
                    </span>
                    <span className="inline-flex items-center gap-1">
                      <Hash className="h-3.5 w-3.5" /><span className="font-mono">{detail.reservation.confirmationNumber}</span>
                    </span>
                  </div>
                </div>
                <button type="button" className="btn-brass" onClick={openPayment}>
                  <HandCoins className="h-4 w-4" /> Make Payment
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 mt-4">
                <div className="rounded-md border border-line bg-plaster/40 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Charges</p>
                  <p className="font-display font-semibold text-lg text-pine">{inr(detail.totals.charges, { decimals: true })}</p>
                </div>
                <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Paid</p>
                  <p className="font-display font-semibold text-lg text-ok">{inr(detail.totals.paid, { decimals: true })}</p>
                </div>
                <div className={cn("rounded-md border px-3 py-2", detail.totals.balance > 0 ? "border-warn/40 bg-warn/10" : "border-ok/40 bg-ok/10")}>
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Balance</p>
                  <p className={cn("font-display font-semibold text-lg", detail.totals.balance > 0 ? "text-warn" : "text-ok")}>
                    {inr(detail.totals.balance, { decimals: true })}
                  </p>
                </div>
              </div>
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)} className="w-full">
              <TabsList className="print:hidden">
                <TabsTrigger value="folio">Folio</TabsTrigger>
                <TabsTrigger value="payments">Payments</TabsTrigger>
                <TabsTrigger value="invoice">Invoice</TabsTrigger>
              </TabsList>

              {/* ── Folio tab ── */}
              <TabsContent value="folio" className="mt-3 print:hidden">
                <div className="panel">
                  <div className="panel-header">
                    <p className="panel-title">Charges &amp; Credits</p>
                    <button type="button" className="btn-pine" onClick={openAddCharge}>
                      <Plus className="h-4 w-4" /> Add Charge
                    </button>
                  </div>
                  <div className="overflow-x-auto scroll-slim">
                    <table className="w-full min-w-[680px]">
                      <thead>
                        <tr>
                          <th className="th">Date</th>
                          <th className="th">Category</th>
                          <th className="th">Description</th>
                          <th className="th text-right">Qty</th>
                          <th className="th text-right">Rate</th>
                          <th className="th text-right">Amount</th>
                          <th className="th text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.items.length === 0 && (
                          <tr><td colSpan={7} className="td text-center text-muted-ink py-8">No charges posted yet — use “Add Charge”.</td></tr>
                        )}
                        {detail.items.map((it) => (
                          <tr key={it.id} className="hover:bg-plaster/50">
                            <td className="td whitespace-nowrap">{fmtDateShort(it.businessDate)}</td>
                            <td className="td">
                              <span className={cn("badge", CATEGORY_BADGE[it.category] ?? "border-line-strong bg-plaster text-muted-ink")}>
                                {CATEGORY_LABELS[it.category] ?? it.category}
                              </span>
                            </td>
                            <td className="td">
                              <span className="inline-flex items-center gap-1.5" title={`${it.locked ? "Locked by night audit · " : ""}Posted by ${it.postedBy || "—"}`}>
                                {it.description}
                                {it.locked && <Lock className="h-3 w-3 text-warn shrink-0" aria-label="Locked by night audit" />}
                              </span>
                            </td>
                            <td className="td text-right">{it.qty % 1 === 0 ? it.qty : it.qty.toFixed(2)}</td>
                            <td className="td text-right whitespace-nowrap">{inr(it.rate, { decimals: true })}</td>
                            <td className={cn("td text-right font-medium whitespace-nowrap", it.amount < 0 && "text-ok")}>
                              {inr(it.amount, { decimals: true })}
                            </td>
                            <td className="td text-right">
                              {it.locked ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-muted-ink" title="Locked by night audit">
                                  <Lock className="h-3 w-3" /> Locked
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-0.5">
                                  <button type="button" className="btn-ghost h-7 px-2" title="Edit charge" onClick={() => openEditCharge(it)}>
                                    <Pencil className="h-3.5 w-3.5" />
                                  </button>
                                  <button type="button" className="btn-ghost h-7 px-2" title="Split / move to another folio" onClick={() => openSplit(it)}>
                                    <ArrowLeftRight className="h-3.5 w-3.5" />
                                  </button>
                                  <button type="button" className="btn-ghost h-7 px-2 text-danger hover:bg-danger/10" title="Void charge" onClick={() => setVoidItem(it)}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-plaster/50">
                          <td className="td font-medium" colSpan={5}>Total charges</td>
                          <td className="td text-right font-semibold">{inr(detail.totals.charges, { decimals: true })}</td>
                          <td className="td" />
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <p className="text-xs text-muted-ink">
                      {detail.items.length} line item{detail.items.length === 1 ? "" : "s"} · charges − payments = balance
                    </p>
                    <p className="text-sm text-muted-ink">
                      Balance due{" "}
                      <span className={cn("font-display text-xl font-semibold ml-1", detail.totals.balance > 0 ? "text-warn" : "text-ok")}>
                        {inr(detail.totals.balance, { decimals: true })}
                      </span>
                    </p>
                  </div>
                </div>
              </TabsContent>

              {/* ── Payments tab ── */}
              <TabsContent value="payments" className="mt-3 print:hidden">
                <div className="panel">
                  <div className="panel-header">
                    <p className="panel-title">Payment History</p>
                    <span className="text-xs text-muted-ink">{detail.payments.length} payment{detail.payments.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="overflow-x-auto scroll-slim">
                    <table className="w-full min-w-[640px]">
                      <thead>
                        <tr>
                          <th className="th">Date</th>
                          <th className="th">Method</th>
                          <th className="th">Reference</th>
                          <th className="th">Received By</th>
                          <th className="th text-right">Amount</th>
                          <th className="th text-right">Receipt</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.payments.length === 0 && (
                          <tr><td colSpan={6} className="td text-center text-muted-ink py-8">No payments recorded — use “Make Payment”.</td></tr>
                        )}
                        {detail.payments.map((p) => (
                          <tr key={p.id} className="hover:bg-plaster/50">
                            <td className="td whitespace-nowrap">{fmtDateTime(p.createdAt)}</td>
                            <td className="td">
                              <span className={cn("badge capitalize", METHOD_BADGE[p.method] ?? "border-line-strong bg-plaster text-muted-ink")}>
                                {p.method}
                              </span>
                            </td>
                            <td className="td font-mono text-xs">{p.reference || "—"}</td>
                            <td className="td">{p.receivedBy || "—"}</td>
                            <td className="td text-right font-medium whitespace-nowrap">{inr(p.amount, { decimals: true })}</td>
                            <td className="td text-right">
                              <button
                                type="button"
                                className="btn-ghost h-7 px-2"
                                disabled={receiptBusyId === p.id}
                                title={`Download receipt for ${inr(p.amount, { decimals: true })}`}
                                aria-label={`Download receipt for payment of ${inr(p.amount, { decimals: true })}`}
                                onClick={() => downloadReceipt(p)}
                              >
                                {receiptBusyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Printer className="h-3.5 w-3.5 text-brass" />}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-plaster/50">
                          <td className="td font-medium" colSpan={5}>Total paid</td>
                          <td className="td text-right font-semibold text-ok">{inr(detail.totals.paid, { decimals: true })}</td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              </TabsContent>

              {/* ── Invoice tab ── */}
              <TabsContent value="invoice" className="mt-3">
                <style>{`@media print { body { background: #fff !important; } }`}</style>
                <div className="flex items-center justify-end gap-2 mb-3 print:hidden">
                  <button type="button" className="btn-outline" onClick={printInvoice} disabled={!invoice || invoiceLoading}>
                    <Printer className="h-4 w-4" /> Print
                  </button>
                  <button type="button" className="btn-outline" onClick={downloadInvoice} disabled={!invoice || invoiceLoading}>
                    <Download className="h-4 w-4" /> Download
                  </button>
                </div>
                <div className="panel p-4 sm:p-8 print:border-0 print:p-0">
                  {invoiceLoading ? (
                    <div className="max-w-3xl mx-auto space-y-3">
                      <div className="skeleton h-8 rounded w-1/2" />
                      <div className="skeleton h-4 rounded w-2/3" />
                      <div className="skeleton h-40 rounded" />
                      <div className="skeleton h-24 rounded" />
                    </div>
                  ) : !invoice ? (
                    <p className="text-sm text-danger text-center py-8">Could not load the invoice.</p>
                  ) : (
                    <InvoiceDoc inv={invoice} />
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </>
          )
        ) : null}
      </section>

      {/* ── Add / Edit charge dialog ── */}
      <Dialog open={chargeOpen} onOpenChange={setChargeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{chargeEdit ? "Edit Charge" : "Add Charge"}</DialogTitle>
            <DialogDescription>
              {chargeEdit ? "Adjust qty, rate or description — amount is recomputed." : `Post a charge to ${detail?.reservation.guest.fullName ?? "the folio"} · Room ${detail?.reservation.room?.number ?? "—"}.`}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div>
              <label className="field-label">Category</label>
              <Select
                value={form.category}
                onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}
                disabled={!!chargeEdit}
              >
                <SelectTrigger className="w-full"><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {CHARGE_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{CATEGORY_LABELS[c] ?? c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="field-label">Description</label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="e.g. Restaurant — Dinner buffet"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Qty</label>
                <Input
                  type="number" min="0" step="any"
                  value={form.qty}
                  onChange={(e) => setForm((f) => ({ ...f, qty: e.target.value }))}
                />
              </div>
              <div>
                <label className="field-label">Rate (₹)</label>
                <Input
                  type="number" step="any"
                  value={form.rate}
                  onChange={(e) => setForm((f) => ({ ...f, rate: e.target.value }))}
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border border-line bg-plaster/40 px-3 py-2">
              <span className="text-xs uppercase tracking-wider text-muted-ink">Amount</span>
              <span className="font-display font-semibold text-pine">{money2(previewAmount)}</span>
            </div>
          </div>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setChargeOpen(false)} disabled={saving}>Cancel</button>
            <button type="button" className="btn-pine" onClick={submitCharge} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {chargeEdit ? "Save Changes" : "Post Charge"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Split charge dialog ── */}
      <Dialog open={splitOpen} onOpenChange={setSplitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Split Charge</DialogTitle>
            <DialogDescription>
              Move all or part of “{splitItem?.description}” to another folio.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="rounded-md border border-line bg-plaster/40 px-3 py-2 flex items-center justify-between text-sm">
              <span className="text-muted-ink">Rate</span>
              <span className="font-medium">{inr(splitItem?.rate ?? 0, { decimals: true })} × <b id="split-max">{splitItem?.qty ?? 0}</b> = {money2((splitItem?.rate ?? 0) * (splitItem?.qty ?? 0))}</span>
            </div>
            <div>
              <label className="field-label">Qty to move (max {splitItem?.qty ?? 0})</label>
              <Input
                type="number" min="0" step="any"
                value={splitQty}
                onChange={(e) => setSplitQty(e.target.value)}
              />
            </div>
            <div>
              <label className="field-label">Target folio</label>
              <Select value={splitTarget} onValueChange={setSplitTarget}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select target reservation" /></SelectTrigger>
                <SelectContent>
                  {splitTargets.group.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Same group · {splitTargets.groupCode}</SelectLabel>
                      {splitTargets.group.map((f) => (
                        <SelectItem key={f.reservationId} value={f.reservationId}>
                          {f.guestName} · Room {f.roomNumber}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                  <SelectGroup>
                    <SelectLabel>{splitTargets.group.length > 0 ? "Other open folios" : "Open folios"}</SelectLabel>
                    {splitTargets.rest.map((f) => (
                      <SelectItem key={f.reservationId} value={f.reservationId}>
                        {f.guestName} · Room {f.roomNumber}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <p className="text-xs text-muted-ink">
              Moving the full qty removes the charge from this folio; a matching charge (suffix “split from …”) is posted to the target.
            </p>
          </div>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setSplitOpen(false)} disabled={saving}>Cancel</button>
            <button type="button" className="btn-pine" onClick={submitSplit} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowLeftRight className="h-4 w-4" />}
              Move Charge
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Payment dialog ── */}
      <Dialog open={payOpen} onOpenChange={setPayOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Record Payment</DialogTitle>
            <DialogDescription>
              {detail?.reservation.guest.fullName} · Room {detail?.reservation.room?.number ?? "—"} · Balance {money2(detail?.totals.balance ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            <div className="flex gap-1.5">
              <button
                type="button"
                className="badge border-line-strong bg-plaster hover:bg-plaster-deep cursor-pointer"
                onClick={() => setPayAmount(String(Math.max(0, round2(detail?.totals.balance ?? 0))))}
              >
                Full balance
              </button>
              <button
                type="button"
                className="badge border-line-strong bg-plaster hover:bg-plaster-deep cursor-pointer"
                onClick={() => setPayAmount(String(round2(Math.max(0, detail?.totals.balance ?? 0) / 2)))}
              >
                50%
              </button>
            </div>
            <div>
              <label className="field-label">Amount (₹)</label>
              <Input
                type="number" min="0" step="any"
                value={payAmount}
                onChange={(e) => setPayAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="field-label">Method</label>
              <Select value={payMethod} onValueChange={setPayMethod}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHODS.filter((m) => !gateways.some((g) => g.provider === m)).map((m) => (
                    <SelectItem key={m} value={m} className="capitalize">{m.toUpperCase()}</SelectItem>
                  ))}
                  {gateways.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Online gateway</SelectLabel>
                      {gateways.map((g) => (
                        <SelectItem key={g.id} value={g.provider}>
                          {(g.label || gatewayLabel(g.provider)).toUpperCase()}{g.mode === "live" ? " · LIVE" : " · TEST"}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="field-label">Reference (optional)</label>
              <Input
                value={payReference}
                onChange={(e) => setPayReference(e.target.value)}
                placeholder="e.g. UPI/123456789, TXN-8891"
              />
            </div>
          </div>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setPayOpen(false)} disabled={saving}>Cancel</button>
            <button type="button" className="btn-brass" onClick={submitPayment} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
              Record Payment
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Group payment collection ── */}
      <Dialog open={groupPayOpen} onOpenChange={setGroupPayOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="h-5 w-5 text-brass" /> Collect Group Payment
            </DialogTitle>
            <DialogDescription>
              Group <span className="font-mono">{group?.code}</span> · {group?.grand.rooms} room(s) · balance {money2(group?.grand.balance ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-1">
            {/* Mode selector — two cards */}
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Payment mode">
              <button
                type="button"
                role="radio"
                aria-checked={groupPayMode === "master"}
                disabled={!group?.masterReservationId}
                onClick={() => setGroupPayMode("master")}
                className={cn(
                  "rounded-md border p-3 text-left transition-all disabled:opacity-45 disabled:cursor-not-allowed",
                  groupPayMode === "master" ? "border-brass bg-brass-50/70 ring-1 ring-brass/40" : "border-line bg-panel hover:border-brass/40"
                )}
              >
                <p className="text-[13px] font-semibold text-pine flex items-center gap-1.5">
                  <Crown className={cn("h-3.5 w-3.5", groupPayMode === "master" ? "text-brass" : "text-muted-ink")} /> Master folio
                </p>
                <p className="text-[11px] text-muted-ink mt-1 leading-snug">
                  Single payment on {group?.masterGuestName ? `Room ${group.masterRoomNumber} · ${group.masterGuestName}` : "the designated payer"}. Allows overpayment (advance).
                </p>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={groupPayMode === "distribute"}
                onClick={() => setGroupPayMode("distribute")}
                className={cn(
                  "rounded-md border p-3 text-left transition-all",
                  groupPayMode === "distribute" ? "border-brass bg-brass-50/70 ring-1 ring-brass/40" : "border-line bg-panel hover:border-brass/40"
                )}
              >
                <p className="text-[13px] font-semibold text-pine flex items-center gap-1.5">
                  <ArrowRightLeft className={cn("h-3.5 w-3.5", groupPayMode === "distribute" ? "text-brass" : "text-muted-ink")} /> Auto-distribute
                </p>
                <p className="text-[11px] text-muted-ink mt-1 leading-snug">
                  Split across room folios by outstanding balance — largest balance first, capped at the group balance.
                </p>
              </button>
            </div>

            <div className="flex gap-1.5">
              <button type="button" className="badge border-line-strong bg-plaster hover:bg-plaster-deep cursor-pointer" onClick={() => setGroupPayAmount(String(Math.max(0, round2(group?.grand.balance ?? 0))))}>
                Full balance
              </button>
              <button type="button" className="badge border-line-strong bg-plaster hover:bg-plaster-deep cursor-pointer" onClick={() => setGroupPayAmount(String(round2(Math.max(0, (group?.grand.balance ?? 0) / 2))))}>
                50%
              </button>
            </div>
            <div>
              <label className="field-label">Amount (₹)</label>
              <Input
                type="number" min="0" step="any"
                value={groupPayAmount}
                onChange={(e) => setGroupPayAmount(e.target.value)}
                placeholder="0.00"
              />
              {groupPayMode === "master" && Number(groupPayAmount) > (group?.grand.balance ?? 0) && (
                <p className="text-[11px] text-brass mt-1 flex items-center gap-1">
                  <Crown className="h-3 w-3" /> Exceeds the group balance — recorded as an advance on the master folio.
                </p>
              )}
            </div>

            {/* Distribute preview — waterfall allocation */}
            {groupPayMode === "distribute" && groupPayPreview.length > 0 && (
              <div className="rounded-md border border-line bg-plaster/50 p-3" aria-live="polite">
                <p className="text-[11px] uppercase tracking-wider text-muted-ink mb-1.5">Allocation preview</p>
                <div className="space-y-1">
                  {groupPayPreview.map((p, idx) => (
                    <div key={p.roomNumber} className="flex items-center gap-2 text-[13px]">
                      <span className="h-1.5 w-1.5 rounded-full bg-brass shrink-0" aria-hidden />
                      <span className="font-medium text-pine w-16 shrink-0 whitespace-nowrap">Room {p.roomNumber}</span>
                      <span className="text-muted-ink flex-1 min-w-0 truncate">{p.guestName} · owed {money2(p.balance)}</span>
                      <span className="font-semibold text-ok tabular-nums">{money2(p.allocated)}</span>
                      {idx === 0 && <span className="badge border-line bg-panel text-[10px] text-muted-ink shrink-0">first</span>}
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-muted-ink mt-2">
                  Total allocated {money2(groupPayPreview.reduce((s, p) => s + p.allocated, 0))} of {money2(Number(groupPayAmount) || 0)}
                </p>
              </div>
            )}
            {groupPayMode === "distribute" && Number(groupPayAmount) > (group?.grand.balance ?? 0) && (group?.grand.balance ?? 0) > 0 && (
              <p className="text-[11px] text-warn">Amount will be capped at the total group balance {money2(group?.grand.balance ?? 0)}.</p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Method</label>
                <Select value={groupPayMethod} onValueChange={setGroupPayMethod}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PAYMENT_METHODS.filter((m) => !gateways.some((g) => g.provider === m)).map((m) => (
                      <SelectItem key={m} value={m} className="capitalize">{m.toUpperCase()}</SelectItem>
                    ))}
                    {gateways.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Online gateway</SelectLabel>
                        {gateways.map((g) => (
                          <SelectItem key={g.id} value={g.provider}>
                            {(g.label || gatewayLabel(g.provider)).toUpperCase()}{g.mode === "live" ? " · LIVE" : " · TEST"}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="field-label">Reference (optional)</label>
                <Input value={groupPayReference} onChange={(e) => setGroupPayReference(e.target.value)} placeholder="e.g. UPI/12345, TXN-8891" />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setGroupPayOpen(false)} disabled={groupPayBusy}>Cancel</button>
            <button type="button" className="btn-brass" onClick={submitGroupPayment} disabled={groupPayBusy}>
              {groupPayBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />}
              {groupPayMode === "master" ? "Record on Master Folio" : "Distribute & Record"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Void confirm ── */}
      <AlertDialog open={!!voidItem} onOpenChange={(o) => !o && setVoidItem(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Void this charge?</AlertDialogTitle>
            <AlertDialogDescription>
              “{voidItem?.description}” ({money2(voidItem?.amount ?? 0)}) will be removed from the folio. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={voiding}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="btn-danger" onClick={(e) => { e.preventDefault(); confirmVoid(); }} disabled={voiding}>
              {voiding && <Loader2 className="h-4 w-4 animate-spin" />} Void charge
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Invoice document ────────────────────────────────────────────────────────

/** CGST/SGST halves of a GST amount — intra-state supply (hotels bill within their own state). */
function splitHalf(total: number): number {
  return Math.round((total / 2) * 100) / 100;
}

/**
 * White-labeled GST tax invoice document (screen + print).
 * Every printed line belongs to the tenant's own hotel — no platform branding.
 */
function InvoiceDoc({ inv }: { inv: InvoicePayload }) {
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
      <table className="w-full mt-4">
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
