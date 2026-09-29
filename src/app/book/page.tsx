"use client";

/**
 * /book — guest-facing hosted booking page (public).
 *
 * The iframe-less companion to the embeddable widget: consumes the same public
 * booking-engine endpoints (availability → promo → payment-intent → book) with
 * a full-page storefront experience in the Velurex design system.
 *
 * Flow: search dates & guests → pick a room → guest details + payment choice
 * (pay at hotel, or pay now through the Razorpay-shaped checkout) → instant
 * confirmation with the reference number and WhatsApp delivery status.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2, Search, BedDouble, Users, Maximize, Check, ChevronDown, ShieldCheck,
  MessageCircle, Sparkles, CalendarDays, ArrowLeft, Copy, CheckCircle2, XCircle,
  Landmark, Wallet, Tag, Info, Star, Timer, AlertTriangle,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConfigRoomType {
  id: string;
  name: string;
  code: string;
  baseRate: number;
  maxOccupancy: number;
  description: string;
  amenities: string[];
  sizeSqft: number;
  bedType: string;
}
interface ConfigResponse {
  hotelName: string;
  city: string;
  currency: string;
  roomTypes: ConfigRoomType[];
}
interface QuotedRoomType extends ConfigRoomType {
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
  roomTypes: QuotedRoomType[];
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
  keyId?: string;
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
interface HoldResponse {
  holdId: string;
  status: string;
  duplicate: boolean;
  expiresAt: string;
  ttlSeconds: number;
  nights: number;
  roomTypeName: string;
  totalAmount: number;
  discountAmount: number;
  promoApplied: string | null;
  taxAmount: number;
  grandTotal: number;
}

const money = (n: number) =>
  `₹${(Number.isFinite(n) ? n : 0).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
const money2 = (n: number) =>
  `₹${(Number.isFinite(n) ? n : 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d + days);
  return toISODate(dt);
}
function nightsBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((new Date(by, bm - 1, bd).getTime() - new Date(ay, am - 1, ad).getTime()) / 86400000);
}
const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WDAYS_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtDay(iso: string): string {
  // Locale-independent "Sat, 26 Sep" — consistent with the HMS date format.
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return `${WDAYS_SHORT[dt.getDay()]}, ${d} ${MONTHS_SHORT[m - 1]}`;
}

// ─── Page ────────────────────────────────────────────────────────────────────

type Step = "rooms" | "guest" | "confirmed";

export default function BookPage() {
  // Storefront config (public)
  const [config, setConfig] = useState<ConfigResponse | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  // Search
  const today = toISODate(new Date());
  const [checkIn, setCheckIn] = useState(today);
  const [checkOut, setCheckOut] = useState(addDaysISO(today, 2));
  const [adults, setAdults] = useState(2);
  const [children, setChildren] = useState(0);
  const [searched, setSearched] = useState(false);

  // Availability
  const [availability, setAvailability] = useState<AvailabilityResponse | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [availError, setAvailError] = useState<string | null>(null);

  // Selection + step
  const [step, setStep] = useState<Step>("rooms");
  const [selected, setSelected] = useState<QuotedRoomType | null>(null);
  const guestRef = useRef<HTMLDivElement | null>(null);

  // Promo
  const [promoInput, setPromoInput] = useState("");
  const [promo, setPromo] = useState<PromoResponse | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  // Guest form
  const [guest, setGuest] = useState({ fullName: "", phone: "", email: "", idType: "", idNumber: "" });
  const [formError, setFormError] = useState<string | null>(null);

  // Payment
  const [payMode, setPayModeRaw] = useState<"hotel" | "now">("hotel");
  const [razorpayOpen, setRazorpayOpen] = useState(false);
  const [razorpayBusy, setRazorpayBusy] = useState(false);
  const [booking, setBooking] = useState(false);
  const [confirmed, setConfirmed] = useState<BookResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Race-condition guard: 10-minute inventory hold taken before the gateway
  // opens, so nobody can sell the room out from under a paying guest.
  const [hold, setHold] = useState<HoldResponse | null>(null);
  const [holdBusy, setHoldBusy] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [payFailure, setPayFailure] = useState<string | null>(null);
  const idemKeyRef = useRef<string>(""); // one idempotency key per checkout attempt

  function setPayMode(mode: "hotel" | "now") {
    // Switching away from "now" while a hold is active → release it so the
    // room goes straight back into availability.
    if (mode === "hotel" && hold && hold.status === "active") {
      void fetch("/api/booking-engine/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: hold.holdId, outcome: "release" }),
      }).catch(() => {});
      setHold(null);
    }
    setPayFailure(null);
    setPayModeRaw(mode);
  }

  // Local countdown off the server-provided expiry (single clock source).
  useEffect(() => {
    if (!hold || hold.status !== "active") return;
    const tick = () => {
      const left = Math.max(0, Math.round((new Date(hold.expiresAt).getTime() - Date.now()) / 1000));
      setSecondsLeft(left);
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [hold]);

  const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

  useEffect(() => {
    fetch("/api/booking-engine/config")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Config unavailable (${r.status})`))))
      .then((d: ConfigResponse) => setConfig(d))
      .catch((e: Error) => setConfigError(e.message));
  }, []);

  const nights = useMemo(() => nightsBetween(checkIn, checkOut), [checkIn, checkOut]);
  const dateInvalid = nights < 1 || nights > 31;

  const runSearch = useCallback(async () => {
    if (dateInvalid) return;
    setAvailLoading(true);
    setAvailError(null);
    setSearched(true);
    setSelected(null);
    try {
      const r = await fetch(
        `/api/booking-engine/availability?checkIn=${checkIn}&checkOut=${checkOut}&adults=${adults}`
      );
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Search failed (${r.status})`);
      setAvailability(d as AvailabilityResponse);
    } catch (e) {
      setAvailability(null);
      setAvailError((e as Error).message);
    } finally {
      setAvailLoading(false);
    }
  }, [checkIn, checkOut, adults, dateInvalid]);

  // Auto-run an initial search so the page never looks empty
  useEffect(() => {
    if (config && !searched && !dateInvalid) runSearch();
  }, [config, searched, dateInvalid, runSearch]);

  function pickRoom(rt: QuotedRoomType) {
    setSelected(rt);
    setStep("guest");
    setFormError(null);
    setTimeout(() => guestRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }

  async function applyPromo() {
    if (!selected || !promoInput.trim()) return;
    setPromoChecking(true);
    try {
      const r = await fetch("/api/booking-engine/promo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: promoInput.trim(), amount: selected.total }),
      });
      const d = (await r.json()) as PromoResponse;
      setPromo(d);
    } catch {
      setPromo({ valid: false, message: "Could not validate the promo code — try again" });
    } finally {
      setPromoChecking(false);
    }
  }

  const discount = promo?.valid ? (promo.discount ?? 0) : 0;
  const netTotal = Math.max(0, (selected?.total ?? 0) - discount);
  const taxAmount = Math.round(netTotal * 0.12 * 100) / 100;
  const grandTotal = Math.round((netTotal + taxAmount) * 100) / 100;

  function validateForm(): string | null {
    if (!guest.fullName.trim() || guest.fullName.trim().length < 3) return "Please enter the lead guest's full name";
    const digits = guest.phone.replace(/\D/g, "");
    if (digits.length < 10) return "Please enter a valid 10-digit mobile number";
    if (guest.email && !/^\S+@\S+\.\S+$/.test(guest.email)) return "The email address doesn't look right";
    return null;
  }

  async function confirmBooking() {
    if (!selected) return;
    const err = validateForm();
    if (err) {
      setFormError(err);
      return;
    }
    setFormError(null);
    setPayFailure(null);
    if (payMode === "now") {
      // Race-condition guard: take a 10-minute inventory hold BEFORE the
      // gateway opens — the room is ours while we pay, and if the card
      // declines the hold is released and nobody ever double-sold.
      await createHoldAndOpenGateway();
      return;
    }
    await submitBooking(false);
  }

  async function createHoldAndOpenGateway() {
    if (!selected) return;
    setHoldBusy(true);
    try {
      if (!idemKeyRef.current) idemKeyRef.current = `checkout-${crypto.randomUUID()}`;
      const r = await fetch("/api/booking-engine/hold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomTypeId: selected.id,
          checkIn,
          checkOut,
          adults,
          children,
          guestName: guest.fullName.trim(),
          guestPhone: guest.phone.trim(),
          promoCode: promo?.valid ? promo.code : undefined,
          idempotencyKey: idemKeyRef.current,
        }),
      });
      const d = (await r.json()) as HoldResponse & { error?: string; code?: string };
      if (!r.ok) throw new Error(d.error || `Could not hold the room (${r.status})`);
      setHold(d);
      setRazorpayOpen(true);
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setHoldBusy(false);
    }
  }

  async function settlePayment(outcome: "success" | "failure") {
    if (!hold) return;
    setRazorpayBusy(true);
    try {
      if (outcome === "success") {
        const pr = await fetch("/api/booking-engine/payment-intent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount: hold.grandTotal, name: guest.fullName, phone: guest.phone, email: guest.email }),
        });
        const intent = (await pr.json()) as PaymentIntentResponse;
        // Demo gateway: simulate the authorization round-trip (real keys
        // would open Razorpay's checkout.js with intent.orderId + keyId).
        await new Promise((res) => setTimeout(res, 1100));
        const pay = await fetch("/api/booking-engine/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ holdId: hold.holdId, outcome: "success", gatewayRef: intent.orderId }),
        });
        const d = (await pay.json()) as {
          outcome?: string; duplicate?: boolean;
          reservation?: { confirmationNumber: string; id: string; totalAmount: number; paidAmount: number };
          error?: string; code?: string;
        };
        if (!pay.ok) {
          if (d.code === "HOLD_EXPIRED") {
            setRazorpayOpen(false);
            setHold(null);
            setPayFailure("Your 10-minute room hold expired before the payment completed — the room was released. Please pick your dates again.");
          } else {
            throw new Error(d.error || "Payment settlement failed");
          }
          return;
        }
        if (d.reservation) {
          setRazorpayOpen(false);
          setConfirmed({
            confirmationNumber: d.reservation.confirmationNumber,
            reservationId: d.reservation.id,
            total: d.reservation.totalAmount,
            paid: d.reservation.paidAmount,
            whatsappStatus: "queued",
            roomTotal: hold.totalAmount + hold.discountAmount,
            discount: hold.discountAmount,
            taxAmount: hold.taxAmount,
            promoApplied: Boolean(hold.promoApplied),
            promoCode: hold.promoApplied,
          });
          setStep("confirmed");
          setHold(null);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      } else {
        // Simulated decline — the server releases the hold atomically and
        // writes a failed Payment row; the room is instantly sellable again.
        await new Promise((res) => setTimeout(res, 900));
        const pay = await fetch("/api/booking-engine/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ holdId: hold.holdId, outcome: "failure", reason: "card declined (demo)" }),
        });
        const d = (await pay.json()) as { outcome?: string; error?: string };
        if (!pay.ok) throw new Error(d.error || "Could not record the payment failure");
        setRazorpayOpen(false);
        setHold(null); // released server-side — stop the countdown chip
        setPayFailure("Payment was declined by the gateway (demo). Your room hold was released instantly — the inventory is back for other guests. Retry below or switch to pay at hotel.");
      }
    } catch (e) {
      setFormError((e as Error).message);
      setRazorpayOpen(false);
    } finally {
      setRazorpayBusy(false);
    }
  }

  async function cancelGateway() {
    if (razorpayBusy) return;
    setRazorpayOpen(false);
    if (hold && hold.status === "active") {
      void fetch("/api/booking-engine/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ holdId: hold.holdId, outcome: "release" }),
      }).catch(() => {});
    }
    setHold(null);
  }

  async function retryAfterFailure() {
    // Fresh attempt: new idempotency key (the old hold was released), so the
    // server re-checks availability — if the room is gone we get a clean 409.
    idemKeyRef.current = "";
    setPayFailure(null);
    await createHoldAndOpenGateway();
  }

  async function submitBooking(mockPaid: boolean) {
    if (!selected) return;
    setBooking(true);
    setFormError(null);
    try {
      if (!idemKeyRef.current) idemKeyRef.current = `book-${crypto.randomUUID()}`;
      const r = await fetch("/api/booking-engine/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guest: {
            fullName: guest.fullName.trim(),
            phone: guest.phone.trim(),
            email: guest.email.trim(),
            idType: guest.idType,
            idNumber: guest.idNumber.trim(),
          },
          roomTypeId: selected.id,
          checkIn,
          checkOut,
          adults,
          children,
          promoCode: promo?.valid ? promo.code : undefined,
          mockPaid,
          idempotencyKey: idemKeyRef.current,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `Booking failed (${r.status})`);
      setConfirmed(d as BookResponse);
      setStep("confirmed");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBooking(false);
    }
  }

  function resetAll() {
    setStep("rooms");
    setSelected(null);
    setConfirmed(null);
    setPromo(null);
    setPromoInput("");
    setGuest({ fullName: "", phone: "", email: "", idType: "", idNumber: "" });
    setPayModeRaw("hotel");
    setHold(null);
    setPayFailure(null);
    idemKeyRef.current = "";
    setSearched(false);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const hotelName = confirmed ? config?.hotelName ?? "The Royal Grand Hotel" : config?.hotelName ?? "Loading…";
  const city = config?.city ?? "";

  const roomList = step === "rooms" ? availability?.roomTypes ?? [] : [];
  const showcase = config?.roomTypes ?? [];

  return (
    <div className="min-h-screen flex flex-col bg-plaster text-ink">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="bg-pine text-panel sticky top-0 z-40 border-b border-brass/30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="h-9 w-9 rounded-md bg-brass/15 border border-brass/40 grid place-items-center shrink-0" aria-hidden>
              <Sparkles className="h-4.5 w-4.5 text-brass-light" />
            </span>
            <div className="min-w-0 leading-tight">
              <p className="font-display font-semibold text-[15px] truncate">{hotelName}</p>
              <p className="text-[11px] text-panel/60 truncate">{city ? `${city} · ` : ""}Official booking site</p>
            </div>
          </div>
          <a
            href="#rooms"
            className="btn-brass h-9 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("rooms")?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            <CalendarDays className="h-4 w-4" /> Book Your Stay
          </a>
        </div>
      </header>

      <main className="flex-1">
        {step === "confirmed" && confirmed ? (
          /* ── Confirmation ──────────────────────────────────────────────── */
          <section className="max-w-2xl mx-auto px-4 sm:px-6 py-12 w-full" role="status">
            <div className="panel overflow-hidden">
              <div className="bg-pine text-panel px-6 py-8 text-center relative">
                <div className="absolute inset-0 opacity-[0.07] pointer-events-none" aria-hidden
                  style={{ backgroundImage: "radial-gradient(#d9b779 1px, transparent 1px)", backgroundSize: "18px 18px" }} />
                <span className="mx-auto mb-4 h-14 w-14 rounded-full bg-ok/20 border border-ok grid place-items-center relative">
                  <CheckCircle2 className="h-7 w-7 text-[#8fd3a3]" />
                </span>
                <h1 className="font-display text-2xl font-semibold">Your stay is confirmed</h1>
                <p className="text-panel/70 text-sm mt-1">A confirmation has been sent{confirmed.whatsappStatus === "sent" || confirmed.whatsappStatus === "delivered" ? " on WhatsApp" : ""}.</p>
                <div className="mt-5 inline-flex items-center gap-2 rounded-md border border-brass/50 bg-brass/10 px-4 py-2.5">
                  <span className="text-[11px] uppercase tracking-wider text-brass-light">Confirmation #</span>
                  <span className="font-mono font-semibold text-lg tracking-wide">{confirmed.confirmationNumber}</span>
                  <button
                    className="text-panel/60 hover:text-brass-light transition-colors"
                    onClick={() => {
                      navigator.clipboard?.writeText(confirmed.confirmationNumber).catch(() => {});
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1600);
                    }}
                    aria-label="Copy confirmation number"
                    title="Copy confirmation number"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="p-6 space-y-4">
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5">
                    <dt className="text-[10px] uppercase tracking-wider text-muted-ink">Guest</dt>
                    <dd className="font-medium text-pine mt-0.5">{guest.fullName}</dd>
                  </div>
                  <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5">
                    <dt className="text-[10px] uppercase tracking-wider text-muted-ink">Room</dt>
                    <dd className="font-medium text-pine mt-0.5">{selected?.name}</dd>
                  </div>
                  <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5">
                    <dt className="text-[10px] uppercase tracking-wider text-muted-ink">Stay</dt>
                    <dd className="font-medium text-pine mt-0.5">{fmtDay(checkIn)} → {fmtDay(checkOut)}</dd>
                  </div>
                  <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5">
                    <dt className="text-[10px] uppercase tracking-wider text-muted-ink">{confirmed.paid > 0 ? "Paid now" : "Due at hotel"}</dt>
                    <dd className={`font-display font-semibold mt-0.5 ${confirmed.paid > 0 ? "text-ok" : "text-brass"}`}>
                      {money2(confirmed.paid > 0 ? confirmed.paid : confirmed.total)}
                    </dd>
                  </div>
                </dl>
                <div className="flex items-start gap-2 rounded-md border border-pine-700/25 bg-pine-100/60 px-3 py-2.5 text-[13px] text-pine">
                  <MessageCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>
                    WhatsApp confirmation: <b className="capitalize">{confirmed.whatsappStatus}</b>
                    {confirmed.whatsappStatus === "mock" ? " (demo mode — no message was actually sent)" : ""}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button className="btn-pine flex-1 sm:flex-none" onClick={resetAll}>
                    <Search className="h-4 w-4" /> Book another stay
                  </button>
                  <a href="/" className="btn-outline flex-1 sm:flex-none">Hotel home</a>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
            {/* ── Hero + search ──────────────────────────────────────────── */}
            <section className="relative bg-pine text-panel overflow-hidden">
              <div className="absolute inset-0 opacity-[0.08] pointer-events-none" aria-hidden
                style={{ backgroundImage: "radial-gradient(#d9b779 1.2px, transparent 1.2px)", backgroundSize: "22px 22px" }} />
              <div className="absolute -top-24 -right-24 h-72 w-72 rounded-full bg-brass/10 blur-3xl pointer-events-none" aria-hidden />
              <div className="relative max-w-6xl mx-auto px-4 sm:px-6 pt-14 pb-24 sm:pt-20 sm:pb-28 text-center">
                <p className="text-brass-light text-[12px] uppercase tracking-[0.25em] font-medium">
                  {city || "India"} · Best-rate guarantee
                </p>
                <h1 className="font-display text-3xl sm:text-5xl font-semibold mt-3 leading-tight">
                  {hotelName}
                </h1>
                <p className="text-panel/70 text-sm sm:text-base mt-3 max-w-xl mx-auto">
                  Live availability, transparent pricing and instant confirmation — book direct and save.
                </p>
              </div>
            </section>

            {/* Search card — overlaps hero */}
            <section className="max-w-4xl mx-auto px-4 sm:px-6 -mt-14 relative z-10 w-full" aria-label="Search availability">
              <div className="panel p-4 sm:p-5 border-line-strong">
                <div className="grid grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto] gap-3 items-end">
                  <div>
                    <label className="field-label" htmlFor="bk-in">Check-in</label>
                    <input id="bk-in" type="date" className="field" value={checkIn} min={today}
                      onChange={(e) => {
                        const v = e.target.value;
                        setCheckIn(v);
                        if (v && checkOut <= v) setCheckOut(addDaysISO(v, 1));
                      }} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="bk-out">Check-out</label>
                    <input id="bk-out" type="date" className="field" value={checkOut} min={addDaysISO(checkIn, 1)}
                      onChange={(e) => setCheckOut(e.target.value)} />
                  </div>
                  <div>
                    <label className="field-label" htmlFor="bk-adults">Adults</label>
                    <select id="bk-adults" className="field" value={adults} onChange={(e) => setAdults(Number(e.target.value))}>
                      {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="field-label" htmlFor="bk-children">Children</label>
                    <select id="bk-children" className="field" value={children} onChange={(e) => setChildren(Number(e.target.value))}>
                      {[0, 1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <button className="btn-pine h-9 col-span-2 lg:col-span-1" onClick={runSearch} disabled={availLoading || dateInvalid}>
                    {availLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                    Check Availability
                  </button>
                </div>
                <p className={`text-[12px] mt-2 flex items-center gap-1.5 ${dateInvalid ? "text-danger" : "text-muted-ink"}`} aria-live="polite">
                  <Info className="h-3.5 w-3.5 shrink-0" />
                  {dateInvalid
                    ? "Stays can be 1–31 nights — adjust your dates."
                    : `${nights} night${nights === 1 ? "" : "s"} · ${adults} adult${adults === 1 ? "" : "s"}${children > 0 ? ` · ${children} child${children === 1 ? "" : "ren"}` : ""} · taxes included at checkout`}
                </p>
              </div>
            </section>

            {/* ── Guest details + pay (selected room) ────────────────────── */}
            {step === "guest" && selected && (
              <section ref={guestRef} className="max-w-6xl mx-auto px-4 sm:px-6 py-10 w-full scroll-mt-20" aria-label="Guest details">
                <button className="btn-ghost mb-4" onClick={() => { setStep("rooms"); setSelected(null); }}>
                  <ArrowLeft className="h-4 w-4" /> Back to rooms
                </button>
                <div className="grid lg:grid-cols-[1fr_380px] gap-5 items-start">
                  {/* Form */}
                  <div className="panel">
                    <div className="panel-header">
                      <h2 className="panel-title">Guest details</h2>
                      <span className="badge border-ok/40 bg-ok/10 text-ok text-[10px]"><ShieldCheck className="h-3 w-3" /> Secure</span>
                    </div>
                    <div className="p-4 sm:p-5 space-y-4">
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div className="sm:col-span-2">
                          <label className="field-label" htmlFor="g-name">Full name (lead guest) *</label>
                          <input id="g-name" className="field" placeholder="e.g. Ananya Sharma" value={guest.fullName}
                            onChange={(e) => setGuest({ ...guest, fullName: e.target.value })} autoComplete="name" />
                        </div>
                        <div>
                          <label className="field-label" htmlFor="g-phone">Mobile number *</label>
                          <input id="g-phone" className="field" placeholder="+91 98765 43210" inputMode="tel" value={guest.phone}
                            onChange={(e) => setGuest({ ...guest, phone: e.target.value })} autoComplete="tel" />
                        </div>
                        <div>
                          <label className="field-label" htmlFor="g-email">Email</label>
                          <input id="g-email" className="field" placeholder="you@example.com" inputMode="email" value={guest.email}
                            onChange={(e) => setGuest({ ...guest, email: e.target.value })} autoComplete="email" />
                        </div>
                        <div>
                          <label className="field-label" htmlFor="g-idtype">ID type</label>
                          <select id="g-idtype" className="field" value={guest.idType} onChange={(e) => setGuest({ ...guest, idType: e.target.value })}>
                            <option value="">Select (optional)</option>
                            <option value="aadhaar">Aadhaar</option>
                            <option value="passport">Passport</option>
                            <option value="driving_license">Driving licence</option>
                            <option value="voter_id">Voter ID</option>
                            <option value="pan">PAN card</option>
                          </select>
                        </div>
                        <div>
                          <label className="field-label" htmlFor="g-idnum">ID number</label>
                          <input id="g-idnum" className="field" placeholder="Optional — needed at check-in" value={guest.idNumber}
                            onChange={(e) => setGuest({ ...guest, idNumber: e.target.value })} />
                        </div>
                      </div>

                      <fieldset>
                        <legend className="field-label">Payment</legend>
                        <div className="grid sm:grid-cols-2 gap-2.5">
                          <button
                            type="button"
                            role="radio"
                            aria-checked={payMode === "hotel"}
                            onClick={() => setPayMode("hotel")}
                            className={`rounded-md border px-3.5 py-3 text-left transition-all ${payMode === "hotel" ? "border-brass ring-1 ring-brass/40 bg-brass-50/50" : "border-line hover:border-line-strong bg-panel"}`}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium text-pine">
                              <Landmark className="h-4 w-4 text-brass" /> Pay at hotel
                            </span>
                            <span className="block text-[11.5px] text-muted-ink mt-1">Reserve now, settle the bill at the front desk.</span>
                          </button>
                          <button
                            type="button"
                            role="radio"
                            aria-checked={payMode === "now"}
                            onClick={() => setPayMode("now")}
                            className={`rounded-md border px-3.5 py-3 text-left transition-all ${payMode === "now" ? "border-brass ring-1 ring-brass/40 bg-brass-50/50" : "border-line hover:border-line-strong bg-panel"}`}
                          >
                            <span className="flex items-center gap-2 text-sm font-medium text-pine">
                              <Wallet className="h-4 w-4 text-brass" /> Pay now
                            </span>
                            <span className="block text-[11.5px] text-muted-ink mt-1">UPI, cards &amp; netbanking — instant confirmation.</span>
                          </button>
                        </div>
                      </fieldset>

                      {/* Race-guard: live 10-minute hold countdown (pay-now) */}
                      {payMode === "now" && hold && hold.status === "active" && (
                        <div
                          className="flex items-center gap-2.5 rounded-md border border-ok/35 bg-ok/10 px-3 py-2.5"
                          role="status"
                          aria-live="polite"
                        >
                          <Timer className={`h-4 w-4 shrink-0 text-ok ${secondsLeft <= 120 ? "animate-pulse text-warn" : ""}`} />
                          <div className="min-w-0 flex-1 leading-tight">
                            <p className="text-[12.5px] font-medium text-pine">
                              Room held for you · {mmss(secondsLeft)}
                            </p>
                            <p className="text-[11px] text-muted-ink">
                              Nobody else can book it while you pay — released automatically if the payment fails.
                            </p>
                          </div>
                          <span className="badge border-ok/40 bg-panel text-ok text-[10px] shrink-0 tabular-nums">
                            {money2(hold.grandTotal)} locked
                          </span>
                        </div>
                      )}

                      {/* Payment failure recovery (guard demo) */}
                      {payFailure && (
                        <div
                          className="rounded-md border border-warn/45 bg-warn/10 px-3.5 py-3"
                          role="alert"
                        >
                          <p className="flex items-start gap-2 text-[13px] text-ink">
                            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-warn" />
                            {payFailure}
                          </p>
                          <div className="mt-2.5 flex flex-wrap gap-2">
                            <button className="btn-pine h-8 text-[12px]" onClick={retryAfterFailure} disabled={holdBusy}>
                              {holdBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                              Retry payment
                            </button>
                            <button className="btn-outline h-8 text-[12px]" onClick={() => { setPayFailure(null); setPayMode("hotel"); }}>
                              <Landmark className="h-3.5 w-3.5" /> Pay at hotel instead
                            </button>
                          </div>
                        </div>
                      )}

                      {formError && (
                        <div className="flex items-start gap-2 rounded-md border border-danger/35 bg-danger/10 px-3 py-2.5 text-[13px] text-danger" role="alert">
                          <XCircle className="h-4 w-4 mt-0.5 shrink-0" /> {formError}
                        </div>
                      )}

                      <button className="btn-pine w-full h-10 text-[15px]" onClick={confirmBooking} disabled={booking || holdBusy}>
                        {booking || holdBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                        {payMode === "now"
                          ? holdBusy
                            ? "Holding your room…"
                            : `Pay ${money2(grandTotal)} & Confirm`
                          : "Confirm Booking"}
                      </button>
                      <p className="text-[11px] text-muted-ink text-center">
                        Free cancellation until 24 hours before check-in · No hidden fees
                      </p>
                    </div>
                  </div>

                  {/* Summary */}
                  <aside className="panel lg:sticky lg:top-20" aria-label="Booking summary">
                    <div className="panel-header">
                      <h2 className="panel-title">Your stay</h2>
                      <span className="badge border-line-strong bg-plaster text-muted-ink text-[10px]">{nights} night{nights === 1 ? "" : "s"}</span>
                    </div>
                    <div className="p-4 sm:p-5 space-y-3.5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="font-display font-semibold text-pine">{selected.name}</p>
                          <p className="text-[12px] text-muted-ink mt-0.5">{selected.bedType} · up to {selected.maxOccupancy} guests</p>
                        </div>
                        <span className="badge border-pine-700/30 bg-pine-100 text-pine-700 text-[10px] shrink-0">{selected.code}</span>
                      </div>
                      <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5 text-[13px] space-y-1">
                        <p className="flex items-center gap-2 text-ink"><CalendarDays className="h-3.5 w-3.5 text-brass" /> {fmtDay(checkIn)} → {fmtDay(checkOut)}</p>
                        <p className="flex items-center gap-2 text-ink"><Users className="h-3.5 w-3.5 text-brass" /> {adults} adult{adults === 1 ? "" : "s"}{children > 0 ? `, ${children} child${children === 1 ? "" : "ren"}` : ""}</p>
                      </div>

                      {/* Promo */}
                      <div>
                        <label className="field-label" htmlFor="bk-promo">Promo code</label>
                        <div className="flex gap-1.5">
                          <div className="relative flex-1">
                            <Tag className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" aria-hidden />
                            <input
                              id="bk-promo" className="field pl-8 uppercase" placeholder="e.g. EARLY15"
                              value={promoInput} onChange={(e) => { setPromoInput(e.target.value.toUpperCase()); setPromo(null); }}
                              onKeyDown={(e) => e.key === "Enter" && applyPromo()} disabled={Boolean(promo?.valid)}
                            />
                          </div>
                          {promo?.valid ? (
                            <button className="btn-ghost h-9" onClick={() => { setPromo(null); setPromoInput(""); }} title="Remove promo">
                              Remove
                            </button>
                          ) : (
                            <button className="btn-outline h-9" onClick={applyPromo} disabled={promoChecking || !promoInput.trim()}>
                              {promoChecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Apply"}
                            </button>
                          )}
                        </div>
                        {promo && (
                          <p className={`text-[12px] mt-1.5 flex items-center gap-1.5 ${promo.valid ? "text-ok" : "text-danger"}`} aria-live="polite">
                            {promo.valid ? <Check className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                            {promo.valid ? `${promo.code} applied — ${promo.description ?? "discount"} (−${money2(promo.discount ?? 0)})` : promo.message}
                          </p>
                        )}
                      </div>

                      {/* Price breakdown */}
                      <div className="border-t border-line pt-3 space-y-1.5 text-[13px]">
                        <div className="flex justify-between text-muted-ink">
                          <span>{money(selected.avgRate)} × {nights} night{nights === 1 ? "" : "s"}</span>
                          <span className="tabular-nums">{money2(selected.total)}</span>
                        </div>
                        {discount > 0 && (
                          <div className="flex justify-between text-ok">
                            <span>Promo {promo?.code}</span>
                            <span className="tabular-nums">−{money2(discount)}</span>
                          </div>
                        )}
                        <div className="flex justify-between text-muted-ink">
                          <span>GST ({selected.taxes.gst}%)</span>
                          <span className="tabular-nums">{money2(taxAmount)}</span>
                        </div>
                        <div className="flex justify-between border-t border-line pt-2 font-display font-semibold text-pine text-[15px]">
                          <span>Total</span>
                          <span className="tabular-nums">{money2(grandTotal)}</span>
                        </div>
                        {discount > 0 && (
                          <p className="text-[11px] text-ok">You save {money2(discount)} booking direct</p>
                        )}
                      </div>
                    </div>
                  </aside>
                </div>
              </section>
            )}

            {/* ── Room results ───────────────────────────────────────────── */}
            {step === "rooms" && (
              <section id="rooms" className="max-w-6xl mx-auto px-4 sm:px-6 py-10 w-full scroll-mt-20">
                <div className="flex items-end justify-between gap-3 flex-wrap">
                  <div>
                    <h2 className="section-title">Choose your room</h2>
                    <p className="text-[13px] text-muted-ink mt-1">
                      {searched && availability
                        ? `${availability.nights} night${availability.nights === 1 ? "" : "s"} · ${fmtDay(checkIn)} → ${fmtDay(checkOut)} · live availability`
                        : "Enter your dates to see live availability and rates"}
                    </p>
                  </div>
                  {availability && (
                    <span className="badge border-ok/40 bg-ok/10 text-ok text-[11px]">
                      <span className="h-1.5 w-1.5 rounded-full bg-ok animate-pulse" aria-hidden /> Live rates
                    </span>
                  )}
                </div>

                {availError && (
                  <div className="mt-4 flex items-start gap-2 rounded-md border border-danger/35 bg-danger/10 px-4 py-3 text-[13px] text-danger" role="alert">
                    <XCircle className="h-4 w-4 mt-0.5 shrink-0" /> {availError}
                  </div>
                )}

                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  {/* Loading skeletons */}
                  {availLoading && [...Array(4)].map((_, i) => (
                    <div key={i} className="panel p-4">
                      <div className="skeleton h-5 w-40 rounded" />
                      <div className="skeleton h-3 w-full rounded mt-3" />
                      <div className="skeleton h-3 w-2/3 rounded mt-2" />
                      <div className="skeleton h-8 w-28 rounded mt-4" />
                    </div>
                  ))}

                  {/* Quoted cards after search */}
                  {!availLoading && roomList.map((rt) => {
                    const soldOut = rt.available <= 0;
                    const scarce = !soldOut && rt.available <= 2;
                    return (
                      <article key={rt.id} className={`panel p-4 sm:p-5 flex flex-col ${soldOut ? "opacity-75" : ""}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h3 className="font-display text-lg font-semibold text-pine leading-snug">{rt.name}</h3>
                            <p className="text-[11px] uppercase tracking-wider text-muted-ink mt-0.5">{rt.code} · {rt.bedType}</p>
                          </div>
                          {soldOut ? (
                            <span className="badge border-danger/35 bg-danger/10 text-danger text-[10px] shrink-0">Sold out</span>
                          ) : scarce ? (
                            <span className="badge border-warn/40 bg-warn/10 text-warn text-[10px] shrink-0 animate-pulse">Only {rt.available} left</span>
                          ) : (
                            <span className="badge border-ok/40 bg-ok/10 text-ok text-[10px] shrink-0">{rt.available} available</span>
                          )}
                        </div>

                        <p className="text-[13px] text-muted-ink mt-2.5 leading-relaxed line-clamp-2">{rt.description}</p>

                        <div className="flex flex-wrap gap-1.5 mt-3">
                          <span className="badge border-line-strong bg-plaster text-ink text-[10.5px]"><Users className="h-3 w-3 text-brass" /> {rt.maxOccupancy} guests</span>
                          {rt.sizeSqft > 0 && <span className="badge border-line-strong bg-plaster text-ink text-[10.5px]"><Maximize className="h-3 w-3 text-brass" /> {rt.sizeSqft} sq.ft</span>}
                          {rt.amenities.slice(0, 3).map((a) => (
                            <span key={a} className="badge border-line-strong bg-plaster text-ink text-[10.5px]"><Check className="h-3 w-3 text-ok" /> {a}</span>
                          ))}
                          {rt.amenities.length > 3 && (
                            <span className="badge border-brass/40 bg-brass-50 text-brass text-[10.5px]">+{rt.amenities.length - 3} more</span>
                          )}
                        </div>

                        {/* Nightly rates */}
                        <details className="mt-3 group">
                          <summary className="text-[12px] text-pine-700 cursor-pointer select-none flex items-center gap-1 hover:underline">
                            Nightly rates <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                          </summary>
                          <div className="mt-2 rounded-md border border-line bg-plaster/40 px-3 py-2 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[12px] max-h-32 overflow-y-auto scroll-slim">
                            {rt.nightlyRates.map((n) => (
                              <div key={n.date} className="flex justify-between gap-2">
                                <span className="text-muted-ink">{new Date(n.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                                <span className="tabular-nums text-ink">{money(n.rate)}</span>
                              </div>
                            ))}
                          </div>
                        </details>

                        {/* Price + CTA */}
                        <div className="mt-auto pt-4 border-t border-line mt-4 flex items-end justify-between gap-3 flex-wrap">
                          <div>
                            {rt.avgRate < rt.baseRate && (
                              <p className="text-[11px] text-muted-ink"><span className="line-through">{money(rt.baseRate)}</span> deal</p>
                            )}
                            <p className="font-display text-xl font-semibold text-pine leading-none">
                              {money(rt.avgRate)} <span className="text-[12px] font-sans font-normal text-muted-ink">/ night avg</span>
                            </p>
                            <p className="text-[12px] text-muted-ink mt-1">
                              {money2(rt.grandTotal)} incl. {rt.taxes.gst}% GST{nights > 0 ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}
                            </p>
                          </div>
                          <button
                            className="btn-brass h-10 px-6"
                            onClick={() => pickRoom(rt)}
                            disabled={soldOut}
                          >
                            {soldOut ? "Unavailable" : "Reserve"}
                          </button>
                        </div>
                      </article>
                    );
                  })}

                  {/* Pre-search showcase */}
                  {!searched && !availLoading && showcase.map((rt) => (
                    <article key={rt.id} className="panel p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-display text-lg font-semibold text-pine">{rt.name}</h3>
                          <p className="text-[11px] uppercase tracking-wider text-muted-ink mt-0.5">{rt.code} · {rt.bedType}</p>
                        </div>
                        <span className="font-display text-lg font-semibold text-brass whitespace-nowrap">from {money(rt.baseRate)}</span>
                      </div>
                      <p className="text-[13px] text-muted-ink mt-2.5 leading-relaxed line-clamp-2">{rt.description}</p>
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        <span className="badge border-line-strong bg-plaster text-ink text-[10.5px]"><Users className="h-3 w-3 text-brass" /> {rt.maxOccupancy} guests</span>
                        {rt.amenities.slice(0, 2).map((a) => (
                          <span key={a} className="badge border-line-strong bg-plaster text-ink text-[10.5px]"><Check className="h-3 w-3 text-ok" /> {a}</span>
                        ))}
                      </div>
                      <p className="text-[12px] text-muted-ink mt-3 flex items-center gap-1.5">
                        <CalendarDays className="h-3.5 w-3.5 text-brass" /> Pick your dates above to see live availability
                      </p>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {/* ── Trust strip ────────────────────────────────────────────── */}
            {step === "rooms" && (
              <section className="border-t border-line bg-panel/60">
                <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 grid sm:grid-cols-3 gap-5 text-center sm:text-left">
                  {[
                    { icon: Tag, title: "Best-rate guarantee", text: "Booking direct always beats aggregator prices — promos included." },
                    { icon: ShieldCheck, title: "Secure & official", text: "This is the hotel's own booking site, powered by Velurex HMS." },
                    { icon: MessageCircle, title: "Instant confirmation", text: "Your booking reference arrives on WhatsApp the moment you book." },
                  ].map((f) => (
                    <div key={f.title} className="flex flex-col items-center sm:flex-row gap-3">
                      <span className="h-10 w-10 rounded-md border border-brass/40 bg-brass-50 grid place-items-center shrink-0" aria-hidden>
                        <f.icon className="h-5 w-5 text-brass" />
                      </span>
                      <div>
                        <p className="font-display font-semibold text-pine text-[15px]">{f.title}</p>
                        <p className="text-[12.5px] text-muted-ink mt-0.5 leading-relaxed">{f.text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </main>

      {/* ── Footer (sticky bottom) ───────────────────────────────────────── */}
      <footer className="mt-auto bg-pine text-panel/70 border-t border-brass/30">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12.5px]">
          <p className="flex items-center gap-2">
            <Star className="h-3.5 w-3.5 text-brass" aria-hidden />
            <span className="font-display text-panel">{hotelName}</span>
            {city ? <span>· {city}</span> : null}
          </p>
          <p>© {new Date().getFullYear()} {hotelName} · Powered by <span className="text-brass-light font-medium">Velurex HMS</span></p>
        </div>
      </footer>

      {/* ── Razorpay-shaped demo checkout (hold-aware) ───────────────────── */}
      {razorpayOpen && selected && hold && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-pine/70 p-4" role="dialog" aria-modal="true" aria-label="Payment">
          <div className="panel w-full max-w-sm overflow-hidden expand-in">
            <div className="px-5 py-4 bg-[#0b3d8f] text-white flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wider opacity-80">Razorpay · Demo</p>
                <p className="font-display text-lg font-semibold">{money2(hold.grandTotal)}</p>
              </div>
              <BedDouble className="h-6 w-6 opacity-60" aria-hidden />
            </div>
            <div className="p-5 space-y-3">
              <div className="rounded-md border border-line bg-plaster/50 px-3 py-2.5 text-[12.5px] space-y-1">
                <p className="flex justify-between"><span className="text-muted-ink">Paying to</span><b className="text-pine">{hotelName}</b></p>
                <p className="flex justify-between"><span className="text-muted-ink">Order</span><span className="font-mono">{hold.holdId.slice(-6).toUpperCase()}</span></p>
                <p className="flex justify-between">
                  <span className="text-muted-ink">Room held</span>
                  <span className={`tabular-nums ${secondsLeft <= 120 ? "text-warn" : ""}`}>{mmss(secondsLeft)} remaining</span>
                </p>
                <p className="flex justify-between"><span className="text-muted-ink">Method</span><span>UPI / Card / Netbanking</span></p>
              </div>
              <p className="text-[11.5px] text-muted-ink">
                Demo checkout — no real charge is made. The room is locked under hold{" "}
                <span className="font-mono">{hold.holdId.slice(-6).toUpperCase()}</span>; a decline releases it instantly and
                it's sellable again for other guests.
              </p>
              <button className="btn-pine w-full h-10" onClick={() => settlePayment("success")} disabled={razorpayBusy || secondsLeft <= 0}>
                {razorpayBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                {razorpayBusy ? "Authorising…" : `Pay ${money2(hold.grandTotal)}`}
              </button>
              <button
                className="btn-ghost w-full text-danger hover:bg-danger/10"
                onClick={() => settlePayment("failure")}
                disabled={razorpayBusy}
                title="Demo: pretend the gateway declined the card — watch the hold release and the room return to availability"
              >
                <XCircle className="h-4 w-4" /> Simulate payment failure
              </button>
              <button className="btn-ghost w-full" onClick={cancelGateway} disabled={razorpayBusy}>
                Cancel payment
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
