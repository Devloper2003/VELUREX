"use client";

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/api-client";
import { inr, fmtDateShort, fmtDate, toISODate, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  CalendarCheck2, CheckCircle2, ChevronLeft, Copy, Globe, Loader2, MessageCircle, Percent,
  Tag, Users, ExternalLink, ShieldCheck, Plus, Trash2, Settings2,
  Play, Eraser, Timer, AlertTriangle, RefreshCw, Zap, History,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";

interface AvailabilityRoomType {
  id: string;
  name: string;
  code: string;
  description: string;
  amenities: string[];
  maxOccupancy: number;
  sizeSqft: number;
  bedType: string;
  available: number;
  nightlyRates: { date: string; rate: number }[];
  avgRate: number;
  total: number;
  taxes: { gst: number; taxAmount: number };
  grandTotal: number;
}
interface AvailabilityResponse {
  hotelName: string;
  city: string;
  nights: number;
  roomTypes: AvailabilityRoomType[];
}
interface PromoResponse {
  valid: boolean;
  message?: string;
  code?: string;
  description?: string;
  discount?: number;
}
interface PaymentIntentResponse {
  mock: boolean;
  orderId: string;
  amount: number;
}
interface BookResponse {
  confirmationNumber: string;
  reservationId: string;
  total: number;
  paid: number;
  whatsappStatus: string;
  roomTotal: number;
  discount: number;
  taxAmount: number;
  promoApplied: boolean;
  promoCode?: string | null;
}
interface EngineBooking {
  id: string;
  confirmationNumber: string;
  status: string;
  checkIn: string;
  checkOut: string;
  totalAmount: number;
  paidAmount: number;
  promoCode: string | null;
  discountAmount: number;
  guest: { fullName: string; phone: string };
  roomType: { name: string; code: string } | null;
}
interface PromoCodeRow {
  id: string;
  code: string;
  description: string;
  discountType: string;
  discountValue: number;
  validFrom: string;
  validTo: string;
  maxUses: number;
  usedCount: number;
  active: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const STATUS_BADGE: Record<string, string> = {
  confirmed: "border-pine-700/30 bg-pine-100 text-pine-700",
  checked_in: "border-ok/40 bg-ok/10 text-ok",
  checked_out: "border-line-strong bg-plaster text-muted-ink",
  cancelled: "border-danger/30 bg-danger/10 text-danger",
  no_show: "border-danger/40 bg-danger/15 text-danger",
  hold: "border-warn/40 bg-warn/10 text-warn",
};

const EMBED_SNIPPET = `<!-- Velurex booking widget -->
<script src="https://your-domain.com/api/booking-engine/widget.js"></script>
<div id="velurex-booking" data-hotel="royal-grand"></div>

<!-- Or embed the hosted booking page directly -->
<iframe src="https://your-domain.com/book"
        style="width:100%;height:640px;border:0"
        title="Book online"></iframe>`;

export default function BookingEngineView() {
  const user = useSession((s) => s.user);
  const { toast } = useToast();

  // ── Demo widget state ────────────────────────────────────────────────────
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [checkIn, setCheckIn] = useState(toISODate(new Date(Date.now() + 86400000)));
  const [checkOut, setCheckOut] = useState(toISODate(new Date(Date.now() + 3 * 86400000)));
  const [adults, setAdults] = useState(2);
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<AvailabilityRoomType | null>(null);
  const [guest, setGuest] = useState({ fullName: "", phone: "", email: "" });
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<PromoResponse | null>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [payIntent, setPayIntent] = useState<PaymentIntentResponse | null>(null);
  const [booking, setBooking] = useState<BookResponse | null>(null);
  const [confirming, setConfirming] = useState(false);

  // ── Config panels state ──────────────────────────────────────────────────
  const [bookings, setBookings] = useState<EngineBooking[] | null>(null);
  const [promoCodes, setPromoCodes] = useState<PromoCodeRow[] | null>(null);
  const [copied, setCopied] = useState(false);

  // ── Promo management (admin) ─────────────────────────────────
  const [promoManageOpen, setPromoManageOpen] = useState(false);
  const [promoDeleting, setPromoDeleting] = useState<PromoCodeRow | null>(null);
  const [promoForm, setPromoForm] = useState({
    code: "", description: "", discountType: "percent" as "percent" | "flat",
    discountValue: "", validFrom: toISODate(new Date()),
    validTo: toISODate(new Date(Date.now() + 60 * 86400000)), maxUses: "100",
  });
  const [promoSaving, setPromoSaving] = useState(false);

  const loadPromos = useCallback(async () => {
    try {
      const data = await api<{ promos: PromoCodeRow[] }>("/api/booking-engine/promos");
      setPromoCodes(data.promos);
    } catch {
      /* keep stale */
    }
  }, []);

  const createPromo = async () => {
    if (!promoForm.code.trim() || !promoForm.discountValue) {
      toast({ title: "Missing fields", description: "Code and discount value are required", variant: "destructive" });
      return;
    }
    setPromoSaving(true);
    try {
      await api("/api/booking-engine/promos", {
        method: "POST",
        body: JSON.stringify({
          code: promoForm.code.trim().toUpperCase(),
          description: promoForm.description,
          discountType: promoForm.discountType,
          discountValue: Number(promoForm.discountValue),
          validFrom: promoForm.validFrom,
          validTo: promoForm.validTo || null,
          maxUses: Number(promoForm.maxUses) || 100,
        }),
      });
      toast({ title: `Promo ${promoForm.code.toUpperCase()} created` });
      setPromoForm({ code: "", description: "", discountType: "percent", discountValue: "", validFrom: toISODate(new Date()), validTo: toISODate(new Date(Date.now() + 60 * 86400000)), maxUses: "100" });
      await loadPromos();
      await loadBookings();
    } catch (e) {
      toast({ title: "Could not create promo", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPromoSaving(false);
    }
  };

  const togglePromo = async (p: PromoCodeRow, active: boolean) => {
    try {
      await api(`/api/booking-engine/promos/${p.id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      setPromoCodes((list) => (list ?? []).map((x) => (x.id === p.id ? { ...x, active } : x)));
      toast({ title: `${p.code} ${active ? "activated" : "deactivated"}` });
    } catch (e) {
      toast({ title: "Update failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const deletePromo = async (p: PromoCodeRow) => {
    try {
      await api(`/api/booking-engine/promos/${p.id}`, { method: "DELETE" });
      setPromoCodes((list) => (list ?? []).filter((x) => x.id !== p.id));
      toast({ title: `${p.code} deleted` });
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPromoDeleting(null);
    }
  };

  const loadBookings = useCallback(async () => {
    try {
      const data = await api<{ reservations: EngineBooking[]; promoCodes: PromoCodeRow[] }>(
        "/api/booking-engine/bookings"
      );
      setBookings(data.reservations);
      setPromoCodes(data.promoCodes);
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    loadBookings();
  }, [loadBookings]);

  const checkAvailability = async () => {
    if (!checkIn || !checkOut) {
      toast({ title: "Pick check-in and check-out dates", variant: "destructive" });
      return;
    }
    if (new Date(checkOut) <= new Date(checkIn)) {
      toast({ title: "Check-out must be after check-in", variant: "destructive" });
      return;
    }
    setSearching(true);
    setPromo(null);
    setPromoInput("");
    try {
      const data = await api<AvailabilityResponse>(
        `/api/booking-engine/availability${qs({ checkIn, checkOut, adults })}`
      );
      setAvailability(data);
    } catch (e) {
      toast({ title: "Availability check failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSearching(false);
    }
  };

  const applyPromo = async () => {
    if (!selected || !promoInput.trim()) return;
    setPromoBusy(true);
    try {
      const res = await api<PromoResponse>("/api/booking-engine/promo", {
        method: "POST",
        body: JSON.stringify({ code: promoInput.trim(), amount: selected.total }),
      });
      setPromo(res);
      if (res.valid) toast({ title: `Promo ${res.code} applied`, description: `− ${inr(res.discount ?? 0)}` });
      else toast({ title: res.message ?? "Promo not valid", variant: "destructive" });
    } catch (e) {
      toast({ title: "Promo check failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setPromoBusy(false);
    }
  };

  // Quote math mirrors the server: discount on room total, 12% GST on top.
  const discount = promo?.valid ? Math.min(promo.discount ?? 0, selected?.total ?? 0) : 0;
  const netRoom = round2(Math.max(0, (selected?.total ?? 0) - discount));
  const taxAmount = round2(netRoom * 0.12);
  const grandTotal = round2(netRoom + taxAmount);

  const payAndConfirm = async () => {
    if (!selected) return;
    if (!guest.fullName.trim() || !guest.phone.trim()) {
      toast({ title: "Guest name and phone are required", variant: "destructive" });
      return;
    }
    setConfirming(true);
    setPayIntent(null);
    try {
      const intent = await api<PaymentIntentResponse>("/api/booking-engine/payment-intent", {
        method: "POST",
        body: JSON.stringify({ amount: grandTotal, name: guest.fullName, phone: guest.phone, email: guest.email }),
      });
      setPayIntent(intent);
      const res = await api<BookResponse>("/api/booking-engine/book", {
        method: "POST",
        body: JSON.stringify({
          guest: {
            fullName: guest.fullName.trim(),
            phone: guest.phone.trim(),
            email: guest.email.trim() || undefined,
          },
          roomTypeId: selected.id,
          checkIn,
          checkOut,
          adults,
          promoCode: promo?.valid ? promo.code : undefined,
          paymentId: intent.orderId,
          mockPaid: intent.mock,
        }),
      });
      setBooking(res);
      setStep(3);
      toast({ title: `Booking ${res.confirmationNumber} confirmed` });
      loadBookings();
    } catch (e) {
      toast({ title: "Booking failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setConfirming(false);
    }
  };

  const resetDemo = () => {
    setStep(1);
    setSelected(null);
    setGuest({ fullName: "", phone: "", email: "" });
    setPromo(null);
    setPromoInput("");
    setPayIntent(null);
    setBooking(null);
    setAvailability(null);
  };

  const copyEmbed = async () => {
    try {
      await navigator.clipboard.writeText(EMBED_SNIPPET);
      setCopied(true);
      toast({ title: "Embed code copied" });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: "Copy failed — select the code manually", variant: "destructive" });
    }
  };

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      {/* ── Left: working demo of the public widget ─────────────────────────── */}
      <div className="panel lg:col-span-2">
        <div className="panel-header">
          <div className="flex items-center gap-3">
            <p className="panel-title">Website booking widget</p>
            <span className="badge border-brass/40 bg-brass-50 text-brass">Live demo</span>
          </div>
          <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-ink">
            <Globe className="h-3.5 w-3.5" /> Public flow — no sign-in required
          </span>
        </div>

        <div className="p-4">
          {step === 1 && (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-[1fr_1fr_120px_auto] gap-3 items-end">
                <div>
                  <label className="field-label">Check-in</label>
                  <input type="date" className="field" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">Check-out</label>
                  <input type="date" className="field" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
                </div>
                <div>
                  <label className="field-label">Adults</label>
                  <select className="field" value={adults} onChange={(e) => setAdults(Number(e.target.value))}>
                    {[1, 2, 3, 4].map((n) => (
                      <option key={n} value={n}>{n}</option>
                    ))}
                  </select>
                </div>
                <button className="btn-brass h-9" onClick={checkAvailability} disabled={searching}>
                  {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <CalendarCheck2 className="h-4 w-4" />}
                  Check Availability
                </button>
              </div>

              {availability && (
                <div className="space-y-3">
                  <p className="text-xs text-muted-ink">
                    {availability.roomTypes.length} room types · {availability.nights} night(s) · rates include
                    seasonal / weekend plan pricing · 12% GST extra
                  </p>
                  {availability.roomTypes.map((rt) => (
                    <div
                      key={rt.id}
                      className={cn(
                        "rounded-md border p-4",
                        rt.available > 0 ? "border-line bg-panel" : "border-line bg-plaster/40 opacity-70"
                      )}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-display font-semibold text-pine">{rt.name}</h3>
                            <span className="badge border-line-strong bg-plaster text-muted-ink">{rt.code}</span>
                          </div>
                          <p className="text-xs text-muted-ink mt-0.5">
                            {rt.bedType} · {rt.sizeSqft} sq.ft · sleeps {rt.maxOccupancy}
                            {rt.description ? ` — ${rt.description}` : ""}
                          </p>
                        </div>
                        <span
                          className={cn(
                            "badge",
                            rt.available > 0 ? "border-ok/40 bg-ok/10 text-ok" : "border-danger/30 bg-danger/10 text-danger"
                          )}
                        >
                          {rt.available > 0 ? `${rt.available} available` : "Sold out"}
                        </span>
                      </div>

                      {rt.amenities.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {rt.amenities.map((a) => (
                            <span key={a} className="badge border-pine-700/20 bg-pine-100/60 text-pine-700">{a}</span>
                          ))}
                        </div>
                      )}

                      <div className="flex flex-wrap items-end justify-between gap-3 mt-3 pt-3 border-t border-line/70">
                        <div className="text-xs text-muted-ink space-y-0.5">
                          <p>
                            Avg nightly <b className="text-ink">{inr(rt.avgRate)}</b>
                            {" · "}
                            {rt.nightlyRates.map((n) => inr(n.rate)).join(" / ")}
                          </p>
                          <p>
                            Room total <b className="text-ink">{inr(rt.total)}</b> + GST {rt.taxes.gst}% (
                            {inr(rt.taxes.taxAmount)})
                          </p>
                        </div>
                        <div className="flex items-center gap-3">
                          <div className="text-right">
                            <p className="kpi-value text-lg">{inr(rt.grandTotal)}</p>
                            <p className="text-[10px] text-muted-ink uppercase tracking-wider">grand total</p>
                          </div>
                          <button
                            className="btn-pine"
                            disabled={rt.available <= 0}
                            onClick={() => {
                              setSelected(rt);
                              setStep(2);
                            }}
                          >
                            Book Now
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!availability && !searching && (
                <div className="rounded-md border border-dashed border-line-strong px-4 py-10 text-center">
                  <CalendarCheck2 className="h-8 w-8 mx-auto text-brass mb-2" />
                  <p className="text-sm text-muted-ink">
                    Pick dates and check availability — this is exactly what hotel website visitors see.
                  </p>
                </div>
              )}
            </div>
          )}

          {step === 2 && selected && (
            <div className="space-y-4">
              <button
                className="btn-ghost h-8 text-xs"
                onClick={() => {
                  setStep(1);
                  setPromo(null);
                  setPromoInput("");
                }}
              >
                <ChevronLeft className="h-4 w-4" /> Back to availability
              </button>

              <div className="rounded-md bg-brass-50/60 border border-brass/25 px-4 py-3 flex items-center justify-between">
                <div>
                  <p className="font-display font-semibold text-pine">{selected.name}</p>
                  <p className="text-xs text-muted-ink">
                    {fmtDateShort(checkIn)} → {fmtDateShort(checkOut)} · {adults} adult(s) · {selected.available} left
                  </p>
                </div>
                <p className="font-semibold text-brass">{inr(selected.total)}</p>
              </div>

              <div className="grid sm:grid-cols-3 gap-3">
                <div className="sm:col-span-1">
                  <label className="field-label">Full name *</label>
                  <input
                    className="field"
                    placeholder="Test Widget"
                    value={guest.fullName}
                    onChange={(e) => setGuest({ ...guest, fullName: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Phone *</label>
                  <input
                    className="field"
                    placeholder="+91 90000 00001"
                    value={guest.phone}
                    onChange={(e) => setGuest({ ...guest, phone: e.target.value })}
                  />
                </div>
                <div>
                  <label className="field-label">Email</label>
                  <input
                    className="field"
                    placeholder="guest@example.com"
                    value={guest.email}
                    onChange={(e) => setGuest({ ...guest, email: e.target.value })}
                  />
                </div>
              </div>

              <div className="flex gap-2 items-end max-w-sm">
                <div className="flex-1">
                  <label className="field-label">Promo code</label>
                  <input
                    className="field font-mono uppercase"
                    placeholder="EARLY15"
                    value={promoInput}
                    onChange={(e) => setPromoInput(e.target.value)}
                  />
                </div>
                <button className="btn-outline" onClick={applyPromo} disabled={promoBusy || !promoInput.trim()}>
                  {promoBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Percent className="h-4 w-4" />}
                  Apply
                </button>
              </div>
              {promo && (
                <p className={cn("text-xs flex items-center gap-1.5", promo.valid ? "text-ok" : "text-danger")}>
                  {promo.valid ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5" /> {promo.code} — {promo.description} (− {inr(discount)})
                    </>
                  ) : (
                    promo.message
                  )}
                </p>
              )}

              <div className="rounded-md border border-line px-4 py-3 text-sm space-y-1.5 max-w-sm ml-auto">
                <Row label="Room total" value={inr(selected.total)} />
                {discount > 0 && <Row label={`Promo ${promo?.code}`} value={`− ${inr(discount)}`} accent="ok" />}
                <Row label={`GST ${selected.taxes.gst}%`} value={inr(taxAmount)} />
                <div className="border-t border-line pt-1.5 flex items-center justify-between">
                  <span className="font-semibold text-pine">Grand total</span>
                  <span className="font-semibold text-pine">{inr(grandTotal)}</span>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                {payIntent ? (
                  <span
                    className={cn(
                      "badge",
                      payIntent.mock ? "border-brass/40 bg-brass-50 text-brass" : "border-ok/40 bg-ok/10 text-ok"
                    )}
                  >
                    <ShieldCheck className="h-3 w-3" />
                    {payIntent.mock ? "Razorpay (mock)" : "Razorpay"} · {payIntent.orderId.slice(0, 22)}
                  </span>
                ) : (
                  <span className="text-xs text-muted-ink">Payment is captured via Razorpay before confirming.</span>
                )}
                <button className="btn-brass" onClick={payAndConfirm} disabled={confirming}>
                  {confirming ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  Pay &amp; Confirm · {inr(grandTotal)}
                </button>
              </div>
            </div>
          )}

          {step === 3 && booking && (
            <div className="py-8 text-center space-y-3">
              <div className="h-14 w-14 rounded-full bg-ok/10 border border-ok/30 flex items-center justify-center mx-auto">
                <CheckCircle2 className="h-7 w-7 text-ok" />
              </div>
              <h3 className="section-title">Booking confirmed!</h3>
              <p className="font-display text-3xl font-semibold text-brass tracking-tight">{booking.confirmationNumber}</p>
              <p className="text-sm text-muted-ink">
                {selected?.name} · {fmtDate(checkIn)} → {fmtDate(checkOut)} · {guest.fullName} · {guest.phone}
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
                <span className="badge border-line-strong bg-plaster text-muted-ink">Total {inr(booking.total)}</span>
                <span className="badge border-ok/40 bg-ok/10 text-ok">Paid {inr(booking.paid)}</span>
                <span
                  className={cn(
                    "badge",
                    booking.whatsappStatus === "mock"
                      ? "border-brass/40 bg-brass-50 text-brass"
                      : booking.whatsappStatus === "sent"
                        ? "border-ok/40 bg-ok/10 text-ok"
                        : "border-danger/30 bg-danger/10 text-danger"
                  )}
                >
                  <MessageCircle className="h-3 w-3" /> WhatsApp {booking.whatsappStatus}
                </span>
              </div>
              <div>
                <button className="btn-outline mt-2" onClick={resetDemo}>
                  Make another booking
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Right: configuration panels ─────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="panel">
          <div className="panel-header">
            <p className="panel-title">Embed code</p>
            <button className="btn-ghost h-7 text-xs" onClick={copyEmbed}>
              {copied ? <CheckCircle2 className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <div className="p-4 space-y-2">
            <a
              href="/book"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-outline w-full h-9 justify-center"
              title="Open the guest-facing hosted booking page"
            >
              <ExternalLink className="h-3.5 w-3.5 text-brass" /> Open hosted booking page (/book)
            </a>
            <pre className="rounded-md bg-pine text-[#cfe3da] text-[11px] leading-relaxed p-3 overflow-x-auto scroll-slim">
              {EMBED_SNIPPET}
            </pre>
            <p className="text-[11px] text-muted-ink flex items-start gap-1.5">
              <ExternalLink className="h-3 w-3 mt-0.5 shrink-0" />
              <span>
                Drop the snippet into any website — the widget talks to the public{" "}
                <code className="font-mono">/api/booking-engine/*</code> endpoints, so no admin credentials are ever exposed.
              </span>
            </p>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <p className="panel-title">Recent online bookings</p>
            <span className="text-xs text-muted-ink">{bookings?.length ?? 0}</span>
          </div>
          {bookings && bookings.length > 0 && <EngineStats bookings={bookings} />}
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[520px]">
              <thead>
                <tr>
                  <th className="th">Conf #</th>
                  <th className="th">Guest</th>
                  <th className="th">Stay</th>
                  <th className="th">Total</th>
                  <th className="th">Promo</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {(bookings ?? []).map((b) => (
                  <tr key={b.id} className="hover:bg-plaster/50">
                    <td className="td font-medium text-pine whitespace-nowrap">{b.confirmationNumber}</td>
                    <td className="td">
                      <p className="truncate max-w-[140px]">{b.guest.fullName}</p>
                      <p className="text-[11px] text-muted-ink truncate max-w-[140px]">{b.roomType?.name ?? "—"}</p>
                    </td>
                    <td className="td whitespace-nowrap text-xs">
                      {fmtDateShort(b.checkIn)} → {fmtDateShort(b.checkOut)}
                    </td>
                    <td className="td whitespace-nowrap">
                      <p className="font-medium">{inr(b.totalAmount)}</p>
                      {b.paidAmount > 0 && (
                        <p className="text-[11px] text-ok">paid {inr(b.paidAmount)}</p>
                      )}
                    </td>
                    <td className="td whitespace-nowrap">
                      {b.promoCode ? (
                        <span
                          className="badge border-brass/40 bg-brass-50 text-brass"
                          title={`Promo ${b.promoCode} — saved ${inr(b.discountAmount)}`}
                        >
                          <Tag className="h-3 w-3" /> {b.promoCode}
                        </span>
                      ) : (
                        <span className="text-muted-ink text-xs">—</span>
                      )}
                    </td>
                    <td className="td">
                      <span className={cn("badge", STATUS_BADGE[b.status] ?? "")}>
                        {STATUS_LABELS[b.status] ?? b.status}
                      </span>
                    </td>
                  </tr>
                ))}
                {bookings && bookings.length === 0 && (
                  <tr>
                    <td className="td text-center text-muted-ink" colSpan={6}>
                      No online bookings yet — try the demo widget.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <p className="panel-title">Promo codes</p>
            {user?.role === "hotel_admin" ? (
              <button className="btn-outline h-8 text-xs" onClick={() => { setPromoManageOpen(true); loadPromos(); }}>
                <Settings2 className="h-3.5 w-3.5" /> Manage
              </button>
            ) : (
              <span className="text-xs text-muted-ink">managed by admin</span>
            )}
          </div>
          <div className="divide-y divide-line/70">
            {(promoCodes ?? []).map((p) => (
              <div key={p.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Tag className="h-3.5 w-3.5 text-brass shrink-0" />
                    <p className="font-mono text-sm font-semibold text-pine">{p.code}</p>
                    <span
                      className={cn(
                        "badge",
                        p.active ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"
                      )}
                    >
                      {p.active ? "Active" : "Inactive"}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-ink mt-0.5 truncate">
                    {p.description} · {fmtDateShort(p.validFrom)} → {fmtDateShort(p.validTo)}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-medium text-pine">
                    {p.discountType === "percent" ? `${p.discountValue}% off` : `${inr(p.discountValue)} off`}
                  </p>
                  <p className="text-[11px] text-muted-ink flex items-center justify-end gap-1">
                    <Users className="h-3 w-3" /> {p.usedCount}/{p.maxUses}
                  </p>
                </div>
              </div>
            ))}
            {promoCodes && promoCodes.length === 0 && (
              <div className="px-4 py-6 text-sm text-muted-ink text-center">No promo codes configured</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Full-width: oversale guard — race conditions & payment failures ── */}
      <div className="lg:col-span-3">
        <OversaleGuardPanel isAdmin={user?.role === "hotel_admin"} />
      </div>

      {/* ── Promo management dialog (admin) ─────────────────────────────── */}
      <Dialog open={promoManageOpen} onOpenChange={setPromoManageOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">Manage Promo Codes</DialogTitle>
            <DialogDescription>Codes apply automatically in the public booking engine.</DialogDescription>
          </DialogHeader>

          {/* Create form */}
          <div className="panel border-line p-3 space-y-2.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">New promo</p>
            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="field-label">Code *</label>
                <input className="field font-mono uppercase" placeholder="SUMMER20" maxLength={24}
                  value={promoForm.code} onChange={(e) => setPromoForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} />
              </div>
              <div>
                <label className="field-label">Discount value *</label>
                <input className="field" type="number" min="1" placeholder="15" value={promoForm.discountValue}
                  onChange={(e) => setPromoForm((f) => ({ ...f, discountValue: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Type</label>
                <select className="field" value={promoForm.discountType}
                  onChange={(e) => setPromoForm((f) => ({ ...f, discountType: e.target.value as "percent" | "flat" }))}>
                  <option value="percent">% off</option>
                  <option value="flat">Flat ₹ off</option>
                </select>
              </div>
              <div>
                <label className="field-label">Max uses</label>
                <input className="field" type="number" min="1" value={promoForm.maxUses}
                  onChange={(e) => setPromoForm((f) => ({ ...f, maxUses: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Valid from</label>
                <input className="field" type="date" value={promoForm.validFrom}
                  onChange={(e) => setPromoForm((f) => ({ ...f, validFrom: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Valid to</label>
                <input className="field" type="date" value={promoForm.validTo}
                  onChange={(e) => setPromoForm((f) => ({ ...f, validTo: e.target.value }))} />
              </div>
            </div>
            <div>
              <label className="field-label">Description</label>
              <input className="field" placeholder="Summer saver — 20% off direct bookings" value={promoForm.description}
                onChange={(e) => setPromoForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
            <button className="btn-pine w-full" onClick={createPromo} disabled={promoSaving}>
              {promoSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create Promo Code
            </button>
          </div>

          {/* Existing promos */}
          <div className="space-y-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Existing ({(promoCodes ?? []).length})</p>
            {(promoCodes ?? []).map((p) => (
              <div key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2 bg-panel">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-pine">{p.code}</p>
                  <p className="text-[11px] text-muted-ink truncate">
                    {p.discountType === "percent" ? `${p.discountValue}%` : inr(p.discountValue)} off · {fmtDateShort(p.validFrom)} → {fmtDateShort(p.validTo)} · {p.usedCount}/{p.maxUses} used
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Switch checked={p.active} onCheckedChange={(v) => togglePromo(p, v)} aria-label={`Toggle ${p.code}`} />
                  <button
                    className="h-8 w-8 rounded-md flex items-center justify-center text-danger hover:bg-danger/10 transition disabled:opacity-40"
                    disabled={p.usedCount > 0}
                    title={p.usedCount > 0 ? "Redeemed promos cannot be deleted" : "Delete promo"}
                    onClick={() => setPromoDeleting(p)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
            {promoCodes && promoCodes.length === 0 && (
              <p className="text-xs text-muted-ink text-center py-3">No promo codes yet — create the first one above.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!promoDeleting} onOpenChange={(v) => !v && setPromoDeleting(null)}>
        <AlertDialogContent className="bg-panel border-line">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-pine">Delete promo {promoDeleting?.code}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. Only unused promo codes can be deleted.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-line bg-panel hover:bg-plaster">Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-danger text-white hover:bg-danger/90" onClick={() => promoDeleting && deletePromo(promoDeleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent?: "ok" }) {
  return (
    <div className="flex items-center justify-between text-[13px]">
      <span className="text-muted-ink">{label}</span>
      <span className={cn("font-medium", accent === "ok" ? "text-ok" : "text-ink")}>{value}</span>
    </div>
  );
}

/** Channel KPI strip computed from the loaded engine bookings (cancelled excluded). */
function EngineStats({ bookings }: { bookings: EngineBooking[] }) {
  const active = bookings.filter((b) => b.status !== "cancelled");
  const revenue = active.reduce((s, b) => s + b.totalAmount, 0);
  const collected = active.reduce((s, b) => s + b.paidAmount, 0);
  const savings = active.reduce((s, b) => s + (b.promoCode ? b.discountAmount : 0), 0);
  const promoCount = active.filter((b) => b.promoCode).length;
  const paidShare = revenue > 0 ? Math.min(100, Math.round((collected / revenue) * 100)) : 0;

  const stats = [
    { label: "Bookings", value: String(active.length), sub: `${bookings.length - active.length} cancelled`, tone: "text-pine" },
    { label: "Engine revenue", value: inr(revenue), sub: `${inr(collected)} collected`, tone: "text-ink" },
    { label: "Promo savings", value: inr(savings), sub: `${promoCount} redeemed`, tone: "text-brass" },
    { label: "Collected", value: `${paidShare}%`, sub: "of booked value", tone: paidShare >= 50 ? "text-ok" : "text-warn" },
  ];

  return (
    <div className="grid grid-cols-2 border-b border-line bg-plaster/40">
      {stats.map((s, idx) => (
        <div
          key={s.label}
          className={cn(
            "px-3.5 py-2.5",
            idx % 2 === 1 && "border-l border-line",
            idx >= 2 && "border-t border-line"
          )}
        >
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">{s.label}</p>
          <p className={cn("font-display text-base font-semibold leading-tight mt-0.5", s.tone)}>{s.value}</p>
          <p className="text-[10px] text-muted-ink">{s.sub}</p>
        </div>
      ))}
    </div>
  );
}

/* ─── Oversale guard — race-condition telemetry + simulator ──────────────── */

interface GuardHold {
  id: string; status: string; roomTypeName: string; nights: number;
  checkIn: string; checkOut: string; guestName: string; grandTotal: number;
  tag: string; createdAt: string; expiresAt: string;
}
interface GuardStats {
  activeHolds: number;
  last24h: { created: number; redeemed: number; released: number; expired: number; failedPayments: number; rejected: number };
  recentHolds: GuardHold[];
  roomTypes: { id: string; name: string; code: string }[];
}
interface StressResult {
  attempts: number; granted: number; soldOut: number; errors: string[];
}

const HOLD_STATUS_BADGE: Record<string, string> = {
  active: "border-brass/45 bg-brass-50 text-brass",
  redeemed: "border-ok/40 bg-ok/10 text-ok",
  released: "border-line-strong bg-plaster text-muted-ink",
  expired: "border-danger/35 bg-danger/10 text-danger",
};

const GUARD_LAYERS = [
  { title: "Write-locked availability", text: "The hold INSERT is the transaction's first statement — concurrent bookings re-check availability after the winner commits, so the last room can only sell once." },
  { title: "10-minute holds", text: "Payment checkouts reserve the room with a TTL — no one else can sell it mid-payment, and abandoned checkouts are reaped automatically." },
  { title: "Idempotent settle", text: "Duplicate payment callbacks can't double-charge: the confirm is a status-guarded claim that only one caller can win — everyone else gets the same confirmation." },
  { title: "Instant release", text: "A declined payment frees the room the same instant (with a failed-payment audit row) — inventory never leaks while a guest retries." },
];

function OversaleGuardPanel({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const [stats, setStats] = useState<GuardStats | null>(null);
  const [roomTypeId, setRoomTypeId] = useState("");
  const [attempts, setAttempts] = useState("10");
  const [stressIn, setStressIn] = useState(toISODate(new Date(Date.now() + 86400000)));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<StressResult | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<GuardStats>("/api/booking-engine/guard");
      setStats(data);
      setRoomTypeId((cur) => cur || data.roomTypes[0]?.id || "");
    } catch {
      /* keep stale */
    }
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, 8000);
    return () => window.clearInterval(t);
  }, [load]);

  const runStress = async () => {
    if (!roomTypeId) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await api<StressResult & { ok: boolean }>("/api/booking-engine/guard", {
        method: "POST",
        body: JSON.stringify({ action: "stress", roomTypeId, checkIn: stressIn, attempts: Number(attempts) }),
      });
      setResult({ attempts: res.attempts, granted: res.granted, soldOut: res.soldOut, errors: res.errors });
      toast({
        title: `Drill complete — ${res.granted} granted, ${res.soldOut} rejected`,
        description: res.soldOut > 0
          ? "Exactly the behaviour you want: no oversell, clean 409s for the losers."
          : "No rejections — that room type had spare inventory. Try a tighter date or more attempts.",
      });
      await load();
    } catch (e) {
      toast({ title: "Drill failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const cleanup = async () => {
    setBusy(true);
    try {
      const res = await api<{ released: number }>("/api/booking-engine/guard", {
        method: "POST",
        body: JSON.stringify({ action: "cleanup-stress" }),
      });
      toast({ title: `${res.released} stress hold${res.released === 1 ? "" : "s"} released`, description: "Inventory restored." });
      setResult(null);
      await load();
    } catch (e) {
      toast({ title: "Cleanup failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const m = stats?.last24h;
  const chips: { label: string; value: number; tone: string }[] = [
    { label: "Active holds", value: stats?.activeHolds ?? 0, tone: "text-brass" },
    { label: "Redeemed 24h", value: m?.redeemed ?? 0, tone: "text-ok" },
    { label: "Released 24h", value: m?.released ?? 0, tone: "text-muted-ink" },
    { label: "Expired 24h", value: m?.expired ?? 0, tone: "text-muted-ink" },
    { label: "Failed payments 24h", value: m?.failedPayments ?? 0, tone: "text-danger" },
    { label: "Oversales blocked 24h", value: m?.rejected ?? 0, tone: "text-pine" },
  ];

  const holds = showAll ? (stats?.recentHolds ?? []) : (stats?.recentHolds ?? []).slice(0, 5);

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-ok" />
          <p className="panel-title">Oversale guard — race conditions &amp; payment failures</p>
        </div>
        <button className="btn-ghost h-7 text-xs" onClick={load} aria-label="Refresh guard stats">
          <RefreshCw className={cn("h-3.5 w-3.5", !stats && "animate-spin")} />
        </button>
      </div>

      {/* Guard layer explainer */}
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 border-b border-line divide-y sm:divide-y-0 xl:divide-x divide-line/70">
        {GUARD_LAYERS.map((l, i) => (
          <div key={l.title} className={cn("px-4 py-3", i < 2 && "sm:border-b xl:border-b-0 border-line/70")}>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-pine flex items-center gap-1.5">
              <span className="h-4 w-4 rounded-[5px] bg-pine-700 text-panel text-[9px] font-bold grid place-items-center">{i + 1}</span>
              {l.title}
            </p>
            <p className="text-[11px] text-muted-ink leading-relaxed mt-1">{l.text}</p>
          </div>
        ))}
      </div>

      {/* Stats chips */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-px bg-line/60 border-b border-line">
        {chips.map((c) => (
          <div key={c.label} className="bg-panel px-3.5 py-2.5">
            <p className={cn("font-display text-lg font-semibold leading-tight", c.tone)}>{c.value}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-ink">{c.label}</p>
          </div>
        ))}
      </div>

      <div className="p-4 grid lg:grid-cols-[380px_1fr] gap-5">
        {/* Simulator (admin) */}
        {isAdmin ? (
          <div className="rounded-md border border-line bg-plaster/40 p-3.5">
            <p className="text-[12px] font-semibold text-pine flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-brass" /> Race-condition drill
            </p>
            <p className="text-[11px] text-muted-ink mt-1 leading-relaxed">
              Fires N truly parallel booking requests for the same room type and night — exactly like N guests
              grabbing the last room at once. Watch the guard grant the available rooms and reject the rest.
            </p>
            <div className="grid grid-cols-2 gap-2 mt-3">
              <label className="col-span-2">
                <span className="field-label text-[10px]">Room type</span>
                <select className="field h-8 text-[12px]" value={roomTypeId} onChange={(e) => setRoomTypeId(e.target.value)}>
                  {(stats?.roomTypes ?? []).map((rt) => (
                    <option key={rt.id} value={rt.id}>{rt.name} ({rt.code})</option>
                  ))}
                </select>
              </label>
              <label>
                <span className="field-label text-[10px]">Check-in</span>
                <input type="date" className="field h-8 text-[12px]" value={stressIn} onChange={(e) => setStressIn(e.target.value)} />
              </label>
              <label>
                <span className="field-label text-[10px]">Parallel attempts</span>
                <select className="field h-8 text-[12px]" value={attempts} onChange={(e) => setAttempts(e.target.value)}>
                  {["5", "10", "20", "30"].map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
            </div>
            <div className="flex gap-2 mt-3">
              <button className="btn-pine h-8 text-[12px] flex-1 justify-center" onClick={runStress} disabled={busy || !roomTypeId}>
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                Run drill
              </button>
              <button className="btn-outline h-8 text-[12px]" onClick={cleanup} disabled={busy} title="Release every active stress-test hold">
                <Eraser className="h-3.5 w-3.5" /> Cleanup holds
              </button>
            </div>

            {result && (
              <div className="mt-3 rounded-md border border-line-strong bg-panel p-3 expand-in" role="status">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded bg-ok/10 border border-ok/30 py-1.5">
                    <p className="font-display text-lg font-semibold text-ok leading-none">{result.granted}</p>
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-ink mt-1">Granted</p>
                  </div>
                  <div className="rounded bg-danger/10 border border-danger/30 py-1.5">
                    <p className="font-display text-lg font-semibold text-danger leading-none">{result.soldOut}</p>
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-ink mt-1">Rejected 409</p>
                  </div>
                  <div className="rounded bg-plaster border border-line py-1.5">
                    <p className="font-display text-lg font-semibold text-pine leading-none">{result.attempts}</p>
                    <p className="text-[9.5px] uppercase tracking-wider text-muted-ink mt-1">Fired</p>
                  </div>
                </div>
                <p className="text-[10.5px] text-muted-ink mt-2 leading-relaxed">
                  Granted holds reserved real inventory for 10 minutes (tagged stress-test). “Cleanup holds” releases
                  them instantly. Rejections are logged as BOOKING_REJECTED — zero oversells is the pass condition.
                </p>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-line bg-plaster/40 p-3.5 text-[12px] text-muted-ink">
            <p className="font-semibold text-pine flex items-center gap-1.5"><Timer className="h-3.5 w-3.5 text-brass" /> Guard is active</p>
            <p className="mt-1.5 leading-relaxed">
              Every online booking runs through write-locked holds with idempotent payment settlement.
              The stress drill is available to hotel admins only.
            </p>
          </div>
        )}

        {/* Recent holds */}
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-pine flex items-center gap-1.5 mb-2">
            <History className="h-3.5 w-3.5 text-brass" /> Hold lifecycle — latest {holds.length}
          </p>
          <div className="rounded-md border border-line overflow-hidden">
            <div className="max-h-64 overflow-y-auto scroll-slim divide-y divide-line/60">
              {holds.length === 0 && (
                <p className="px-3.5 py-6 text-[12px] text-muted-ink text-center">
                  No holds yet — they appear the moment a guest starts a pay-now checkout.
                </p>
              )}
              {holds.map((h) => (
                <div key={h.id} className="px-3.5 py-2.5 flex items-center gap-3">
                  <span className={cn("badge shrink-0 text-[9.5px]", HOLD_STATUS_BADGE[h.status] ?? "")}>{h.status}</span>
                  <div className="min-w-0 flex-1 leading-tight">
                    <p className="text-[12.5px] text-ink truncate">
                      {h.guestName || "Guest"} <span className="text-muted-ink">· {h.roomTypeName} · {h.nights}N from {fmtDateShort(h.checkIn)}</span>
                    </p>
                    <p className="text-[10.5px] text-muted-ink">
                      {inr(h.grandTotal)} · {new Date(h.createdAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
                      {h.tag ? ` · ${h.tag}` : ""}
                    </p>
                  </div>
                  {h.status === "active" && (
                    <span className="text-[10px] text-brass tabular-nums shrink-0" title="Time until the hold expires">
                      {Math.max(0, Math.round((new Date(h.expiresAt).getTime() - Date.now()) / 1000))}s
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
          {(stats?.recentHolds.length ?? 0) > 5 && (
            <button className="btn-ghost h-7 text-[11px] mt-1.5" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${stats?.recentHolds.length} events`}
            </button>
          )}
          <p className="text-[10.5px] text-muted-ink mt-2 flex items-start gap-1.5">
            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-brass" />
            Oversale rejections (BOOKING_REJECTED) and failed payments are also visible in Reports → activity log
            with the full decision trail.
          </p>
        </div>
      </div>
    </div>
  );
}
