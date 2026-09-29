"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDateShort, fmtDate } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useRealtime } from "@/lib/realtime";
import {
  BedDouble, IndianRupee, TrendingUp, Wallet, LogIn, LogOut, ArrowUpRight, ArrowDownRight,
  Loader2, CalendarClock, Plus, Printer, MoonStar, ReceiptIndianRupee, Sparkles, DoorOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ViewKey } from "@/lib/store";

interface DashboardData {
  businessDate: string;
  kpis: { occupancy: number; occupancyDelta: number; adr: number; adrDelta: number; revpar: number; revparDelta: number; revenueToday: number; revenueDelta: number; outstanding: number };
  revenueBreakdown: { room: number; fnb: number; misc: number };
  roomStatus: { floor: number; rooms: { id: string; number: string; status: string; note: string; type: string; guest: string | null }[] }[];
  checkIns: { id: string; confirmationNumber: string; guestName: string; roomNumber: string; checkIn: string; status: string; paidAmount: number; totalAmount: number }[];
  checkOuts: { id: string; confirmationNumber: string; guestName: string; roomNumber: string; checkOut: string; status: string; balance: number }[];
  recentReservations: { id: string; confirmationNumber: string; guestName: string; roomNumber: string; checkIn: string; checkOut: string; status: string; totalAmount: number; source: string }[];
  counts: { totalRooms: number; occupied: number; vacant: number; dirty: number; outOfOrder: number; inHouse: number; arrivals: number; departures: number };
}

const STATUS_DOT: Record<string, string> = {
  vacant: "bg-ok", occupied: "bg-pine-700", dirty: "bg-warn", clean: "bg-[#7ea08c]", out_of_order: "bg-danger",
};
const STATUS_BADGE: Record<string, string> = {
  confirmed: "border-pine-700/30 bg-pine-100 text-pine-700",
  checked_in: "border-ok/40 bg-ok/10 text-ok",
  checked_out: "border-line-strong bg-plaster text-muted-ink",
  cancelled: "border-danger/30 bg-danger/10 text-danger",
  no_show: "border-danger/40 bg-danger/15 text-danger",
  hold: "border-warn/40 bg-warn/10 text-warn",
};

