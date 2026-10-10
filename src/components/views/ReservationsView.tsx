"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate, toISODate, todayISO, addDays, nightsBetween, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Plus, Search, Loader2, MoreHorizontal, LogIn, LogOut, Pencil, XCircle, CheckCheck,
  CalendarDays, CalendarClock, Users, FileImage, IndianRupee, Printer, Layers, TicketPercent, ReceiptIndianRupee, Check, BedDouble,
  Download, ChevronDown, Wallet, Trash2,
} from "lucide-react";
import { receiptHtml, type ReceiptPayload } from "@/lib/receipt-html";
import { invoiceHtml, type InvoicePayload } from "@/lib/invoice-format";
import { printHtml } from "@/lib/print";
import { InvoiceDoc } from "@/components/shared/InvoiceDoc";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { GuestAvatar } from "@/components/views/GuestsView";
import { Input } from "@/components/ui/input";

interface GuestLite { id: string; fullName: string; phone: string; email: string; photoUrl?: string; idType?: string; idNumber?: string }
interface RoomLite { id: string; number: string; floor: number; status: string; roomType: { id: string; name: string; code: string; baseRate: number } }
interface RoomTypeLite { id: string; name: string; code: string; baseRate: number; maxOccupancy: number }

interface Reservation {
  id: string;
  confirmationNumber: string;
  status: string;
  source: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  adults: number;
  children: number;
  nightlyRate: number;
  totalAmount: number;
  discountAmount?: number;
  promoCode?: string;
  paidAmount: number;
  notes: string;
  groupCode: string;
  idProofData?: string;
  roomId: string | null;
  roomTypeId: string | null;
  guest: GuestLite;
  room: { id: string; number: string; roomType: { id: string; name: string; code: string } } | null;
  roomType: { id: string; name: string; code: string; baseRate: number } | null;
}

interface CalendarRes { id: string; roomId: string | null; checkIn: string; checkOut: string; status: string }
interface FolioItem { id: string; category: string; description: string; amount: number; qty: number }

const STATUS_BADGE: Record<string, string> = {
  confirmed: "border-pine-700/30 bg-pine-100 text-pine-700",
  checked_in: "border-ok/40 bg-ok/10 text-ok",
  checked_out: "border-line-strong bg-plaster text-muted-ink",
  cancelled: "border-danger/30 bg-danger/10 text-danger",
  no_show: "border-danger/40 bg-danger/15 text-danger",
  hold: "border-warn/40 bg-warn/10 text-warn",
};

/** Colored channel badges so the booking source is scannable at a glance. */
const SOURCE_BADGE: Record<string, string> = {
  front_desk: "border-pine-700/30 bg-pine-100 text-pine-700",
  booking_engine: "border-brass/40 bg-brass/10 text-brass",
  walk_in: "border-ok/40 bg-ok/10 text-ok",
  ota: "border-warn/40 bg-warn/10 text-warn",
  phone: "border-line-strong bg-plaster text-muted-ink",
};
const SOURCE_LABEL: Record<string, string> = {
  front_desk: "Front Desk",
  booking_engine: "Booking Engine",
  walk_in: "Walk-in",
  ota: "OTA",
  phone: "Phone",
};

const SOURCE_OPTIONS = [
  { value: "front_desk", label: "Front Desk" },
  { value: "booking_engine", label: "Booking Engine" },
  { value: "walk_in", label: "Walk-in" },
  { value: "ota", label: "OTA" },
  { value: "phone", label: "Phone" },
];

const STATUS_FILTERS = [
  { value: "all", label: "All Statuses" },
  { value: "confirmed", label: "Confirmed" },
  { value: "checked_in", label: "Checked In" },
  { value: "hold", label: "Hold" },
  { value: "checked_out", label: "Checked Out" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No-Show" },
];

/** Room ids blocked for [checkIn, checkOut) derived from the calendar window. */
async function unavailableRoomIds(checkIn: string, checkOut: string, excludeId?: string): Promise<Set<string>> {
  const days = Math.max(1, nightsBetween(checkIn, checkOut)) + 1;
  const data = await api<{ reservations: CalendarRes[] }>(`/api/calendar?start=${checkIn}&days=${days}`);
  const blocked = new Set<string>();
  for (const res of data.reservations) {
    if (excludeId && res.id === excludeId) continue;
    if (!res.roomId) continue;
    const ci = toISODate(new Date(res.checkIn));
    const co = toISODate(new Date(res.checkOut));
    if (ci < checkOut && co > checkIn) blocked.add(res.roomId);
  }
  return blocked;
}

interface PropertyLite { name: string; address: string; city: string; gstin: string; phone: string }

const FALLBACK_PROPERTY: PropertyLite = {
  name: "The Royal Grand Hotel", address: "", city: "", gstin: "27AABCU9603R1ZM", phone: "",
};

/**
 * Printable guest registration card (Indian hotel front-desk compliance form).
 * One card per page when multiple reservations are passed (group printing).
 * Photos are enriched at print time via GET /api/reservations/[id]?withIdProof=1
 * (guest headshot + the ID-proof snapshot captured at check-in).
 */
async function printRegistrationCards(reservations: Reservation[], property: PropertyLite, printedBy: string) {
  if (reservations.length === 0) return;
  const w = window.open("", "_blank", "width=880,height=760");

  // Enrich with photos — falls back to the list row if the detail fetch fails.
  const enriched = await Promise.all(
    reservations.map((r) =>
      api<{ reservation: Reservation }>(`/api/reservations/${r.id}?withIdProof=1`)
        .then((d) => d.reservation)
        .catch(() => r)
    )
  );
  if (!w) return; // popup blocked

  const idLabel = (t?: string) => (t ? t.toUpperCase() : "ID");
  const photoBox = (r: Reservation) => {
    const url = r.guest.photoUrl ?? "";
    return `
      <div class="photo-wrap">
        ${url
          ? `<img class="photo" src="${url}" alt="Guest photograph" />`
          : `<div class="photo photo-empty">AFFIX<br/>PHOTO</div>`}
        <p class="photo-cap">Guest photograph</p>
      </div>`;
  };
  const idProofBox = (r: Reservation) =>
    r.idProofData
      ? `<div class="idproof-wrap"><img class="idproof" src="${r.idProofData}" alt="Captured ID proof" /><p class="photo-cap">ID proof captured at check-in</p></div>`
      : "";
  const discountNote = (r: Reservation) =>
    (r.discountAmount ?? 0) > 0
      ? ` <span class="meta">incl. ${r.promoCode ?? "promo"} −${inr(r.discountAmount ?? 0)}</span>`
      : "";

  const card = (r: Reservation) => `
    <section class="card">
      <div class="head">
        <div>
          <h1>${property.name}</h1>
          <p class="meta">${[property.address, property.city].filter(Boolean).join(", ") || "Hotel Guest Registration"}${property.phone ? ` · ${property.phone}` : ""}</p>
        </div>
        <div class="head-right">
          ${photoBox(r)}
          <div class="badge">GUEST<br/>REGISTRATION</div>
        </div>
      </div>
      <table class="kv">
        <tr><th>Confirmation #</th><td class="mono">${r.confirmationNumber}</td><th>Date of Arrival</th><td>${fmtDate(r.checkIn)}</td></tr>
        <tr><th>Guest Name</th><td>${r.guest.fullName}</td><th>Date of Departure</th><td>${fmtDate(r.checkOut)}</td></tr>
        <tr><th>Phone</th><td>${r.guest.phone || "—"}</td><th>Room / Type</th><td>${r.room?.number ?? "To be assigned"} · ${r.roomType?.code ?? r.room?.roomType?.code ?? "—"}</td></tr>
        <tr><th>Email</th><td>${r.guest.email || "—"}</td><th>Pax (Adults / Children)</th><td>${r.adults} / ${r.children}</td></tr>
        <tr><th>${idLabel(r.guest.idType)} No.</th><td>${r.guest.idNumber || "____________________"}</td><th>Nights / Rate</th><td>${r.nights} · ${inr(r.nightlyRate)}</td></tr>
        <tr><th>Group Code</th><td>${r.groupCode || "—"}</td><th>Total Charges</th><td>${inr(r.totalAmount)} <span class="meta">(paid ${inr(r.paidAmount)})</span>${discountNote(r)}</td></tr>
      </table>
      ${idProofBox(r)}
      <div class="terms">
        <p><b>Terms of stay:</b> Check-out time is 12:00 noon. A valid government photo ID is mandatory as per Section 17 of the Immigration (Report on Foreigners) Rules. Foreign nationals must present a passport; C-Form will be filed with FRRO. Guests are responsible for their valuables. In-room consumption will be charged to the folio.</p>
      </div>
      <div class="sign">
        <div><span class="line"></span><p>Guest Signature</p></div>
        <div><span class="line"></span><p>Front Desk — ${printedBy}</p></div>
      </div>
    </section>`;

  const cards = enriched.map(card).join(`
    <div class="pagebreak"></div>`);

  w.document.write(`<!doctype html><html><head><title>Registration Card${reservations.length > 1 ? "s" : ""} — ${property.name}</title><style>
      body{font-family:Georgia,serif;color:#1F2A26;padding:24px;max-width:820px;margin:auto}
      h1{font-size:20px;margin:0;color:#0F2622;letter-spacing:.02em}
      .meta{color:#7A6F5D;font-size:11px;margin-top:2px}
      .card{border:1px solid #D3C3A4;border-radius:8px;padding:20px 24px;background:#FBF8F2}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #B9873E;padding-bottom:10px;margin-bottom:12px}
      .head-right{display:flex;align-items:flex-start;gap:14px}
      .photo-wrap,.idproof-wrap{text-align:center}
      .photo{width:64px;height:78px;object-fit:cover;border:1.5px solid #B9873E;border-radius:4px;background:#fff;display:block}
      .photo-empty{display:flex;align-items:center;justify-content:center;font-family:Helvetica,Arial,sans-serif;font-size:8.5px;letter-spacing:.12em;color:#B9873E;text-align:center;line-height:1.6}
      .photo-cap{font-family:Helvetica,Arial,sans-serif;font-size:8px;color:#7A6F5D;margin-top:3px;text-transform:uppercase;letter-spacing:.08em}
      .idproof-wrap{display:inline-block;margin:2px 0 10px;padding:6px 10px;border:1px dashed #D3C3A4;border-radius:6px;background:#F5ECDD}
      .idproof{max-height:88px;max-width:220px;object-fit:contain;border:1px solid #D3C3A4;border-radius:4px;background:#fff;display:block;margin:0 auto}
      .badge{font-family:Helvetica,Arial,sans-serif;font-size:10px;letter-spacing:.14em;color:#B9873E;border:1.5px solid #B9873E;border-radius:4px;padding:6px 10px;text-align:center;line-height:1.5}
      table.kv{width:100%;border-collapse:collapse;font-size:12.5px;font-family:Helvetica,Arial,sans-serif}
      table.kv th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#7A6F5D;padding:6px 10px 6px 0;width:17%;border-bottom:1px solid #E3D7C1}
      table.kv td{padding:6px 8px;border-bottom:1px solid #E3D7C1}
      .mono{font-family:ui-monospace,monospace;font-weight:600;color:#1F4B43}
      .terms{margin-top:12px;font-family:Helvetica,Arial,sans-serif;font-size:10.5px;color:#5B5648;background:#EFE6D8;border-radius:6px;padding:10px 12px;line-height:1.5}
      .sign{display:flex;justify-content:space-between;margin-top:34px;font-family:Helvetica,Arial,sans-serif;font-size:11px}
      .sign .line{display:block;width:220px;border-bottom:1px solid #1F2A26;height:26px}
      .sign p{margin:4px 0 0;color:#7A6F5D;font-size:10px;text-transform:uppercase;letter-spacing:.08em}
      .pagebreak{height:0;page-break-after:always;margin:18px 0}
      @media print{body{padding:0}.card{border:none;background:#fff}.pagebreak{margin:0}}
    </style></head><body>
    ${cards}
    <p class="meta" style="margin-top:18px">Velurex HMS · Computer-generated registration card · GSTIN ${property.gstin || "—"}</p>
    <script>window.onload=()=>window.print()<\/script>
    </body></html>`);
  w.document.close();
}

export default function ReservationsView() {
  const { toast } = useToast();
  const user = useSession((s) => s.user);
  const canAct = user?.role === "hotel_admin" || user?.role === "front_desk";
  const isAdmin = user?.role === "hotel_admin";

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // dialogs
  const [newOpen, setNewOpen] = useState(false);
  const [modifyRes, setModifyRes] = useState<Reservation | null>(null);
  const [checkInRes, setCheckInRes] = useState<Reservation | null>(null);
  const [checkOutRes, setCheckOutRes] = useState<Reservation | null>(null);
  const [cancelRes, setCancelRes] = useState<Reservation | null>(null);
  // Delete (permanent removal) — hotel_admin only, terminal stays only.
  const [deleteRes, setDeleteRes] = useState<Reservation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [groupOpen, setGroupOpen] = useState<string | null>(null); // group code
  const [property, setProperty] = useState<PropertyLite>(FALLBACK_PROPERTY);

  // Invoice & details dialog — available on every row (incl. checked-out)
  const [invoiceRes, setInvoiceRes] = useState<Reservation | null>(null);
  const [invoiceData, setInvoiceData] = useState<InvoicePayload | null>(null);
  const [invoiceLoading, setInvoiceLoading] = useState(false);
  const [invoiceError, setInvoiceError] = useState("");

  // Property details (address/GSTIN) enrich the printable registration card
  useEffect(() => {
    api<{ property: PropertyLite }>("/api/settings")
      .then((d) => setProperty({ ...FALLBACK_PROPERTY, ...d.property }))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<{ reservations: Reservation[] }>("/api/reservations?limit=300");
      setReservations(data.reservations);
    } catch (e) {
      toast({ title: "Could not load reservations", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  // Global search from the topbar
  useEffect(() => {
    const handler = (e: Event) => setSearch((e as CustomEvent<string>).detail ?? "");
    window.addEventListener("velurex:search", handler);
    return () => window.removeEventListener("velurex:search", handler);
  }, []);

  // Quick actions (dashboard) can ask this view to open its New Reservation dialog
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent<string>).detail === "new-reservation" && canAct) setNewOpen(true);
    };
    window.addEventListener("velurex:open-dialog", handler);
    return () => window.removeEventListener("velurex:open-dialog", handler);
  }, [canAct]);

  const filtered = useMemo(
    () =>
      reservations.filter((r) => {
        if (statusFilter !== "all" && r.status !== statusFilter) return false;
        if (!search) return true;
        const q = search.toLowerCase();
        return (
          r.guest.fullName.toLowerCase().includes(q) ||
          r.confirmationNumber.toLowerCase().includes(q) ||
          (r.room?.number ?? "").toLowerCase().includes(q)
        );
      }),
    [reservations, statusFilter, search]
  );

  // Group bookings present in the current result set (chip bar above the table)
  const groups = useMemo(() => {
    const map = new Map<string, Reservation[]>();
    for (const r of reservations) {
      if (!r.groupCode) continue;
      if (r.status === "cancelled") continue;
      const list = map.get(r.groupCode) ?? [];
      list.push(r);
      map.set(r.groupCode, list);
    }
    return [...map.entries()]
      .map(([code, members]) => ({
        code,
        members,
        rooms: members.filter((m) => m.room).length,
        pax: members.reduce((n, m) => n + m.adults + m.children, 0),
        total: members.reduce((n, m) => n + m.totalAmount, 0),
        arrivals: members.filter((m) => m.status === "confirmed" || m.status === "hold").length,
        inHouse: members.filter((m) => m.status === "checked_in").length,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [reservations]);

  async function cancelReservation() {
    if (!cancelRes) return;
    try {
      await api(`/api/reservations/${cancelRes.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
      toast({ title: "Reservation cancelled", description: `${cancelRes.confirmationNumber} — ${cancelRes.guest.fullName}` });
      setCancelRes(null);
      load();
    } catch (e) {
      toast({ title: "Could not cancel", description: (e as Error).message, variant: "destructive" });
    }
  }

  async function deleteReservation() {
    if (!deleteRes || deleting) return;
    setDeleting(true);
    try {
      await api(`/api/reservations/${deleteRes.id}`, { method: "DELETE" });
      toast({ title: "Reservation deleted", description: `${deleteRes.confirmationNumber} — ${deleteRes.guest.fullName} removed with its folio and payments.` });
      setDeleteRes(null);
      load();
    } catch (e) {
      toast({ title: "Could not delete", description: (e as Error).message, variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  }

  async function confirmHold(res: Reservation) {
    try {
      await api(`/api/reservations/${res.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) });
      toast({ title: "Reservation confirmed", description: `${res.confirmationNumber} moved from hold to confirmed.` });
      load();
    } catch (e) {
      toast({ title: "Could not confirm", description: (e as Error).message, variant: "destructive" });
    }
  }

  // Fetch the white-labeled GST invoice whenever a row's invoice action opens
  useEffect(() => {
    if (!invoiceRes) {
      setInvoiceData(null);
      setInvoiceError("");
      return;
    }
    let cancelled = false;
    setInvoiceLoading(true);
    setInvoiceError("");
    setInvoiceData(null);
    api<InvoicePayload>(`/api/invoice/${invoiceRes.id}`)
      .then((d) => {
        if (!cancelled) setInvoiceData(d);
      })
      .catch((e) => {
        if (!cancelled) setInvoiceError(e instanceof Error ? e.message : "Could not load the invoice");
      })
      .finally(() => {
        if (!cancelled) setInvoiceLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [invoiceRes]);

  function downloadInvoice() {
    if (!invoiceData) return;
    const blob = new Blob([invoiceHtml(invoiceData)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${invoiceData.invoiceNo}.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Invoice downloaded", description: `${invoiceData.invoiceNo} · ${invoiceData.hotel.name}` });
  }

  if (loading) {
    return (
      <div className="panel p-6 space-y-3">
        {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-10 rounded" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative lg:w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" />
          <input
            className="field pl-8 h-9"
            placeholder="Search guest, confirmation #…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine" onClick={() => setSearch("")} aria-label="Clear search">
              <XCircle className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="lg:w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="text-xs text-muted-ink lg:ml-3 hidden md:block">
          {filtered.length} reservation{filtered.length === 1 ? "" : "s"}
        </div>
        {canAct && (
          <button className="btn-brass lg:ml-auto self-start" onClick={() => setNewOpen(true)}>
            <Plus className="h-4 w-4" /> New Reservation
          </button>
        )}
      </div>

      {/* Group bookings */}
      {groups.length > 0 && (
        <div className="panel px-4 py-3 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-ink mr-1">
            <Layers className="h-3.5 w-3.5 text-brass" /> Group bookings
          </span>
          {groups.map((g) => (
            <button
              key={g.code}
              onClick={() => setGroupOpen(g.code)}
              className="badge border-brass/40 bg-brass/10 text-brass hover:bg-brass/20 transition cursor-pointer px-3 py-1.5 flex items-center gap-2"
              aria-label={`Open group ${g.code}`}
            >
              <span className="font-mono font-semibold">{g.code}</span>
              <span className="text-[11px] opacity-80">{g.members.length} rooms · {g.pax} pax · {inr(g.total)}</span>
              {g.arrivals > 0 && <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden />}
            </button>
          ))}
        </div>
      )}

      {/* Table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Reservations</p>
          <CalendarDays className="h-4 w-4 text-brass" />
        </div>
        <div className="overflow-x-auto scroll-slim">
          <table className="w-full min-w-[980px]">
            <thead>
              <tr>
                <th className="th">Confirmation #</th>
                <th className="th">Guest</th>
                <th className="th">Room</th>
                <th className="th">Check-in</th>
                <th className="th">Check-out</th>
                <th className="th">Nights</th>
                <th className="th">Rate/night</th>
                <th className="th">Total</th>
                <th className="th">Source</th>
                <th className="th">Status</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id} className="hover:bg-plaster/50">
                  <td className="td font-mono text-[12px] text-pine font-medium">{r.confirmationNumber}</td>
                  <td className="td">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <GuestAvatar name={r.guest.fullName} photoUrl={r.guest.photoUrl} size={30} />
                      <div className="leading-tight min-w-0">
                        <p className="font-medium text-pine text-[13px] truncate max-w-[130px]" title={r.guest.fullName}>{r.guest.fullName}</p>
                        <p className="text-[11px] text-muted-ink">{r.guest.phone}</p>
                      </div>
                    </div>
                  </td>
                  <td className="td">
                    {r.room ? (
                      <span className="font-medium">{r.room.number}</span>
                    ) : (
                      <span className="badge border-warn/40 bg-warn/10 text-warn">Unassigned</span>
                    )}
                    {r.roomType && <span className="ml-1.5 text-[11px] text-muted-ink">{r.roomType.code}</span>}
                  </td>
                  <td className="td whitespace-nowrap">{fmtDate(r.checkIn)}</td>
                  <td className="td whitespace-nowrap">{fmtDate(r.checkOut)}</td>
                  <td className="td">{r.nights}</td>
                  <td className="td">{inr(r.nightlyRate)}</td>
                  <td className="td font-medium text-pine">{inr(r.totalAmount)}</td>
                  <td className="td">
                    <span
                      className={cn("badge", SOURCE_BADGE[r.source] ?? "border-line-strong bg-plaster text-muted-ink")}
                      title={`Booked via ${SOURCE_LABEL[r.source] ?? r.source}`}
                    >
                      {SOURCE_LABEL[r.source] ?? r.source.replace("_", " ")}
                    </span>
                  </td>
                  <td className="td">
                    <span className={cn("badge", STATUS_BADGE[r.status])}>{STATUS_LABELS[r.status] ?? r.status}</span>
                  </td>
                  <td className="td text-right">
                    {canAct ? (
                      ["confirmed", "hold", "checked_in"].includes(r.status) ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="btn-ghost px-2 h-7" aria-label={`Actions for ${r.confirmationNumber}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuItem onClick={() => setInvoiceRes(r)} className="gap-2">
                              <ReceiptIndianRupee className="h-3.5 w-3.5 text-brass" /> Invoice &amp; Details
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {["confirmed", "hold"].includes(r.status) && (
                              <DropdownMenuItem onClick={() => setCheckInRes(r)} className="gap-2">
                                <LogIn className="h-3.5 w-3.5 text-ok" /> Check In
                              </DropdownMenuItem>
                            )}
                            {r.status === "checked_in" && (
                              <DropdownMenuItem onClick={() => setCheckOutRes(r)} className="gap-2">
                                <LogOut className="h-3.5 w-3.5 text-warn" /> Check Out
                              </DropdownMenuItem>
                            )}
                            {r.status === "hold" && (
                              <DropdownMenuItem onClick={() => confirmHold(r)} className="gap-2">
                                <CheckCheck className="h-3.5 w-3.5 text-ok" /> Confirm Hold
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => setModifyRes(r)} className="gap-2">
                              <Pencil className="h-3.5 w-3.5" /> Modify
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => printRegistrationCards([r], property, user?.name ?? "Front Desk")} className="gap-2">
                              <Printer className="h-3.5 w-3.5 text-brass" /> Print Reg. Card
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {r.status !== "checked_in" && (
                              <DropdownMenuItem onClick={() => setCancelRes(r)} className="gap-2 text-danger focus:text-danger">
                                <XCircle className="h-3.5 w-3.5" /> Cancel
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          <button
                            className="btn-outline h-7 px-2.5 text-xs gap-1.5"
                            onClick={() => setInvoiceRes(r)}
                            aria-label={`View invoice and details for ${r.confirmationNumber}`}
                            title="View invoice & stay details"
                          >
                            <ReceiptIndianRupee className="h-3.5 w-3.5 text-brass" /> Invoice
                          </button>
                          {isAdmin && (
                            <button
                              className="btn-ghost h-7 px-2 text-danger hover:bg-danger/10"
                              onClick={() => setDeleteRes(r)}
                              aria-label={`Delete reservation ${r.confirmationNumber}`}
                              title="Delete this reservation permanently"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>
                      )
                    ) : (
                      <span className="text-muted-ink text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td className="td text-center text-muted-ink py-10" colSpan={11}>No reservations match your filters.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialogs */}
      <NewReservationDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={() => { setNewOpen(false); load(); }}
      />
      {modifyRes && (
        <ModifyReservationDialog
          reservation={modifyRes}
          onOpenChange={(o) => !o && setModifyRes(null)}
          onSaved={() => { setModifyRes(null); load(); }}
        />
      )}
      {checkInRes && (
        <CheckInDialog
          reservation={checkInRes}
          onOpenChange={(o) => !o && setCheckInRes(null)}
          onDone={() => { setCheckInRes(null); load(); }}
        />
      )}
      {checkOutRes && (
        <CheckOutDialog
          reservation={checkOutRes}
          onOpenChange={(o) => !o && setCheckOutRes(null)}
          onDone={() => { setCheckOutRes(null); load(); }}
        />
      )}
      {groupOpen && (
        <GroupDialog
          group={groups.find((g) => g.code === groupOpen)!}
          property={property}
          printedBy={user?.name ?? "Front Desk"}
          canAct={canAct}
          onClose={() => setGroupOpen(null)}
          onChanged={load}
        />
      )}

      <AlertDialog open={!!cancelRes} onOpenChange={(o) => !o && setCancelRes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelRes?.confirmationNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels {cancelRes?.guest.fullName}&apos;s stay ({cancelRes && `${fmtDate(cancelRes.checkIn)} → ${fmtDate(cancelRes.checkOut)}`}). The room block is released.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-outline h-9">Keep Reservation</AlertDialogCancel>
            <AlertDialogAction className="btn-danger" onClick={cancelReservation}>Cancel Reservation</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete (permanent) — hotel_admin only, terminal stays only */}
      <AlertDialog open={!!deleteRes} onOpenChange={(o) => !o && setDeleteRes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteRes?.confirmationNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes {deleteRes?.guest.fullName}&apos;s reservation with its folio charges and payments
              {deleteRes ? ` (₹${deleteRes.totalAmount.toFixed(2)}, ${STATUS_LABELS[deleteRes.status] ?? deleteRes.status})` : ""}. The confirmation number can never be recovered — prefer Cancel for stays that should stay in the books.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-outline h-9">Keep Record</AlertDialogCancel>
            <AlertDialogAction
              className="btn-danger"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the call resolves
                deleteReservation();
              }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete Permanently
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Invoice & details — openable from any reservation row (incl. checked-out) */}
      <Dialog open={!!invoiceRes} onOpenChange={(o) => !o && setInvoiceRes(null)}>
        <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">
              Invoice &amp; Details {invoiceRes && <span className="font-mono text-sm text-muted-ink">· {invoiceRes.confirmationNumber}</span>}
            </DialogTitle>
            <DialogDescription>
              GST tax invoice and stay summary — print or download the guest copy.
            </DialogDescription>
          </DialogHeader>

          {invoiceLoading && (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-ink">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading invoice…
            </div>
          )}
          {invoiceError && (
            <div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger" role="alert">
              {invoiceError}
            </div>
          )}

          {invoiceData && (
            <>
              {/* Stay summary strip */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Guest</p>
                  <p className="text-[13px] font-medium text-pine truncate" title={invoiceData.billTo.fullName}>{invoiceData.billTo.fullName}</p>
                  <p className="text-[11px] text-muted-ink">{invoiceData.billTo.phone}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Room &amp; Stay</p>
                  <p className="text-[13px] font-medium text-pine">
                    {invoiceData.reservation.room ? <>Room {invoiceData.reservation.room.number}</> : "Unassigned"}
                  </p>
                  <p className="text-[11px] text-muted-ink whitespace-nowrap">
                    {fmtDate(invoiceData.reservation.checkIn)} → {fmtDate(invoiceData.reservation.checkOut)} · {invoiceData.reservation.nights}N
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Status</p>
                  <span className={cn("badge mt-0.5", STATUS_BADGE[invoiceData.reservation.status])}>
                    {STATUS_LABELS[invoiceData.reservation.status] ?? invoiceData.reservation.status}
                  </span>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Grand Total</p>
                  <p className="text-[13px] font-semibold text-pine">{inr(invoiceData.grandTotal, { decimals: true })}</p>
                  <p className={cn("text-[11px]", invoiceData.balance > 0 ? "text-warn" : "text-ok")}>
                    {invoiceData.balance > 0 ? `Balance ${inr(invoiceData.balance, { decimals: true })}` : "Fully paid"}
                  </p>
                </div>
              </div>

              <div id="inv-print" className="rounded-md border border-line bg-panel p-4 overflow-x-auto scroll-slim">
                <InvoiceDoc inv={invoiceData} />
              </div>
            </>
          )}

          <DialogFooter className="gap-2">
            <button className="btn-ghost h-9" onClick={() => setInvoiceRes(null)}>Close</button>
            <button className="btn-outline h-9" disabled={!invoiceData} onClick={downloadInvoice}>
              <Download className="h-4 w-4" /> Download
            </button>
            <button
              className="btn-pine h-9"
              disabled={!invoiceData}
              onClick={() => invoiceData && printHtml(invoiceHtml(invoiceData), invoiceData.invoiceNo)}
            >
              <Printer className="h-4 w-4" /> Print
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ───────────────────────── New Reservation ───────────────────────── */

interface PromoQuote { code: string; description?: string; discount: number }

function NewReservationDialog({ open, onOpenChange, onCreated }: {
  open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [guests, setGuests] = useState<GuestLite[]>([]);
  const [rooms, setRooms] = useState<RoomLite[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomTypeLite[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [guestQuery, setGuestQuery] = useState("");
  const [guestId, setGuestId] = useState("");
  const [form, setForm] = useState({
    fullName: "", phone: "", email: "", idType: "aadhaar", idNumber: "",
    checkIn: todayISO(), checkOut: toISODate(addDays(todayISO(), 1)),
    adults: "1", children: "0", roomTypeId: "", roomId: "any", nightlyRate: "", source: "front_desk", notes: "", status: "confirmed", groupCode: "",
  });
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [availLoading, setAvailLoading] = useState(false);

  // Promo code state
  const [promoInput, setPromoInput] = useState("");
  const [promoApplied, setPromoApplied] = useState<PromoQuote | null>(null);
  const [promoMsg, setPromoMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("existing");
    setGuestId("");
    setGuestQuery("");
    setBlocked(new Set());
    setPromoInput("");
    setPromoApplied(null);
    setPromoMsg(null);
    setForm((f) => ({
      ...f, fullName: "", phone: "", email: "", idNumber: "",
      checkIn: todayISO(), checkOut: toISODate(addDays(todayISO(), 1)),
      roomId: "any", notes: "", groupCode: "",
    }));
    (async () => {
      try {
        const [g, roomsRes, typesRes] = await Promise.all([
          api<{ guests: GuestLite[] }>("/api/guests"),
          api<{ rooms: RoomLite[] }>("/api/rooms"),
          api<{ roomTypes: RoomTypeLite[] }>("/api/room-types"),
        ]);
        setGuests(g.guests);
        setRooms(roomsRes.rooms);
        setRoomTypes(typesRes.roomTypes);
        setForm((f) => ({ ...f, roomTypeId: f.roomTypeId || typesRes.roomTypes[0]?.id || "" }));
      } catch (e) {
        toast({ title: "Could not load booking data", description: (e as Error).message, variant: "destructive" });
      }
    })();
  }, [open, toast]);

  const nights = useMemo(() => nightsBetween(form.checkIn, form.checkOut), [form.checkIn, form.checkOut]);
  const rate = Number(form.nightlyRate) || 0;
  const grossTotal = nights * rate;
  const total = Math.max(0, grossTotal - (promoApplied?.discount ?? 0));

  const typeRooms = useMemo(() => rooms.filter((r) => r.roomType.id === form.roomTypeId), [rooms, form.roomTypeId]);
  const availableRooms = useMemo(
    () => typeRooms.filter((r) => !blocked.has(r.id) || r.id === form.roomId),
    [typeRooms, blocked, form.roomId]
  );

  // Refresh availability when dates/type change
  useEffect(() => {
    if (!open || !form.checkIn || !form.checkOut || form.checkOut <= form.checkIn) return;
    let stale = false;
    setAvailLoading(true);
    unavailableRoomIds(form.checkIn, form.checkOut)
      .then((set) => { if (!stale) setBlocked(set); })
      .catch(() => { /* fall back to server-side validation */ })
      .finally(() => { if (!stale) setAvailLoading(false); });
    return () => { stale = true; };
  }, [open, form.checkIn, form.checkOut, form.roomTypeId]);

  function pickRoomType(id: string) {
    const rt = roomTypes.find((t) => t.id === id);
    setForm((f) => ({ ...f, roomTypeId: id, nightlyRate: rt ? String(rt.baseRate) : f.nightlyRate, roomId: "any" }));
  }

  const filteredGuests = useMemo(() => {
    const q = guestQuery.toLowerCase();
    return guests
      .filter((g) => g.fullName.toLowerCase().includes(q) || g.phone.includes(q))
      .slice(0, 30);
  }, [guests, guestQuery]);

  async function applyPromo(code?: string) {
    const c = (code ?? promoInput).trim();
    if (!c) { setPromoMsg({ ok: false, text: "Enter a promo code first" }); return; }
    setPromoChecking(true);
    try {
      const data = await api<PromoQuote & { valid: boolean; message?: string }>("/api/booking-engine/promo", {
        method: "POST", body: JSON.stringify({ code: c, amount: grossTotal }),
      });
      if (!data.valid) {
        setPromoApplied(null);
        setPromoMsg({ ok: false, text: data.message ?? "Promo code could not be applied" });
      } else {
        setPromoApplied({ code: data.code, description: data.description, discount: data.discount });
        setPromoMsg({ ok: true, text: `${data.code} applied — ${data.description || "discount"} −₹${data.discount.toLocaleString("en-IN")}` });
      }
    } catch (e) {
      setPromoApplied(null);
      setPromoMsg({ ok: false, text: (e as Error).message });
    } finally {
      setPromoChecking(false);
    }
  }

  // Re-quote the applied promo whenever the gross amount changes (dates/rate/type)
  useEffect(() => {
    if (!open || !promoApplied) return;
    if (grossTotal <= 0) { setPromoApplied(null); setPromoMsg(null); return; }
    applyPromo(promoApplied.code);
  }, [grossTotal, open]);

  async function submit() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        checkIn: form.checkIn,
        checkOut: form.checkOut,
        adults: Number(form.adults) || 1,
        children: Number(form.children) || 0,
        roomTypeId: form.roomTypeId || undefined,
        roomId: form.roomId && form.roomId !== "any" ? form.roomId : undefined,
        nightlyRate: rate,
        source: form.source,
        notes: form.notes,
        status: form.status,
        groupCode: form.groupCode.trim() || undefined,
        promoCode: promoApplied?.code || undefined,
      };
      if (mode === "existing") {
        if (!guestId) throw new Error("Select an existing guest or switch to New Guest");
        payload.guestId = guestId;
      } else {
        payload.guest = {
          fullName: form.fullName.trim(), phone: form.phone.trim(), email: form.email.trim(),
          idType: form.idType, idNumber: form.idNumber.trim(),
        };
      }
      const data = await api<{ reservation: Reservation }>("/api/reservations", {
        method: "POST", body: JSON.stringify(payload),
      });
      toast({
        title: `Reservation ${data.reservation.confirmationNumber} created`,
        description: `${data.reservation.guest.fullName} · ${data.reservation.nights} night(s) · ${inr(data.reservation.totalAmount)}${promoApplied ? ` · ${promoApplied.code} −${inr(promoApplied.discount)}` : ""}`,
      });
      onCreated();
    } catch (e) {
      toast({ title: "Could not create reservation", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const canSubmit =
    (mode === "existing" ? !!guestId : !!form.fullName.trim() && !!form.phone.trim()) &&
    !!form.roomTypeId && form.checkOut > form.checkIn && rate > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scroll-slim">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">New Reservation</DialogTitle>
          <DialogDescription>Book a stay — pick the guest, dates and room. Availability is checked live.</DialogDescription>
        </DialogHeader>

        {/* Guest mode toggle */}
        <div className="flex items-center gap-2">
          {(["existing", "new"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "badge cursor-pointer px-3 py-1.5 transition",
                mode === m ? "border-pine-700 bg-pine-700 text-panel" : "border-line-strong bg-panel text-muted-ink hover:border-brass hover:text-brass"
              )}
            >
              {m === "existing" ? "Existing Guest" : "New Guest"}
            </button>
          ))}
        </div>

        {mode === "existing" ? (
          <div className="space-y-2">
            <input
              className="field"
              placeholder="Search by name or phone…"
              value={guestQuery}
              onChange={(e) => setGuestQuery(e.target.value)}
            />
            <div className="max-h-36 overflow-y-auto scroll-slim rounded-md border border-line divide-y divide-line/60">
              {filteredGuests.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setGuestId(g.id)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 text-left text-[13px] transition",
                    guestId === g.id ? "bg-pine-100 text-pine-700 font-medium" : "hover:bg-plaster/70"
                  )}
                >
                  <span>{g.fullName}</span>
                  <span className="text-[11px] text-muted-ink">{g.phone}</span>
                </button>
              ))}
              {filteredGuests.length === 0 && (
                <div className="px-3 py-4 text-[13px] text-muted-ink text-center">No guests found — switch to “New Guest”.</div>
              )}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="field-label">Full Name *</label>
              <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} placeholder="Aarav Sharma" />
            </div>
            <div>
              <label className="field-label">Phone *</label>
              <input className="field" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+91 98… " />
            </div>
            <div>
              <label className="field-label">Email</label>
              <input className="field" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="field-label">ID Type</label>
                <Select value={form.idType} onValueChange={(v) => setForm({ ...form, idType: v })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {["aadhaar", "passport", "dl", "pan"].map((t) => <SelectItem key={t} value={t} className="capitalize">{t.toUpperCase()}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="field-label">ID Number</label>
                <input className="field" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
              </div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="field-label">Check-in</label>
            <input className="field" type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Check-out</label>
            <input className="field" type="date" min={addDays(form.checkIn, 1).toISOString().slice(0, 10)} value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Adults</label>
            <input className="field" type="number" min={1} value={form.adults} onChange={(e) => setForm({ ...form, adults: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Children</label>
            <input className="field" type="number" min={0} value={form.children} onChange={(e) => setForm({ ...form, children: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="field-label">Room Type</label>
            <Select value={form.roomTypeId} onValueChange={pickRoomType}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select type" /></SelectTrigger>
              <SelectContent>
                {roomTypes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name} · {inr(t.baseRate)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label">
              Room {availLoading && <Loader2 className="inline h-3 w-3 animate-spin text-brass" />}
            </label>
            <Select value={form.roomId} onValueChange={(v) => setForm({ ...form, roomId: v })}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select room" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Auto-assign later</SelectItem>
                {availableRooms.map((r) => (
                  <SelectItem key={r.id} value={r.id}>
                    {r.number} · Floor {r.floor} · {r.status.replace("_", " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!availLoading && typeRooms.length > 0 && availableRooms.length === 1 && (
              <p className="text-[11px] text-warn mt-1">All rooms of this type are blocked for the selected dates.</p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <label className="field-label">Rate / night (₹)</label>
            <input className="field" type="number" min={0} value={form.nightlyRate} onChange={(e) => setForm({ ...form, nightlyRate: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Source</label>
            <Select value={form.source} onValueChange={(v) => setForm({ ...form, source: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCE_OPTIONS.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label">Status</label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="hold">Hold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label">Group Code</label>
            <input className="field" value={form.groupCode} onChange={(e) => setForm({ ...form, groupCode: e.target.value.toUpperCase() })} placeholder="e.g. GRP-CONF-09" />
          </div>
        </div>

        <div>
          <label className="field-label">Notes</label>
          <textarea className="field h-16 py-2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Special requests…" />
        </div>

        {/* Promo code */}
        <div className="rounded-md border border-dashed border-brass/50 bg-brass-50/40 px-3 py-2.5">
          <label className="field-label flex items-center gap-1"><TicketPercent className="h-3.5 w-3.5 text-brass" /> Promo Code</label>
          <div className="flex items-center gap-2">
            <input
              className="field h-9 uppercase font-mono text-[13px] tracking-wide"
              placeholder="e.g. EARLY15"
              value={promoInput}
              onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyPromo(); } }}
            />
            <button
              type="button"
              className="btn-outline h-9 shrink-0 px-3"
              onClick={() => applyPromo()}
              disabled={promoChecking || !promoInput.trim() || grossTotal <= 0}
            >
              {promoChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Apply"}
            </button>
            {promoApplied && (
              <button
                type="button"
                className="btn-ghost h-9 px-2 text-danger"
                onClick={() => { setPromoApplied(null); setPromoMsg(null); setPromoInput(""); }}
                aria-label="Remove promo code"
              >
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </div>
          {promoMsg && (
            <p className={cn("text-[11px] mt-1.5 flex items-center gap-1", promoMsg.ok ? "text-ok" : "text-danger")}>
              {promoMsg.ok ? <CheckCheck className="h-3 w-3" /> : <XCircle className="h-3 w-3" />} {promoMsg.text}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between rounded-md border border-line bg-plaster/60 px-3 py-2.5">
          <div className="flex items-center gap-4 text-[13px]">
            <span className="flex items-center gap-1 text-muted-ink"><CalendarDays className="h-3.5 w-3.5" /> {nights} night{nights === 1 ? "" : "s"}</span>
            <span className="flex items-center gap-1 text-muted-ink"><Users className="h-3.5 w-3.5" /> {Number(form.adults) || 1} + {Number(form.children) || 0}</span>
          </div>
          <div className="text-right">
            {promoApplied && (
              <p className="text-[11px] text-muted-ink">
                <span className="line-through">₹{grossTotal.toLocaleString("en-IN")}</span>
                <span className="text-ok font-medium"> −₹{promoApplied.discount.toLocaleString("en-IN")}</span>
              </p>
            )}
            <p className="flex items-center gap-1 font-display text-lg font-semibold text-pine justify-end">
              <IndianRupee className="h-4 w-4 text-brass" /> {total.toLocaleString("en-IN")} <span className="text-[11px] font-sans font-normal text-muted-ink">total</span>
            </p>
          </div>
        </div>

        <DialogFooter>
          <button className="btn-outline" onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={saving || !canSubmit}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Create Reservation
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── Modify Reservation ───────────────────── */

function ModifyReservationDialog({ reservation, onOpenChange, onSaved }: {
  reservation: Reservation; onOpenChange: (o: boolean) => void; onSaved: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [rooms, setRooms] = useState<RoomLite[]>([]);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    checkIn: toISODate(new Date(reservation.checkIn)),
    checkOut: toISODate(new Date(reservation.checkOut)),
    roomId: reservation.roomId ?? "any",
    nightlyRate: String(reservation.nightlyRate),
    adults: String(reservation.adults),
    notes: reservation.notes,
  });

  useEffect(() => {
    api<{ rooms: RoomLite[] }>("/api/rooms").then((d) => setRooms(d.rooms)).catch(() => {});
  }, []);

  const nights = useMemo(() => nightsBetween(form.checkIn, form.checkOut), [form.checkIn, form.checkOut]);

  useEffect(() => {
    if (form.checkOut <= form.checkIn) return;
    let stale = false;
    unavailableRoomIds(form.checkIn, form.checkOut, reservation.id)
      .then((set) => { if (!stale) setBlocked(set); })
      .catch(() => {});
    return () => { stale = true; };
  }, [form.checkIn, form.checkOut, reservation.id]);

  const typeRooms = useMemo(() => {
    const typeId = reservation.roomType?.id ?? reservation.room?.roomType?.id ?? null;
    return typeId ? rooms.filter((r) => r.roomType.id === typeId) : rooms;
  }, [rooms, reservation]);
  const availableRooms = useMemo(
    () => typeRooms.filter((r) => !blocked.has(r.id) || r.id === reservation.roomId),
    [typeRooms, blocked, reservation.roomId]
  );

  // Live re-price preview — mirrors the PATCH endpoint's promo-aware math
  const previewRate = Number(form.nightlyRate) || 0;
  const previewGross = Math.round(nights * previewRate * 100) / 100;
  const previewDiscount = reservation.promoCode
    ? Math.min(reservation.discountAmount ?? 0, previewGross)
    : 0;
  const previewTotal = Math.max(0, previewGross - previewDiscount);
  const repriced =
    previewGross !== Math.round(reservation.nights * reservation.nightlyRate * 100) / 100 ||
    nights !== reservation.nights;

  async function submit() {
    setSaving(true);
    try {
      const patch: Record<string, unknown> = {
        checkIn: form.checkIn,
        checkOut: form.checkOut,
        roomId: form.roomId && form.roomId !== "any" ? form.roomId : null,
        nightlyRate: Number(form.nightlyRate),
        adults: Number(form.adults) || 1,
        notes: form.notes,
      };
      await api(`/api/reservations/${reservation.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast({
        title: "Reservation updated",
        description: `${reservation.confirmationNumber} — ${nights} night(s), ${inr(Number(form.nightlyRate))}/night${repriced ? ` · new total ${inr(previewTotal)}` : ""}${previewDiscount ? ` · ${reservation.promoCode} −${inr(previewDiscount)}` : ""}`,
      });
      onSaved();
    } catch (e) {
      toast({ title: "Update failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">Modify {reservation.confirmationNumber}</DialogTitle>
          <DialogDescription>{reservation.guest.fullName} · currently {STATUS_LABELS[reservation.status] ?? reservation.status}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Check-in</label>
            <input className="field" type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Check-out</label>
            <input className="field" type="date" min={addDays(form.checkIn, 1).toISOString().slice(0, 10)} value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="field-label">Room — {reservation.roomType?.name ?? "any type"} ({nights} night{nights === 1 ? "" : "s"})</label>
            <Select value={form.roomId} onValueChange={(v) => setForm({ ...form, roomId: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="any">Unassign room</SelectItem>
                {availableRooms.map((r) => (
                  <SelectItem key={r.id} value={r.id} disabled={blocked.has(r.id) && r.id !== reservation.roomId}>
                    {r.number} {blocked.has(r.id) && r.id !== reservation.roomId ? "· taken" : `· Floor ${r.floor}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label">Rate / night (₹)</label>
            <input className="field" type="number" min={0} value={form.nightlyRate} onChange={(e) => setForm({ ...form, nightlyRate: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Adults</label>
            <input className="field" type="number" min={1} value={form.adults} onChange={(e) => setForm({ ...form, adults: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="field-label">Notes</label>
            <textarea className="field h-16 py-2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </div>
        {repriced && (
          <div className="rounded-md border border-line-strong bg-pine-100/40 px-4 py-3" aria-live="polite">
            <div className="mb-1.5 font-display text-[13px] font-semibold tracking-wide text-pine uppercase">
              Re-priced stay
            </div>
            <div className="space-y-1 text-[13px] text-ink">
              <div className="flex items-center justify-between">
                <span className="text-muted-ink">{nights} night{nights === 1 ? "" : "s"} × {inr(previewRate)}</span>
                <span className="tabular-nums">{inr(previewGross)}</span>
              </div>
              {previewDiscount > 0 && (
                <div className="flex items-center justify-between text-brass">
                  <span>Promo {reservation.promoCode}</span>
                  <span className="tabular-nums">−{inr(previewDiscount)}</span>
                </div>
              )}
              <div className="flex items-center justify-between border-t border-line pt-1.5 font-semibold text-pine">
                <span>New total</span>
                <span className="font-display text-base tabular-nums">{inr(previewTotal)}</span>
              </div>
            </div>
            {reservation.promoCode && previewDiscount < (reservation.discountAmount ?? 0) && (
              <p className="mt-1.5 text-[11px] leading-snug text-warn">
                Discount reduced to match the shorter stay — folio can never go negative.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <button className="btn-outline" onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={saving || form.checkOut <= form.checkIn || Number(form.nightlyRate) <= 0}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save Changes
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── Check-in ─────────────────────────────── */

function CheckInDialog({ reservation, onOpenChange, onDone }: {
  reservation: Reservation; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [idType, setIdType] = useState(reservation.guest.idType || "aadhaar");
  const [idNumber, setIdNumber] = useState(reservation.guest.idNumber || "");
  const [photoData, setPhotoData] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Please choose an image under 4 MB.", variant: "destructive" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setPhotoData(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  }

  async function submit() {
    setSaving(true);
    try {
      await api(`/api/reservations/${reservation.id}/check-in`, {
        method: "POST",
        body: JSON.stringify({ idType, idNumber, idProofData: photoData || undefined }),
      });
      toast({
        title: `Checked in — ${reservation.guest.fullName}`,
        description: `Room ${reservation.room?.number ?? "—"} is now occupied. Keys handed over.`,
      });
      onDone();
    } catch (e) {
      toast({ title: "Check-in failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">Check In — {reservation.guest.fullName}</DialogTitle>
          <DialogDescription>
            {reservation.confirmationNumber} · Room {reservation.room?.number ?? "—"} · {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}
          </DialogDescription>
        </DialogHeader>
        {reservation.guest.photoUrl && (
          <div className="flex items-center gap-3 rounded-md border border-line bg-plaster/40 px-3 py-2">
            <GuestAvatar name={reservation.guest.fullName} photoUrl={reservation.guest.photoUrl} size={44} />
            <div className="text-[12px] leading-tight">
              <p className="font-medium text-pine">Verify identity against profile photo</p>
              <p className="text-[11px] text-muted-ink">Capture a fresh ID proof below if details changed.</p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">ID Type</label>
            <Select value={idType} onValueChange={setIdType}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {["aadhaar", "passport", "dl", "pan"].map((t) => <SelectItem key={t} value={t} className="capitalize">{t.toUpperCase()}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label">ID Number</label>
            <input className="field" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} placeholder="Recorded on folio" />
          </div>
          <div className="col-span-2">
            <label className="field-label">ID Proof Photo (optional)</label>
            <div className="flex items-center gap-3">
              <input ref={fileRef} type="file" accept="image/*" onChange={onFile} className="field h-9 py-1.5 file:mr-2 file:rounded file:border-0 file:bg-pine-700 file:px-2 file:py-0.5 file:text-panel file:text-xs" />
              {photoData && <img src={photoData} alt="ID proof preview" className="h-12 w-16 rounded border border-line object-cover" />}
              {photoData && (
                <button className="btn-ghost px-2 h-7" onClick={() => { setPhotoData(""); if (fileRef.current) fileRef.current.value = ""; }} aria-label="Remove photo">
                  <XCircle className="h-4 w-4" />
                </button>
              )}
            </div>
            {!photoData && (
              <p className="text-[11px] text-muted-ink mt-1 flex items-center gap-1"><FileImage className="h-3 w-3" /> Camera capture works on mobile — stored with the folio.</p>
            )}
          </div>
        </div>
        <DialogFooter>
          <button className="btn-outline" onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />} Check In Guest
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ───────────────────────── Group booking drawer ─────────────────── */

interface GroupSummary {
  code: string;
  members: Reservation[];
  rooms: number;
  pax: number;
  total: number;
  arrivals: number;
  inHouse: number;
}

interface GroupPaymentRow {
  id: string;
  amount: number;
  method: string;
  reference: string;
  receivedBy: string;
  createdAt: string;
  confirmationNumber: string | null;
  guestName: string | null;
  roomNumber: string | null;
}

function GroupDialog({ group, property, printedBy, canAct, onClose, onChanged }: {
  group: GroupSummary;
  property: PropertyLite;
  printedBy: string;
  canAct: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [acting, setActing] = useState<string | null>(null);

  // Bulk check-in: confirmation + per-member results
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [allowDirty, setAllowDirty] = useState(false); // opt-in: check into uncleaned rooms
  const [bulkResults, setBulkResults] = useState<{
    checkedIn: number; skipped: number; failed: number;
    results: { reservationId: string; guestName: string; roomNumber: string | null; result: string; reason?: string }[];
  } | null>(null);

  // Bulk check-out: confirmation + per-member results with balances
  const [coConfirmOpen, setCoConfirmOpen] = useState(false);
  const [coRunning, setCoRunning] = useState(false);
  const [coResults, setCoResults] = useState<{
    checkedOut: number; skipped: number; failed: number; totalOutstanding: number; totalCredit: number;
    results: { reservationId: string; guestName: string; roomNumber: string | null; result: string; reason?: string; balance?: number; earlyDeparture?: { bookedNights: number; stayedNights: number } | null }[];
  } | null>(null);

  // Deposits & receipts — payments across member folios, fetched lazily
  const [payments, setPayments] = useState<GroupPaymentRow[] | null>(null);
  const [paymentsOpen, setPaymentsOpen] = useState(false);
  const [receiptBusyId, setReceiptBusyId] = useState<string | null>(null);

  const eligibleMembers = group.members.filter((m) => ["hold", "confirmed"].includes(m.status));
  const unassignedEligible = eligibleMembers.filter((m) => !m.room);

  // Per-room rate overrides — local edits, saved in one batch
  const [rates, setRates] = useState<Record<string, string>>(() =>
    Object.fromEntries(group.members.map((m) => [m.id, String(m.nightlyRate)]))
  );
  const [bulkRate, setBulkRate] = useState("");
  const [ratesSaving, setRatesSaving] = useState(false);
  const [ratesVersion, setRatesVersion] = useState(0);

  // Keep local rate inputs in sync when the underlying group data refreshes
  useEffect(() => {
    setRates(Object.fromEntries(group.members.map((m) => [m.id, String(m.nightlyRate)])));
  }, [group.members, ratesVersion]);

  const ratesDirty = group.members.some((m) => {
    if (!["hold", "confirmed", "checked_in"].includes(m.status)) return false;
    const v = Number(rates[m.id]);
    return Number.isFinite(v) && Math.round(v * 100) / 100 !== Math.round(m.nightlyRate * 100) / 100;
  });
  const ratesNewTotal = group.members.reduce((n, m) => {
    const v = Number(rates[m.id]);
    return n + (Number.isFinite(v) && ["hold", "confirmed", "checked_in"].includes(m.status) ? Math.round(v * m.nights * 100) / 100 : m.totalAmount);
  }, 0);

  function setRate(id: string, value: string) {
    setRates((prev) => ({ ...prev, [id]: value }));
  }

  function applyBulkRate() {
    const v = Number(bulkRate);
    if (!Number.isFinite(v) || v <= 0) {
      toast({ title: "Enter a valid rate to apply to all rooms", variant: "destructive" });
      return;
    }
    setRates((prev) => {
      const next = { ...prev };
      for (const m of group.members) {
        if (["hold", "confirmed", "checked_in"].includes(m.status)) next[m.id] = String(v);
      }
      return next;
    });
    toast({ title: `Rate ₹${v.toLocaleString("en-IN")} staged for all active rooms`, description: "Review the per-room totals below, then save." });
  }

  async function saveRates() {
    const overrides = group.members
      .filter((m) => {
        if (!["hold", "confirmed", "checked_in"].includes(m.status)) return false;
        const v = Number(rates[m.id]);
        return Number.isFinite(v) && Math.round(v * 100) / 100 !== Math.round(m.nightlyRate * 100) / 100;
      })
      .map((m) => ({ reservationId: m.id, nightlyRate: Number(rates[m.id]) }));
    if (overrides.length === 0) return;
    setRatesSaving(true);
    try {
      const r = await api<{ changed: { reservationId: string; from: number; to: number }[]; skipped: string[] }>(
        `/api/groups/${encodeURIComponent(group.code)}/rates`,
        { method: "POST", body: JSON.stringify({ overrides }) }
      );
      toast({
        title: `${r.changed.length} room rate${r.changed.length === 1 ? "" : "s"} updated`,
        description: r.changed.map((c) => `₹${c.from.toLocaleString("en-IN")} → ₹${c.to.toLocaleString("en-IN")}`).join(" · ") +
          (r.skipped.length > 0 ? ` (skipped ${r.skipped.length}: ${r.skipped.join("; ")})` : ""),
      });
      setRatesVersion((v) => v + 1);
      onChanged();
    } catch (e) {
      toast({ title: "Could not save rate changes", description: (e as Error).message, variant: "destructive" });
    } finally {
      setRatesSaving(false);
    }
  }

  async function runBulkCheckIn() {
    setBulkRunning(true);
    try {
      const r = await api<{
        checkedIn: number; skipped: number; failed: number;
        results: { reservationId: string; guestName: string; roomNumber: string | null; result: string; reason?: string }[];
      }>(`/api/groups/${encodeURIComponent(group.code)}/check-in`, { method: "POST", body: JSON.stringify({ allowDirty }) });
      setBulkResults(r);
      setBulkConfirmOpen(false);
      toast({
        title: r.failed > 0
          ? `Checked in ${r.checkedIn} of ${r.checkedIn + r.skipped + r.failed} rooms — ${r.failed} failed`
          : `${r.checkedIn} room${r.checkedIn === 1 ? "" : "s"} checked in`,
        description: r.checkedIn > 0 ? "Rooms marked occupied · folios are live." : undefined,
        variant: r.failed > 0 && r.checkedIn === 0 ? "destructive" : "default",
      });
      onChanged();
    } catch (e) {
      toast({ title: "Bulk check-in failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBulkRunning(false);
    }
  }

  async function runBulkCheckOut() {
    setCoRunning(true);
    try {
      const r = await api<{
        checkedOut: number; skipped: number; failed: number; totalOutstanding: number; totalCredit: number;
        results: { reservationId: string; guestName: string; roomNumber: string | null; result: string; reason?: string; balance?: number; earlyDeparture?: { bookedNights: number; stayedNights: number } | null }[];
      }>(`/api/groups/${encodeURIComponent(group.code)}/check-out`, { method: "POST" });
      setCoResults(r);
      setCoConfirmOpen(false);
      toast({
        title: r.failed > 0
          ? `Checked out ${r.checkedOut} of ${r.checkedOut + r.skipped + r.failed} rooms — ${r.failed} failed`
          : `${r.checkedOut} room${r.checkedOut === 1 ? "" : "s"} checked out`,
        description: r.totalOutstanding > 0
          ? `Outstanding ${inr(r.totalOutstanding, { decimals: true })} — settle from the group folio.`
          : "All balances settled.",
        variant: r.failed > 0 && r.checkedOut === 0 ? "destructive" : "default",
      });
      onChanged();
    } catch (e) {
      toast({ title: "Bulk check-out failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setCoRunning(false);
    }
  }

  async function confirmHold(res: Reservation) {
    setActing(res.id);
    try {
      await api(`/api/reservations/${res.id}`, { method: "PATCH", body: JSON.stringify({ status: "confirmed" }) });
      toast({ title: "Reservation confirmed", description: `${res.confirmationNumber} — ${res.guest.fullName}` });
      onChanged();
    } catch (e) {
      toast({ title: "Could not confirm", description: (e as Error).message, variant: "destructive" });
    } finally {
      setActing(null);
    }
  }

  const paid = group.members.reduce((n, m) => n + m.paidAmount, 0);
  const balance = group.total - paid;

  const inHouseMembers = group.members.filter((m) => m.status === "checked_in");

  // Load the group's payments (for the Deposits & Receipts section) once per drawer session
  useEffect(() => {
    let stale = false;
    setPayments(null);
    api<{ group: { payments: GroupPaymentRow[] } }>(`/api/groups/${encodeURIComponent(group.code)}`)
      .then((d) => { if (!stale) setPayments(d.group.payments ?? []); })
      .catch(() => { if (!stale) setPayments([]); });
    return () => { stale = true; };
  }, [group.code]);

  async function downloadReceipt(p: GroupPaymentRow) {
    setReceiptBusyId(p.id);
    try {
      const d = await api<{ receipt: ReceiptPayload }>(`/api/receipt/${p.id}`);
      const blob = new Blob([receiptHtml(d.receipt)], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.receipt.receiptNo}.html`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: `Receipt ${d.receipt.receiptNo} downloaded`, description: `₹${d.receipt.amount.toLocaleString("en-IN", { minimumFractionDigits: 2 })} · ${d.receipt.method.toUpperCase()} · ${d.receipt.guest.fullName}` });
    } catch (e) {
      toast({ title: "Could not build receipt", description: (e as Error).message, variant: "destructive" });
    } finally {
      setReceiptBusyId(null);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl max-h-[90vh] overflow-y-auto scroll-slim">
        <DialogHeader>
          <DialogTitle className="font-display text-pine flex items-center gap-2">
            <Layers className="h-5 w-5 text-brass" /> Group {group.code}
            {group.inHouse > 0 && (
              <span className="badge border-ok/40 bg-ok/10 text-ok text-[11px] ml-1">
                <Users className="h-3 w-3" /> {group.inHouse} in-house
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {group.members.length} rooms · {group.pax} guests · printed registration cards are stamped per guest.
          </DialogDescription>
        </DialogHeader>

        {/* Group stats */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {[
            { label: "Rooms", value: String(group.members.length), icon: Layers },
            { label: "Assigned", value: `${group.rooms}/${group.members.length}`, icon: BedDouble },
            { label: "Arrivals", value: String(group.arrivals), icon: CalendarDays },
            { label: "In-house", value: String(group.inHouse), icon: Users },
            { label: "Balance", value: inr(balance, { decimals: true }), icon: IndianRupee },
          ].map((s) => (
            <div
              key={s.label}
              className={cn(
                "rounded-md border px-3 py-2 text-center transition-colors",
                s.label === "Balance" && balance > 0 ? "border-brass/40 bg-brass-50/50" : "border-line bg-plaster/60"
              )}
            >
              <p className="text-[10px] uppercase tracking-wide text-muted-ink flex items-center justify-center gap-1">
                <s.icon className="h-3 w-3 text-brass/80" aria-hidden /> {s.label}
              </p>
              <p className={cn("font-display text-lg font-semibold", s.label === "Balance" && balance > 0 ? "text-brass" : "text-pine")}>{s.value}</p>
            </div>
          ))}
        </div>

        {/* Rate overrides — bulk apply + per-room editing */}
        {canAct && group.members.length > 0 && (
          <div className="rounded-md border border-brass/40 bg-brass-50/40 p-3 space-y-2" role="group" aria-label="Group rate overrides">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-pine flex items-center gap-1.5">
                <IndianRupee className="h-3.5 w-3.5 text-brass" /> Per-room rate overrides
              </p>
              <div className="flex items-center gap-1.5">
                <Input
                  type="number" min="0" step="any"
                  className="h-8 w-28 text-[13px]"
                  value={bulkRate}
                  onChange={(e) => setBulkRate(e.target.value)}
                  placeholder="₹ / night"
                  aria-label="Apply one rate to all active rooms"
                />
                <button type="button" className="btn-outline h-8" onClick={applyBulkRate}>
                  <Layers className="h-3.5 w-3.5" /> Apply to all
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-ink">
              Edit a room’s nightly rate below and save — booking totals re-price as rate × nights. Posted folio nights are never touched.
            </p>
          </div>
        )}

        {/* Members */}
        <div className="rounded-md border border-line max-h-72 overflow-y-auto scroll-slim">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Confirmation #</th>
                <th className="th">Guest</th>
                <th className="th">Room</th>
                <th className="th">Stay</th>
                <th className="th">Rate / night</th>
                <th className="th">Total</th>
                <th className="th">Status</th>
                <th className="th text-right">Print</th>
              </tr>
            </thead>
            <tbody>
              {group.members.map((m) => {
                const rateEditable = canAct && ["hold", "confirmed", "checked_in"].includes(m.status);
                const edited = Number(rates[m.id]);
                const revisedTotal = rateEditable && Number.isFinite(edited) ? Math.round(edited * m.nights * 100) / 100 : m.totalAmount;
                const rateChanged = rateEditable && Number.isFinite(edited) && Math.round(edited * 100) / 100 !== Math.round(m.nightlyRate * 100) / 100;
                return (
                <tr key={m.id} className={cn("transition-colors", m.status === "checked_in" ? "bg-ok/5 hover:bg-ok/10" : "hover:bg-plaster/50", rateChanged && "bg-brass-50/30")}>
                  <td className="td font-mono text-[12px] text-pine">{m.confirmationNumber}</td>
                  <td className="td text-[13px]">
                    <div className="flex items-center gap-2">
                      <GuestAvatar name={m.guest.fullName} photoUrl={m.guest.photoUrl} size={26} />
                      <div className="leading-tight">
                        <span className="font-medium text-pine">{m.guest.fullName}</span>
                        <span className="block text-[11px] text-muted-ink">{m.adults + m.children} pax</span>
                      </div>
                    </div>
                  </td>
                  <td className="td">{m.room ? <span className="font-medium">{m.room.number}</span> : <span className="badge border-warn/40 bg-warn/10 text-warn">Unassigned</span>}</td>
                  <td className="td whitespace-nowrap text-[13px]">{fmtDate(m.checkIn)} → {fmtDate(m.checkOut)}
                    <span className="block text-[11px] text-muted-ink">{m.nights} night{m.nights === 1 ? "" : "s"}</span>
                  </td>
                  <td className="td">
                    {rateEditable ? (
                      <Input
                        type="number" min="0" step="any"
                        className={cn("h-8 w-24 text-[13px] tabular-nums", rateChanged && "border-brass ring-1 ring-brass/30")}
                        value={rates[m.id] ?? String(m.nightlyRate)}
                        onChange={(e) => setRate(m.id, e.target.value)}
                        aria-label={`Nightly rate for ${m.guest.fullName}`}
                      />
                    ) : (
                      <span className="text-[13px] text-muted-ink">{inr(m.nightlyRate)}</span>
                    )}
                  </td>
                  <td className={cn("td font-medium", rateChanged ? "text-brass" : "text-pine")}>
                    {inr(revisedTotal)}
                    {rateChanged && <span className="block text-[11px] text-muted-ink line-through">{inr(m.totalAmount)}</span>}
                  </td>
                  <td className="td">
                    <span className={cn("badge", STATUS_BADGE[m.status])}>{STATUS_LABELS[m.status] ?? m.status}</span>
                    {m.status === "checked_in" && m.room && (
                      <span className="ml-1.5 text-[11px] text-ok font-medium" title="Room occupied">· occupied</span>
                    )}
                    {canAct && m.status === "hold" && (
                      <button className="ml-1.5 text-[11px] text-brass hover:underline" onClick={() => confirmHold(m)} disabled={acting === m.id}>
                        {acting === m.id ? "…" : "Confirm"}
                      </button>
                    )}
                  </td>
                  <td className="td text-right">
                    <button
                      className="btn-ghost px-2 h-7"
                      onClick={() => printRegistrationCards([m], property, printedBy)}
                      aria-label={`Print registration card for ${m.guest.fullName}`}
                      title="Print registration card"
                    >
                      <Printer className="h-3.5 w-3.5 text-brass" />
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Deposits & Receipts — payments collected across the group's folios */}
        <div className="rounded-md border border-line">
          <button
            type="button"
            className="w-full px-3 py-2.5 flex items-center justify-between gap-2 hover:bg-plaster/50 transition-colors"
            onClick={() => setPaymentsOpen((o) => !o)}
            aria-expanded={paymentsOpen}
          >
            <span className="text-xs font-semibold text-pine flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5 text-brass" /> Deposits &amp; Receipts
              <span className="badge border-line-strong bg-plaster text-muted-ink text-[10px]">
                {payments === null ? "…" : payments.length}
              </span>
            </span>
            <ChevronDown className={cn("h-4 w-4 text-muted-ink transition-transform", paymentsOpen && "rotate-180")} />
          </button>
          {paymentsOpen && (
            <div className="border-t border-line expand-in">
              {payments === null ? (
                <div className="px-3 py-3 flex items-center gap-2 text-[13px] text-muted-ink">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading payments…
                </div>
              ) : payments.length === 0 ? (
                <div className="px-3 py-3 text-[13px] text-muted-ink">
                  No payments recorded against this group yet — collect from{" "}
                  <span className="font-medium text-pine">Open Group Folio → Collect Payment</span>.
                </div>
              ) : (
                <div className="max-h-56 overflow-y-auto scroll-slim divide-y divide-line/60">
                  {payments.map((p) => (
                    <div key={p.id} className="flex items-center gap-2.5 px-3 py-2 text-[13px] hover:bg-plaster/40 transition-colors">
                      <span
                        className={cn(
                          "badge shrink-0 text-[10px]",
                          p.method === "cash" && "border-ok/40 bg-ok/10 text-ok",
                          p.method === "upi" && "border-pine-700/30 bg-pine-100 text-pine-700",
                          (p.method === "card" || p.method === "razorpay") && "border-brass/40 bg-brass-50 text-brass",
                          p.method === "netbanking" && "border-line-strong bg-plaster text-ink",
                          !["cash", "upi", "card", "razorpay", "netbanking"].includes(p.method) && "border-line-strong bg-plaster text-ink"
                        )}
                      >
                        {p.method.toUpperCase()}
                      </span>
                      <div className="min-w-0 flex-1 leading-tight">
                        <span className="font-medium text-pine tabular-nums">{inr(p.amount, { decimals: true })}</span>
                        <span className="block text-[11px] text-muted-ink truncate">
                          {p.guestName ?? "—"}{p.roomNumber ? ` · Room ${p.roomNumber}` : ""} · {new Date(p.createdAt).toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}
                          {p.reference ? ` · ${p.reference}` : ""}
                        </span>
                      </div>
                      <button
                        className="btn-ghost px-2 h-7 shrink-0"
                        onClick={() => downloadReceipt(p)}
                        disabled={receiptBusyId === p.id}
                        aria-label={`Download receipt for ${inr(p.amount)} from ${p.guestName ?? "guest"}`}
                        title="Download payment receipt"
                      >
                        {receiptBusyId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5 text-brass" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="text-[11px] text-muted-ink hidden sm:block">
            <p>Master total {inr(group.total, { decimals: true })} · paid {inr(paid, { decimals: true })}</p>
            {ratesDirty && (
              <p className="text-brass font-medium">
                Revised group total after rate changes: {inr(ratesNewTotal, { decimals: true })}
              </p>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-ghost" onClick={onClose}>Close</button>
            {canAct && eligibleMembers.length > 0 && (
              <button
                className="btn-pine"
                onClick={() => setBulkConfirmOpen(true)}
                title={`Check in ${eligibleMembers.length} eligible room(s) in one shot${unassignedEligible.length > 0 ? ` — ${unassignedEligible.length} will be auto-assigned a free room` : ""}`}
              >
                <LogIn className="h-4 w-4" /> Bulk Check-in ({eligibleMembers.length})
              </button>
            )}
            {canAct && inHouseMembers.length > 0 && (
              <button
                className="btn-outline border-danger/40 text-danger hover:bg-danger/10"
                onClick={() => setCoConfirmOpen(true)}
                title={`Check out ${inHouseMembers.length} in-house room(s) in one shot — rooms flagged Dirty, balances stay due for settlement`}
              >
                <LogOut className="h-4 w-4" /> Bulk Check-out ({inHouseMembers.length})
              </button>
            )}
            {canAct && ratesDirty && (
              <button className="btn-pine" onClick={saveRates} disabled={ratesSaving} title="Save the staged per-room rate overrides">
                {ratesSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save Rate Changes
              </button>
            )}
            {canAct && (
              <button
                className="btn-brass"
                title="Open the group master folio in Billing — master payer, charge routing and consolidated invoice"
                onClick={() => {
                  // Prefer an in-house member's folio, else the first member (works for confirmed groups too)
                  const anchor = group.members.find((m) => m.status === "checked_in") ?? group.members[0];
                  // BillingView may not be mounted yet — hand over via sessionStorage,
                  // then also broadcast for the already-mounted case.
                  sessionStorage.setItem("velurex_pending_group", JSON.stringify({ groupCode: group.code, reservationId: anchor.id }));
                  window.dispatchEvent(new CustomEvent("velurex:open-group", { detail: { groupCode: group.code, reservationId: anchor.id } }));
                  window.dispatchEvent(new CustomEvent("velurex:navigate", { detail: "billing" }));
                  onClose();
                }}
              >
                <ReceiptIndianRupee className="h-4 w-4" /> Open Group Folio
              </button>
            )}
            <button className="btn-pine" onClick={() => printRegistrationCards(group.members, property, printedBy)}>
              <Printer className="h-4 w-4" /> Print All Reg. Cards
            </button>
          </div>
        </DialogFooter>

        {/* Bulk check-in confirmation */}
        <AlertDialog open={bulkConfirmOpen} onOpenChange={setBulkConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Check in {eligibleMembers.length} room(s) of group {group.code}?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-[13px]">
                  <p>
                    Every <b>hold / confirmed</b> member becomes in-house and their room flips to <b>Occupied</b>.
                    Already in-house rooms are skipped; failures don't block the rest.
                  </p>
                  {unassignedEligible.length > 0 && (
                    <p className="rounded border border-brass/40 bg-brass-50/60 px-2.5 py-1.5 text-brass">
                      {unassignedEligible.length} room{unassignedEligible.length === 1 ? " has" : "s have"} no room assigned — a free
                      room of the booked type (or closest free room) will be auto-assigned.
                    </p>
                  )}
                  <label className="flex items-start gap-2 rounded border border-line bg-plaster/60 px-2.5 py-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="mt-0.5 h-3.5 w-3.5 accent-[#1f4b43]"
                      checked={allowDirty}
                      onChange={(e) => setAllowDirty(e.target.checked)}
                    />
                    <span className="text-[12px] leading-snug">
                      <span className="font-medium text-ink">Check into uncleaned rooms</span>
                      <span className="block text-muted-ink">
                        Allows auto-assignment of dirty rooms when no clean room is free — housekeeping still sees them as Dirty.
                      </span>
                    </span>
                  </label>
                  <p className="text-muted-ink">Registration cards serve as the group ID record — print them from the drawer if needed.</p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={bulkRunning}>Cancel</AlertDialogCancel>
              <AlertDialogAction className="btn-pine" onClick={(e) => { e.preventDefault(); runBulkCheckIn(); }} disabled={bulkRunning}>
                {bulkRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
                Check in {eligibleMembers.length} room(s)
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Bulk check-in results */}
        <AlertDialog open={!!bulkResults} onOpenChange={(o) => !o && setBulkResults(null)}>
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <LogIn className="h-5 w-5 text-pine" /> Bulk check-in results
              </AlertDialogTitle>
              <AlertDialogDescription>
                {bulkResults?.checkedIn ?? 0} checked in · {bulkResults?.skipped ?? 0} skipped · {bulkResults?.failed ?? 0} failed
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="max-h-64 overflow-y-auto scroll-slim divide-y divide-line/60 rounded-md border border-line">
              {bulkResults?.results.map((r) => (
                <div key={r.reservationId} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full shrink-0",
                      r.result === "checked_in" ? "bg-ok" : r.result === "error" ? "bg-danger" : "bg-muted-ink/40"
                    )}
                    aria-hidden
                  />
                  <span className="font-medium text-pine flex-1 min-w-0 truncate">
                    {r.guestName} {r.roomNumber ? `· Room ${r.roomNumber}` : ""}
                  </span>
                  <span className={cn(
                    "text-[11px] text-right",
                    r.result === "checked_in" ? "text-ok" : r.result === "error" ? "text-danger" : "text-muted-ink"
                  )}>
                    {r.result === "checked_in" ? "In-house" : (r.reason ?? r.result)}
                  </span>
                </div>
              ))}
            </div>
            <AlertDialogFooter>
              <AlertDialogAction className="btn-pine" onClick={() => setBulkResults(null)}>Done</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        {/* Bulk check-out confirmation */}
        <AlertDialog open={coConfirmOpen} onOpenChange={setCoConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Check out {inHouseMembers.length} in-house room(s) of group {group.code}?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-[13px]">
                  <p>
                    Every <b>in-house</b> member is checked out and their room flips to <b className="text-warn">Dirty</b> for
                    housekeeping. Unbilled nights are departure-posted automatically.
                  </p>
                  {balance > 0 && (
                    <p className="rounded border border-brass/40 bg-brass-50/60 px-2.5 py-1.5 text-brass">
                      Outstanding group balance {inr(balance, { decimals: true })} stays due — rooms are released either way.
                      Collect from the group folio in Billing.
                    </p>
                  )}
                  <p className="text-muted-ink">
                    Guests leaving before their booked departure date are re-priced to the nights actually stayed.
                  </p>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={coRunning}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className="btn-pine"
                onClick={(e) => { e.preventDefault(); runBulkCheckOut(); }}
                disabled={coRunning}
              >
                {coRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                Check out {inHouseMembers.length} room(s)
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Bulk check-out results — per-member balance + total outstanding */}
        <AlertDialog open={!!coResults} onOpenChange={(o) => !o && setCoResults(null)}>
          <AlertDialogContent className="sm:max-w-md">
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <LogOut className="h-5 w-5 text-pine" /> Bulk check-out results
              </AlertDialogTitle>
              <AlertDialogDescription>
                {coResults?.checkedOut ?? 0} checked out · {coResults?.skipped ?? 0} skipped · {coResults?.failed ?? 0} failed
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="max-h-64 overflow-y-auto scroll-slim divide-y divide-line/60 rounded-md border border-line">
              {coResults?.results.map((r) => (
                <div key={r.reservationId} className="flex items-center gap-2 px-3 py-2 text-[13px]">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full shrink-0",
                      r.result === "checked_out" ? "bg-ok" : r.result === "error" ? "bg-danger" : "bg-muted-ink/40"
                    )}
                    aria-hidden
                  />
                  <span className="font-medium text-pine flex-1 min-w-0 truncate">
                    {r.guestName} {r.roomNumber ? `· Room ${r.roomNumber}` : ""}
                    {r.earlyDeparture && (
                      <span className="ml-1 text-[11px] font-normal text-brass">
                        (early: {r.earlyDeparture.bookedNights}→{r.earlyDeparture.stayedNights}N)
                      </span>
                    )}
                  </span>
                  {r.result === "checked_out" ? (
                    <span className={cn("text-[12px] tabular-nums", (r.balance ?? 0) > 0 ? "text-brass font-medium" : "text-ok")}>
                      {(r.balance ?? 0) > 0
                        ? `Due ${inr(r.balance ?? 0, { decimals: true })}`
                        : (r.balance ?? 0) < 0
                          ? `Credit ${inr(-(r.balance ?? 0), { decimals: true })}`
                          : "Settled"}
                    </span>
                  ) : (
                    <span className={cn("text-[11px] text-right", r.result === "error" ? "text-danger" : "text-muted-ink")}>
                      {r.reason ?? r.result}
                    </span>
                  )}
                </div>
              ))}
            </div>
            {coResults && (coResults.totalOutstanding > 0 || coResults.totalCredit < 0) && (
              <div className="rounded-md border border-brass/40 bg-brass-50/60 px-3 py-2 text-[13px] flex items-center justify-between">
                <span className="text-muted-ink">
                  {coResults.totalOutstanding > 0 ? "Total outstanding" : "Total credit"}
                </span>
                <span className="font-display font-semibold text-brass tabular-nums">
                  {coResults.totalOutstanding > 0
                    ? inr(coResults.totalOutstanding, { decimals: true })
                    : inr(-coResults.totalCredit, { decimals: true })}
                </span>
              </div>
            )}
            <AlertDialogFooter>
              <AlertDialogAction className="btn-pine" onClick={() => setCoResults(null)}>Done</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

function CheckOutDialog({ reservation, onOpenChange, onDone }: {
  reservation: Reservation; onOpenChange: (o: boolean) => void; onDone: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [items, setItems] = useState<FolioItem[] | null>(null);
  const [totals, setTotals] = useState<{ total: number; paid: number; balance: number } | null>(null);

  // Early departure: guest leaves before the booked check-out date — the
  // folio will be re-priced to the nights actually stayed (min 1) at checkout.
  const today = todayISO();
  const stayedNights = Math.min(
    reservation.nights,
    Math.max(1, nightsBetween(toISODate(reservation.checkIn), today)),
  );
  const earlyDeparture = reservation.status === "checked_in" && stayedNights < reservation.nights;

  useEffect(() => {
    let stale = false;
    api<{ folioItems: FolioItem[]; total: number; paidAmount: number; balance: number }>(`/api/folio?reservationId=${reservation.id}`)
      .then((d) => {
        if (stale) return;
        setItems(d.folioItems);
        setTotals({ total: d.total, paid: d.paidAmount, balance: d.balance });
      })
      .catch(() => {
        // Folio endpoint unavailable — fall back to reservation totals
        if (stale) return;
        setItems([]);
        setTotals({ total: reservation.totalAmount, paid: reservation.paidAmount, balance: reservation.totalAmount - reservation.paidAmount });
      });
    return () => { stale = true; };
  }, [reservation.id, reservation.totalAmount, reservation.paidAmount]);

  async function submit() {
    setSaving(true);
    try {
      const res = await api<{
        balance: number;
        earlyDeparture?: { bookedNights: number; stayedNights: number; revisedTotal: number; discountClamped: boolean };
      }>(`/api/reservations/${reservation.id}/check-out`, { method: "POST" });
      toast({
        title: `Checked out — ${reservation.guest.fullName}`,
        description: res.earlyDeparture
          ? `Early departure: ${res.earlyDeparture.bookedNights}→${res.earlyDeparture.stayedNights} night(s), revised total ${inr(res.earlyDeparture.revisedTotal)} · balance ${inr(res.balance)}`
          : `Room ${reservation.room?.number ?? "—"} marked dirty for housekeeping · balance ${inr(res.balance)}`,
      });
      onDone();
    } catch (e) {
      toast({ title: "Check-out failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">Check Out — {reservation.guest.fullName}</DialogTitle>
          <DialogDescription>
            {reservation.confirmationNumber} · Room {reservation.room?.number ?? "—"} · {fmtDate(reservation.checkIn)} → {fmtDate(reservation.checkOut)}
          </DialogDescription>
        </DialogHeader>

        {earlyDeparture && (
          <div className="rounded-md border border-brass/40 bg-brass/10 px-4 py-3" role="status">
            <div className="flex items-start gap-2">
              <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-brass" />
              <div className="text-[13px] leading-snug">
                <span className="font-semibold text-brass">Early departure — folio will be re-priced.</span>{" "}
                <span className="text-muted-ink">
                  Booked {reservation.nights} night{reservation.nights === 1 ? "" : "s"} ({fmtDate(reservation.checkOut)}),
                  staying {stayedNights}. Only stayed nights will be billed; over-billed nights are credited automatically.
                </span>
              </div>
            </div>
          </div>
        )}

        <div className="rounded-md border border-line max-h-44 overflow-y-auto scroll-slim">
          {items === null ? (
            <div className="p-4 flex items-center gap-2 text-sm text-muted-ink"><Loader2 className="h-4 w-4 animate-spin" /> Loading folio…</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-muted-ink">No folio charges posted yet.</div>
          ) : (
            <table className="w-full">
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td className="td py-1.5 capitalize text-[13px]">{i.category}</td>
                    <td className="td py-1.5 text-[13px] text-muted-ink">{i.description}</td>
                    <td className="td py-1.5 text-right text-[13px]">{inr(i.amount, { decimals: true })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="space-y-1.5 text-[13px]">
          <div className="flex justify-between"><span className="text-muted-ink">Folio total</span><span>{totals ? inr(totals.total, { decimals: true }) : "—"}</span></div>
          <div className="flex justify-between"><span className="text-muted-ink">Paid</span><span className="text-ok">−{totals ? inr(totals.paid, { decimals: true }) : "—"}</span></div>
          <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-pine">
            <span>Balance due</span><span className={cn(totals && totals.balance > 0 ? "text-brass" : "text-ok")}>{totals ? inr(totals.balance, { decimals: true }) : "—"}</span>
          </div>
        </div>

        <p className="text-[11px] text-muted-ink">On checkout the room is flagged <b className="text-warn">Dirty</b> for housekeeping. Settle any balance at the desk.</p>

        <DialogFooter>
          <button className="btn-outline" onClick={() => onOpenChange(false)}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={saving || !totals}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />} Confirm Check-out
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