export default function DashboardView() {
  const user = useSession((s) => s.user);
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(await api<DashboardData>("/api/dashboard"));
    } catch {
      /* offline: keep stale */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  // Live nudge: folio charge / POS post-to-folio / payment refreshes money stats instantly
  useRealtime((event) => {
    if (event === "folio:update") load();
  });

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <div key={i} className="panel p-5"><div className="skeleton h-16 rounded" /></div>)}
        </div>
        <div className="grid lg:grid-cols-2 gap-4"><div className="panel p-5"><div className="skeleton h-64 rounded" /></div><div className="panel p-5"><div className="skeleton h-64 rounded" /></div></div>
      </div>
    );
  }
  if (!data) return <div className="panel p-6 text-sm text-danger">Could not load dashboard. Check your connection.</div>;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good Morning" : hour < 17 ? "Good Afternoon" : "Good Evening";

  const navigate = (view: ViewKey, dialog?: string) => {
    window.dispatchEvent(new CustomEvent("velurex:navigate", { detail: view }));
    if (dialog) setTimeout(() => window.dispatchEvent(new CustomEvent("velurex:open-dialog", { detail: dialog })), 350);
  };

  const printDaySheet = () => {
    const w = window.open("", "_blank", "width=920,height=700");
    if (!w || !data) return;
    const row = (cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const arrivals = data.checkIns.map((c) => row([c.guestName, c.roomNumber, fmtDate(c.checkIn), c.status.replace("_", " "), inr(c.totalAmount)])).join("");
    const departures = data.checkOuts.map((c) => row([c.guestName, c.roomNumber, fmtDate(c.checkOut), inr(c.balance)])).join("");
    const inhouse = data.roomStatus.flatMap((f) => f.rooms.filter((r) => r.guest).map((r) => row([r.number, r.type, r.guest ?? "", r.status]))).join("");
    w.document.write(`<!doctype html><html><head><title>Day Sheet — ${fmtDate(new Date())}</title><style>
      body{font-family:Georgia,serif;color:#1F2A26;padding:28px;max-width:860px;margin:auto}
      h1{font-size:22px;margin:0;color:#0F2622} h2{font-size:15px;border-bottom:2px solid #B9873E;padding-bottom:4px;margin:22px 0 8px}
      .meta{color:#7A6F5D;font-size:12px;margin-top:2px}
      table{width:100%;border-collapse:collapse;font-size:12px;font-family:Helvetica,Arial,sans-serif}
      th{text-align:left;background:#EFE6D8;padding:6px 8px;border-bottom:1px solid #D3C3A4;text-transform:uppercase;font-size:10px;letter-spacing:.05em;color:#7A6F5D}
      td{padding:6px 8px;border-bottom:1px solid #E3D7C1}
      .stats{display:flex;gap:14px;font-family:Helvetica,Arial,sans-serif;font-size:12px;margin-top:10px}
      .stats div{border:1px solid #D3C3A4;border-radius:6px;padding:8px 12px;background:#FBF8F2}
      .stats b{display:block;font-size:17px;color:#1F4B43;font-family:Georgia,serif}
      @media print{body{padding:0}}
    </style></head><body>
      <h1>${user?.propertyName ?? "The Royal Grand Hotel"} — Daily Day Sheet</h1>
      <p class="meta">Business date: ${fmtDate(new Date())} · Printed ${new Date().toLocaleString("en-IN")} by ${user?.name ?? ""}</p>
      <div class="stats">
        <div><b>${data.counts.arrivals}</b>Arrivals</div><div><b>${data.counts.departures}</b>Departures</div>
        <div><b>${data.counts.inHouse}</b>In-house</div><div><b>${data.kpis.occupancy}%</b>Occupancy</div>
        <div><b>${inr(data.kpis.revenueToday)}</b>Revenue today</div><div><b>${inr(data.kpis.outstanding)}</b>Outstanding</div>
      </div>
      <h2>Expected Arrivals (${data.checkIns.length})</h2>
      <table><tr><th>Guest</th><th>Room</th><th>Check-in</th><th>Status</th><th>Total</th></tr>${arrivals || "<tr><td colspan=5>No arrivals today</td></tr>"}</table>
      <h2>Expected Departures (${data.checkOuts.length})</h2>
      <table><tr><th>Guest</th><th>Room</th><th>Check-out</th><th>Balance due</th></tr>${departures || "<tr><td colspan=4>No departures today</td></tr>"}</table>
      <h2>In-house Guests (${data.counts.inHouse})</h2>
      <table><tr><th>Room</th><th>Type</th><th>Guest</th><th>Status</th></tr>${inhouse || "<tr><td colspan=4>—</td></tr>"}</table>
      <p class="meta" style="margin-top:26px">Velurex HMS · Computer-generated day sheet</p>
      <script>window.onload=()=>window.print()</script>
    </body></html>`);
    w.document.close();
  };

  return (
    <div className="space-y-4">
      {/* Greeting + quick actions */}
      <div className="panel px-5 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-pine">{greeting}, {user?.name.split(" ")[0]}</h2>
          <p className="text-sm text-muted-ink">Here&apos;s what&apos;s happening at your property today.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-pine h-9" onClick={() => navigate("reservations", "new-reservation")}>
            <Plus className="h-4 w-4" /> New Reservation
          </button>
          <button className="btn-outline h-9" onClick={() => navigate("pos")}>
            <ReceiptIndianRupee className="h-4 w-4" /> Open POS
          </button>
          <button className="btn-outline h-9" onClick={() => navigate("night-audit")}>
            <MoonStar className="h-4 w-4" /> Night Audit
          </button>
          <button className="btn-outline h-9" onClick={printDaySheet} title="Print arrivals, departures & in-house list">
            <Printer className="h-4 w-4" /> Day Sheet
          </button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard icon={BedDouble} label="Occupancy Rate" value={`${data.kpis.occupancy}%`} delta={data.kpis.occupancyDelta} deltaSuffix="% vs. last week" positiveWhenUp />
        <KpiCard icon={IndianRupee} label="ADR (Avg Daily Rate)" value={inr(data.kpis.adr)} delta={data.kpis.adrDelta} deltaSuffix="% vs. last week" positiveWhenUp prefix="₹" />
        <KpiCard icon={TrendingUp} label="RevPAR" value={inr(data.kpis.revpar)} delta={data.kpis.revparDelta} deltaSuffix="% vs. last week" positiveWhenUp prefix="₹" />
        <KpiCard icon={Wallet} label="Total Revenue (Today)" value={inr(data.kpis.revenueToday)} delta={data.kpis.revenueDelta} deltaSuffix="% vs. yesterday" positiveWhenUp prefix="₹" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Room status — grouped by floor */}
        <div className="panel lg:col-span-2">
          <div className="panel-header">
            <div className="flex items-center gap-3">
              <p className="panel-title">Room Status</p>
              <span className="text-xs text-muted-ink">All floors · {data.counts.totalRooms} rooms</span>
            </div>
            <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-ink">
              <Legend color="#4C7A5A" label="Vacant" />
              <Legend color="#1F4B43" label="Occupied" />
              <Legend color="#C08A2E" label="Dirty" />
              <Legend color="#A44534" label="O.O.O." />
            </div>
          </div>
          <div className="p-4 space-y-4">
            {data.roomStatus.map((f) => (
              <div key={f.floor} className="flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="sm:w-24 shrink-0">
                  <p className="font-display font-semibold text-pine">Floor {f.floor}</p>
                  <p className="text-[11px] text-muted-ink">Rooms {f.rooms[0]?.number} – {f.rooms[f.rooms.length - 1]?.number}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {f.rooms.map((r) => (
                    <div
                      key={r.id}
                      title={`${r.type} · ${r.status.replace("_", " ")}${r.guest ? ` · ${r.guest}` : ""}${r.note ? ` · ${r.note}` : ""}`}
                      className={cn(
                        "h-11 w-12 rounded-md flex flex-col items-center justify-center text-[12px] font-semibold cursor-default transition hover:scale-105",
                        `tile-${r.status}`
                      )}
                    >
                      {r.number}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-line px-4 py-2.5 flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-muted-ink">
            <span>In-house: <b className="text-pine">{data.counts.inHouse}</b></span>
            <span>Arrivals today: <b className="text-pine">{data.counts.arrivals}</b></span>
            <span>Departures today: <b className="text-pine">{data.counts.departures}</b></span>
            <span>Dirty: <b className="text-warn">{data.counts.dirty}</b></span>
            <span>Out of order: <b className="text-danger">{data.counts.outOfOrder}</b></span>
            <span>Outstanding: <b className="text-brass">{inr(data.kpis.outstanding)}</b></span>
          </div>
        </div>

        {/* Right column: revenue mix + check-ins/outs */}
        <div className="space-y-4">
          <div className="panel">
            <div className="panel-header"><p className="panel-title">Revenue Mix — Today</p></div>
            <div className="p-4 space-y-3">
              <RevBar label="Rooms" value={data.revenueBreakdown.room} total={data.kpis.revenueToday || 1} color="#1F4B43" />
              <RevBar label="F&B" value={data.revenueBreakdown.fnb} total={data.kpis.revenueToday || 1} color="#B9873E" />
              <RevBar label="Misc / Laundry" value={data.revenueBreakdown.misc} total={data.kpis.revenueToday || 1} color="#4C7A5A" />
              <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
                <span className="text-muted-ink">Outstanding folio balances</span>
                <span className="font-semibold text-brass">{inr(data.kpis.outstanding)}</span>
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Today&apos;s Check-ins / Check-outs</p>
              <CalendarClock className="h-4 w-4 text-brass" />
            </div>
            <div className="divide-y divide-line/70 max-h-56 overflow-y-auto scroll-slim">
              {data.checkIns.map((c) => (
                <Row key={c.id} icon={<LogIn className="h-3.5 w-3.5 text-ok" />} name={c.guestName} room={c.roomNumber} meta={`Check-in ${fmtDateShort(c.checkIn)} · ${c.status.replace("_", " ")}`} />
              ))}
              {data.checkOuts.map((c) => (
                <Row key={c.id} icon={<LogOut className="h-3.5 w-3.5 text-warn" />} name={c.guestName} room={c.roomNumber} meta={`Check-out · balance ${inr(c.balance)}`} />
              ))}
              {data.checkIns.length === 0 && data.checkOuts.length === 0 && (
                <div className="px-4 py-6 text-sm text-muted-ink text-center">No arrivals or departures today</div>
              )}
            </div>
          </div>

          {/* Direct-booking promo banner (uses generated brand image) */}
          <div className="panel overflow-hidden">
            <div className="relative h-36 bg-pine">
              <div className="absolute inset-0 bg-cover bg-center opacity-80" style={{ backgroundImage: "url(/images/room-promo.jpg)" }} />
              <div className="absolute inset-0 bg-gradient-to-r from-pine/85 via-pine/50 to-transparent" />
              <div className="relative h-full flex flex-col justify-end p-4">
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-brass-light flex items-center gap-1.5">
                  <Sparkles className="h-3 w-3" /> Direct booking offer
                </p>
                <p className="font-display text-lg font-semibold text-panel leading-snug mt-0.5">Monsoon Package — save 15%</p>
                <p className="text-[11px] text-panel/70">Breakfast + dinner included · Use code <span className="font-mono font-semibold text-brass-light">MONSOON500</span></p>
              </div>
            </div>
            <div className="px-4 py-2.5 flex items-center justify-between border-t border-line">
              <span className="text-[11px] text-muted-ink flex items-center gap-1.5"><DoorOpen className="h-3.5 w-3.5 text-brass" /> Synced with the public booking engine</span>
              <button className="text-xs font-medium text-pine-700 hover:text-brass transition" onClick={() => navigate("booking-engine")}>View →</button>
            </div>
          </div>
        </div>
      </div>

      {/* Recent reservations */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Recent Reservations</p>
          <span className="text-xs text-muted-ink">{data.recentReservations.length} latest</span>
        </div>
        <div className="overflow-x-auto scroll-slim">
          <table className="w-full min-w-[640px]">
            <thead>
              <tr>
                <th className="th">Guest</th>
                <th className="th">Room</th>
                <th className="th">Check-in</th>
                <th className="th">Check-out</th>
                <th className="th">Source</th>
                <th className="th">Amount</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentReservations.map((r) => (
                <tr key={r.id} className="hover:bg-plaster/50">
                  <td className="td font-medium text-pine">{r.guestName}</td>
                  <td className="td">{r.roomNumber}</td>
                  <td className="td">{fmtDate(r.checkIn)}</td>
                  <td className="td">{fmtDate(r.checkOut)}</td>
                  <td className="td capitalize text-muted-ink">{r.source.replace("_", " ")}</td>
                  <td className="td">{inr(r.totalAmount)}</td>
                  <td className="td"><span className={cn("badge", STATUS_BADGE[r.status])}>{r.status.replace("_", " ")}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ icon: Icon, label, value, delta, deltaSuffix, prefix }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; delta: number; deltaSuffix: string; positiveWhenUp?: boolean; prefix?: string;
}) {
  const up = delta >= 0;
  return (
    <div className="panel p-4 sm:p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs text-muted-ink font-medium">{label}</p>
        <div className="h-8 w-8 rounded-md bg-pine-100 flex items-center justify-center">
          <Icon className="h-4 w-4 text-pine-700" />
        </div>
      </div>
      <div className="flex items-baseline gap-1 mt-1.5">
        {prefix && <span className="text-sm text-pine-700 font-semibold">₹</span>}
        <p className="kpi-value">{prefix ? value.replace("₹", "") : value}</p>
      </div>
      <p className={cn("text-[11px] mt-1 flex items-center gap-1", up ? "text-ok" : "text-danger")}>
        {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
        {Math.abs(delta)}{deltaSuffix}
      </p>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function RevBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = Math.round((value / total) * 100);
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1">
        <span className="text-ink">{label}</span>
        <span className="font-medium text-pine">{inr(value)} <span className="text-muted-ink text-[11px]">({pct}%)</span></span>
      </div>
      <div className="h-2 rounded-full bg-plaster-deep overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ icon, name, room, meta }: { icon: React.ReactNode; name: string; room: string; meta: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <div className="h-7 w-7 rounded-full bg-plaster-deep flex items-center justify-center shrink-0">{icon}</div>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-pine truncate">{name} <span className="text-muted-ink font-normal">· {room}</span></p>
        <p className="text-[11px] text-muted-ink truncate">{meta}</p>
      </div>
    </div>
  );
}
