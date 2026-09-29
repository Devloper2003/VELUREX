"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDateShort, fmtDate, toISODate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend as RechartsLegend,
} from "recharts";
import {
  Download, Loader2, RefreshCw, IndianRupee, BedDouble, TrendingUp, Percent,
  Users, MoonStar, FileSpreadsheet, Wallet, CalendarRange, ArrowUpRight, ArrowDownRight, GitCompareArrows,
} from "lucide-react";
import { getStoredToken } from "@/lib/store";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ReportRow {
  date: string;
  occupancyPercent: number;
  adr: number;
  revpar: number;
  roomRevenue: number;
  fnbRevenue: number;
  miscRevenue: number;
  totalRevenue: number;
  noShowCount: number;
  outstandingBalance: number;
  occupiedRooms: number;
  totalRooms: number;
  source: "audit" | "computed";
}

interface SummaryData {
  from: string;
  to: string;
  rows: ReportRow[];
  totals: {
    revenue: number; room: number; fnb: number; misc: number;
    avgOccupancy: number; avgAdr: number; avgRevpar: number; noShows: number;
    payments: { cash: number; upi: number; card: number; netbanking: number; razorpay: number };
  };
  topGuests: { guestId: string; name: string; stays: number; spend: number }[];
  channelMix: { source: string; bookings: number; nights: number; roomRevenue: number; adr: number }[];
  comparison?: {
    from: string;
    to: string;
    totals: SummaryData["totals"];
    deltas: Partial<Record<"revenue" | "room" | "fnb" | "misc" | "avgOccupancy" | "avgAdr" | "avgRevpar" | "noShows", number | null>>;
  };
}

interface PosSummary {
  ordersCount: number;
  covers: number;
  revenue: number;
  avgOrderValue: number;
  revenueByCategory: { category: string; revenue: number; covers: number }[];
  paymentMix: Record<string, number>;
  ordersByType: Record<string, number>;
}

type ExportType = "revenue" | "occupancy" | "folio";

// ─── Constants ───────────────────────────────────────────────────────────────

const BRAND = { room: "#1F4B43", fnb: "#B9873E", misc: "#4C7A5A" };
const AXIS_TICK = { fill: "#7a6f5d", fontSize: 11 };
const GRID_STROKE = "#e3d7c1";
const TOOLTIP_STYLE = {
  background: "#fbf8f2",
  border: "1px solid #e3d7c1",
  borderRadius: 8,
  fontSize: 12,
  color: "#26302c",
};
const PAYMENT_LABELS: { key: keyof SummaryData["totals"]["payments"]; label: string; color: string }[] = [
  { key: "cash", label: "Cash", color: "#1F4B43" },
  { key: "upi", label: "UPI", color: "#B9873E" },
  { key: "card", label: "Card", color: "#4C7A5A" },
  { key: "netbanking", label: "Netbanking", color: "#7ea08c" },
  { key: "razorpay", label: "Razorpay", color: "#C08A2E" },
];

/** Channel (reservation source) display names + brand-consistent bar colors. */
const CHANNEL_META: Record<string, { label: string; color: string }> = {
  booking_engine: { label: "Booking Engine", color: "#B9873E" },
  front_desk: { label: "Front Desk", color: "#1F4B43" },
  walk_in: { label: "Walk-in", color: "#4C7A5A" },
  ota: { label: "OTA", color: "#C08A2E" },
  phone: { label: "Phone", color: "#7ea08c" },
};
const channelMeta = (s: string) => CHANNEL_META[s] ?? { label: s.replace(/_/g, " "), color: "#a89a83" };

// ─── View ────────────────────────────────────────────────────────────────────

export default function ReportsView() {
  const { toast } = useToast();
  const [from, setFrom] = useState(() => toISODate(new Date(Date.now() - 13 * 86400000)));
  const [to, setTo] = useState(() => toISODate(new Date()));
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [pos, setPos] = useState<PosSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [exportType, setExportType] = useState<ExportType>("revenue");
  const [exporting, setExporting] = useState<ExportType | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([
        api<SummaryData>(`/api/reports/summary?from=${from}&to=${to}`),
        api<PosSummary>(`/api/reports/pos?from=${from}&to=${to}`),
      ]);
      setSummary(s);
      setPos(p);
    } catch {
      /* keep stale data on transient failures */
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  /** Export endpoint requires a Bearer header — fetch as blob, then trigger a download. */
  const handleExport = useCallback(
    async (type: ExportType) => {
      setExporting(type);
      try {
        const token = getStoredToken();
        const res = await fetch(`/api/reports/export?from=${from}&to=${to}&type=${type}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) throw new Error(`Export failed (${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `velurex-${type}-${from}-${to}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast({ title: "Export ready", description: `velurex-${type}-${from}-${to}.csv downloaded` });
      } catch (e) {
        toast({ title: "Export failed", description: e instanceof Error ? e.message : "Please try again", variant: "destructive" });
      } finally {
        setExporting(null);
      }
    },
    [from, to, toast]
  );

  const applyPreset = (days: number) => {
    setFrom(toISODate(new Date(Date.now() - (days - 1) * 86400000)));
    setTo(toISODate(new Date()));
  };

  const chartRows = useMemo(
    () =>
      (summary?.rows ?? []).map((r) => ({
        label: fmtDateShort(r.date),
        date: r.date,
        room: r.roomRevenue,
        fnb: r.fnbRevenue,
        misc: r.miscRevenue,
        total: r.totalRevenue,
        occ: r.occupancyPercent,
        adr: r.adr,
        source: r.source,
      })),
    [summary]
  );

  const donut = useMemo(
    () =>
      summary
        ? [
            { name: "Rooms", value: summary.totals.room },
            { name: "F&B", value: summary.totals.fnb },
            { name: "Misc / Laundry", value: summary.totals.misc },
          ].filter((d) => d.value > 0)
        : [],
    [summary]
  );

  const auditRows = useMemo(() => (summary?.rows ?? []).filter((r) => r.source === "audit"), [summary]);

  const channelTotal = useMemo(
    () => (summary?.channelMix ?? []).reduce((s, c) => s + c.roomRevenue, 0),
    [summary]
  );

  const channelDonut = useMemo(
    () =>
      (summary?.channelMix ?? [])
        .filter((c) => c.roomRevenue > 0)
        .map((c) => ({ name: channelMeta(c.source).label, value: c.roomRevenue, color: channelMeta(c.source).color })),
    [summary]
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel px-4 py-3 flex flex-wrap items-end gap-3">
        <div>
          <span className="field-label">From</span>
          <input
            type="date"
            className="field w-40"
            value={from}
            max={to}
            onChange={(e) => {
              const v = e.target.value;
              setFrom(v);
              if (v && v > to) setTo(v);
            }}
          />
        </div>
        <div>
          <span className="field-label">To</span>
          <input
            type="date"
            className="field w-40"
            value={to}
            min={from}
            onChange={(e) => {
              const v = e.target.value;
              setTo(v);
              if (v && v < from) setFrom(v);
            }}
          />
        </div>
        <div className="flex items-center gap-1 pb-0.5">
          {[7, 14, 30].map((d) => (
            <button key={d} className="btn-ghost h-9" onClick={() => applyPreset(d)}>
              {d}d
            </button>
          ))}
        </div>
        <button className="btn-outline" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
        <div className="ml-auto flex items-end gap-2">
          <div>
            <span className="field-label">Export type</span>
            <select className="field w-40" value={exportType} onChange={(e) => setExportType(e.target.value as ExportType)}>
              <option value="revenue">Revenue</option>
              <option value="occupancy">Occupancy</option>
              <option value="folio">Folio items</option>
            </select>
          </div>
          <button className="btn-brass" onClick={() => handleExport(exportType)} disabled={exporting !== null}>
            {exporting === exportType ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Export Excel/CSV
          </button>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="revenue">Revenue</TabsTrigger>
          <TabsTrigger value="occupancy">Occupancy</TabsTrigger>
          <TabsTrigger value="archive">Night Audit Archive</TabsTrigger>
        </TabsList>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-4">
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <StatCard icon={IndianRupee} label="Total Revenue" value={inr(summary?.totals.revenue)} hint={`${summary?.rows.length ?? 0} days`} delta={summary?.comparison?.deltas.revenue} deltaHint="vs prev. period" loading={loading && !summary} />
            <StatCard icon={Percent} label="Avg Occupancy" value={`${summary?.totals.avgOccupancy ?? 0}%`} hint="across range" delta={summary?.comparison?.deltas.avgOccupancy} deltaHint="vs prev. period" deltaUnit="%" loading={loading && !summary} />
            <StatCard icon={BedDouble} label="Avg ADR" value={inr(summary?.totals.avgAdr)} hint="avg daily rate" delta={summary?.comparison?.deltas.avgAdr} deltaHint="vs prev. period" loading={loading && !summary} />
            <StatCard icon={TrendingUp} label="Avg RevPAR" value={inr(summary?.totals.avgRevpar)} hint="revenue per available room" delta={summary?.comparison?.deltas.avgRevpar} deltaHint="vs prev. period" loading={loading && !summary} />
          </div>

          {summary?.comparison && <ComparisonPanel comparison={summary.comparison} />}

          <div className="grid lg:grid-cols-3 gap-4">
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Revenue by Source</p>
                <span className="text-xs text-muted-ink">{from} → {to}</span>
              </div>
              <div className="p-4 relative h-[300px]">
                {donut.length > 0 ? (
                  <>
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={donut} dataKey="value" nameKey="name" innerRadius={62} outerRadius={95} paddingAngle={3} strokeWidth={0}>
                          {donut.map((d, i) => (
                            <Cell key={d.name} fill={[BRAND.room, BRAND.fnb, BRAND.misc][i]} />
                          ))}
                        </Pie>
                        <Tooltip formatter={(v) => inr(Number(v))} contentStyle={TOOLTIP_STYLE} />
                        <RechartsLegend iconType="circle" wrapperStyle={{ fontSize: 12 }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pb-10">
                      <p className="text-[11px] uppercase tracking-wider text-muted-ink">Total</p>
                      <p className="font-display text-lg font-semibold text-pine">{inr(summary?.totals.revenue)}</p>
                    </div>
                  </>
                ) : (
                  <EmptyState icon={Wallet} text="No revenue recorded in this range" />
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Payment Mix</p>
                <Wallet className="h-4 w-4 text-brass" />
              </div>
              <div className="p-4 space-y-3">
                {PAYMENT_LABELS.map((p) => (
                  <MixBar key={p.key} label={p.label} value={summary?.totals.payments[p.key] ?? 0} color={p.color} />
                ))}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Top Guests</p>
                <Users className="h-4 w-4 text-brass" />
              </div>
              {summary && summary.topGuests.length > 0 ? (
                <div className="divide-y divide-line/70">
                  {summary.topGuests.map((g, i) => (
                    <div key={g.guestId} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="h-7 w-7 rounded-full bg-pine-100 text-pine-700 text-xs font-semibold flex items-center justify-center shrink-0">
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-medium text-pine truncate">{g.name}</p>
                        <p className="text-[11px] text-muted-ink">{g.stays} {g.stays === 1 ? "stay" : "stays"} in range</p>
                      </div>
                      <span className="text-sm font-semibold text-brass">{inr(g.spend)}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState icon={Users} text={loading ? "Loading guests…" : "No guest folio activity in this range"} />
              )}
            </div>
          </div>

          {/* Channel mix — room nights + revenue attributed to reservation sources */}
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Channel Mix</p>
              <span className="text-xs text-muted-ink">
                {summary?.channelMix.reduce((s, c) => s + c.bookings, 0) ?? 0} bookings ·{" "}
                {summary?.channelMix.reduce((s, c) => s + c.nights, 0) ?? 0} room nights
              </span>
            </div>
            {summary && summary.channelMix.length > 0 ? (
              <div className="p-4 grid lg:grid-cols-[300px_1fr] gap-6 items-center">
                {/* Donut — revenue share by channel */}
                <div className="relative h-[240px]">
                  {channelDonut.length > 0 && (
                    <>
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={channelDonut}
                            dataKey="value"
                            nameKey="name"
                            innerRadius={58}
                            outerRadius={90}
                            paddingAngle={3}
                            strokeWidth={0}
                            animationDuration={700}
                          >
                            {channelDonut.map((d) => (
                              <Cell key={d.name} fill={d.color} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(v, name) => {
                              const total = channelDonut.reduce((s, d) => s + d.value, 0) || 1;
                              const share = ((Number(v) / total) * 100).toFixed(0);
                              return [`${inr(Number(v))} · ${share}%`, String(name)];
                            }}
                            contentStyle={TOOLTIP_STYLE}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                        <p className="text-[10px] uppercase tracking-wider text-muted-ink">Room Revenue</p>
                        <p className="font-display text-base font-semibold text-pine">{inr(channelTotal)}</p>
                      </div>
                    </>
                  )}
                </div>
                {/* Bars — per-channel detail */}
                <div className="space-y-3 min-w-0">
                  {summary.channelMix.map((c) => {
                    const meta = channelMeta(c.source);
                    const share = channelTotal > 0 ? (c.roomRevenue / channelTotal) * 100 : 0;
                    return (
                      <div key={c.source} className="grid grid-cols-[110px_1fr_auto] sm:grid-cols-[130px_1fr_auto] items-center gap-3">
                        <div className="min-w-0">
                          <p className="text-[13px] font-medium text-pine truncate flex items-center gap-1.5">
                            <span className="h-2 w-2 rounded-full shrink-0" style={{ background: meta.color }} />
                            {meta.label}
                          </p>
                          <p className="text-[11px] text-muted-ink pl-3.5">
                            {c.bookings} booking{c.bookings === 1 ? "" : "s"} · {c.nights} night{c.nights === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="h-2.5 rounded-full bg-plaster-deep/60 overflow-hidden" title={`${meta.label}: ${inr(c.roomRevenue)} (${share.toFixed(1)}%)`}>
                          <div
                            className="h-full rounded-full transition-[width] duration-700 ease-out"
                            style={{ width: `${Math.max(share, c.roomRevenue > 0 ? 2 : 0)}%`, background: meta.color }}
                          />
                        </div>
                        <div className="text-right whitespace-nowrap">
                          <p className="text-[13px] font-semibold text-pine tabular-nums">{inr(c.roomRevenue)}</p>
                          <p className="text-[11px] text-muted-ink tabular-nums">
                            {share.toFixed(0)}% · ADR {inr(c.adr)}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="p-4 text-sm text-muted-ink">No stays recorded in this range.</div>
            )}
          </div>

          {/* F&B snapshot from /api/reports/pos */}
          {pos && (
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">F&amp;B Snapshot</p>
                <span className="text-xs text-muted-ink">{pos.ordersCount} orders · {pos.covers} covers</span>
              </div>
              <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                <InlineStat label="F&B Revenue" value={inr(pos.revenue)} />
                <InlineStat label="Avg Order Value" value={inr(pos.avgOrderValue)} />
                <InlineStat label="Top Category" value={pos.revenueByCategory[0]?.category ? capitalize(pos.revenueByCategory[0].category) : "—"} />
                <InlineStat label="Direct Payments" value={inr(Object.values(pos.paymentMix).reduce((s, v) => s + v, 0))} />
              </div>
            </div>
          )}
        </TabsContent>

        {/* ── Revenue ──────────────────────────────────────────────────── */}
        <TabsContent value="revenue" className="space-y-4">
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Daily Revenue — Stacked</p>
              <div className="flex items-center gap-2">
                <Legend color={BRAND.room} label="Rooms" />
                <Legend color={BRAND.fnb} label="F&B" />
                <Legend color={BRAND.misc} label="Misc" />
                <button className="btn-outline h-8" onClick={() => handleExport("revenue")} disabled={exporting !== null}>
                  {exporting === "revenue" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                  CSV
                </button>
              </div>
            </div>
            <div className="p-4 h-[300px]">
              {chartRows.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartRows} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval="preserveStartEnd" />
                    <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v) => inr(Number(v))} width={72} />
                    <Tooltip
                      formatter={(v, name) => [inr(Number(v)), String(name)]}
                      contentStyle={TOOLTIP_STYLE}
                      cursor={{ fill: "rgba(185,135,62,0.08)" }}
                    />
                    <Bar dataKey="room" name="Rooms" stackId="rev" fill={BRAND.room} radius={[0, 0, 0, 0]} />
                    <Bar dataKey="fnb" name="F&B" stackId="rev" fill={BRAND.fnb} />
                    <Bar dataKey="misc" name="Misc" stackId="rev" fill={BRAND.misc} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={IndianRupee} text={loading ? "Loading revenue…" : "No data for this range"} />
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Revenue Detail</p>
              <span className="text-xs text-muted-ink">{summary?.rows.length ?? 0} days</span>
            </div>
            <div className="overflow-x-auto scroll-slim">
              <table className="w-full min-w-[720px]">
                <thead>
                  <tr>
                    <th className="th">Date</th>
                    <th className="th text-right">Room</th>
                    <th className="th text-right">F&amp;B</th>
                    <th className="th text-right">Misc</th>
                    <th className="th text-right">Total</th>
                    <th className="th text-right">Occupancy</th>
                    <th className="th text-right">ADR</th>
                    <th className="th text-right">RevPAR</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.rows ?? []).map((r) => (
                    <tr key={r.date} className="hover:bg-plaster/50">
                      <td className="td whitespace-nowrap" title={fmtDate(r.date)}>{fmtDateShort(r.date)}</td>
                      <td className="td text-right">{inr(r.roomRevenue)}</td>
                      <td className="td text-right">{inr(r.fnbRevenue)}</td>
                      <td className="td text-right">{inr(r.miscRevenue)}</td>
                      <td className="td text-right font-semibold text-pine">{inr(r.totalRevenue)}</td>
                      <td className="td text-right">{r.occupancyPercent}%</td>
                      <td className="td text-right">{inr(r.adr)}</td>
                      <td className="td text-right">{inr(r.revpar)}</td>
                    </tr>
                  ))}
                  {summary && summary.rows.length === 0 && (
                    <tr><td className="td text-center text-muted-ink" colSpan={8}>No data for this range</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ── Occupancy ────────────────────────────────────────────────── */}
        <TabsContent value="occupancy" className="space-y-4">
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Occupancy &amp; ADR</p>
              <div className="flex items-center gap-2">
                <Legend color={BRAND.room} label="Occupancy %" />
                <Legend color={BRAND.fnb} label="ADR" />
                <button className="btn-outline h-8" onClick={() => handleExport("occupancy")} disabled={exporting !== null}>
                  {exporting === "occupancy" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5" />}
                  CSV
                </button>
              </div>
            </div>
            <div className="p-4 h-[300px]">
              {chartRows.length > 0 ? (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartRows} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval="preserveStartEnd" />
                    <YAxis yAxisId="occ" orientation="left" domain={[0, 100]} tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}%`} width={48} />
                    <YAxis yAxisId="adr" orientation="right" tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v) => inr(Number(v))} width={72} />
                    <Tooltip
                      formatter={(v, name) => (name === "ADR" ? [inr(Number(v)), "ADR"] : [`${Number(v)}%`, "Occupancy"])}
                      contentStyle={TOOLTIP_STYLE}
                      cursor={{ stroke: BRAND.fnb, strokeDasharray: "3 3" }}
                    />
                    <Line yAxisId="occ" type="monotone" dataKey="occ" name="Occupancy %" stroke={BRAND.room} strokeWidth={2} dot={{ r: 2.5, fill: BRAND.room }} activeDot={{ r: 4 }} />
                    <Line yAxisId="adr" type="monotone" dataKey="adr" name="ADR" stroke={BRAND.fnb} strokeWidth={2} dot={{ r: 2.5, fill: BRAND.fnb }} activeDot={{ r: 4 }} />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={BedDouble} text={loading ? "Loading occupancy…" : "No data for this range"} />
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Occupancy Detail</p>
              <span className="text-xs text-muted-ink">{summary?.totals.noShows ?? 0} no-shows in range</span>
            </div>
            <div className="overflow-x-auto scroll-slim">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th">Date</th>
                    <th className="th text-right">Occupied</th>
                    <th className="th text-right">Total</th>
                    <th className="th text-right">Occ %</th>
                    <th className="th text-right">ADR</th>
                    <th className="th text-right">RevPAR</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary?.rows ?? []).map((r) => (
                    <tr key={r.date} className="hover:bg-plaster/50">
                      <td className="td whitespace-nowrap" title={fmtDate(r.date)}>{fmtDateShort(r.date)}</td>
                      <td className="td text-right">{r.occupiedRooms}</td>
                      <td className="td text-right">{r.totalRooms}</td>
                      <td className={cn("td text-right font-medium", r.occupancyPercent >= 80 ? "text-ok" : r.occupancyPercent >= 50 ? "text-pine" : "text-muted-ink")}>
                        {r.occupancyPercent}%
                      </td>
                      <td className="td text-right">{inr(r.adr)}</td>
                      <td className="td text-right">{inr(r.revpar)}</td>
                    </tr>
                  ))}
                  {summary && summary.rows.length === 0 && (
                    <tr><td className="td text-center text-muted-ink" colSpan={6}>No data for this range</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* ── Night Audit Archive ──────────────────────────────────────── */}
        <TabsContent value="archive" className="space-y-4">
          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <MoonStar className="h-4 w-4 text-brass" />
                <p className="panel-title">Finalized Daily Summaries</p>
              </div>
              <span className="text-xs text-muted-ink">{auditRows.length} of {summary?.rows.length ?? 0} days audited</span>
            </div>
            {auditRows.length > 0 ? (
              <div className="overflow-x-auto scroll-slim">
                <table className="w-full min-w-[720px]">
                  <thead>
                    <tr>
                      <th className="th">Business Date</th>
                      <th className="th text-right">Room</th>
                      <th className="th text-right">F&amp;B</th>
                      <th className="th text-right">Misc</th>
                      <th className="th text-right">Total</th>
                      <th className="th text-right">Occ %</th>
                      <th className="th text-right">ADR</th>
                      <th className="th text-right">No-Shows</th>
                      <th className="th text-right">Outstanding</th>
                      <th className="th">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditRows.map((r) => (
                      <tr key={r.date} className="hover:bg-plaster/50">
                        <td className="td whitespace-nowrap" title={fmtDate(r.date)}>{fmtDateShort(r.date)}</td>
                        <td className="td text-right">{inr(r.roomRevenue)}</td>
                        <td className="td text-right">{inr(r.fnbRevenue)}</td>
                        <td className="td text-right">{inr(r.miscRevenue)}</td>
                        <td className="td text-right font-semibold text-pine">{inr(r.totalRevenue)}</td>
                        <td className="td text-right">{r.occupancyPercent}%</td>
                        <td className="td text-right">{inr(r.adr)}</td>
                        <td className="td text-right">{r.noShowCount}</td>
                        <td className="td text-right text-brass">{inr(r.outstandingBalance)}</td>
                        <td className="td">
                          <span className="badge border-ok/40 bg-ok/10 text-ok">
                            <CalendarRange className="h-3 w-3" /> Finalized
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                icon={MoonStar}
                text="No finalized night audits in this range — run the Night Audit to archive daily numbers"
                className="py-10"
              />
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Local components ────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, hint, delta, deltaHint, deltaUnit, loading }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; hint: string; loading?: boolean;
  delta?: number | null; deltaHint?: string; deltaUnit?: string;
}) {
  const up = (delta ?? 0) > 0;
  const good = deltaUnit === "%" ? (delta ?? 0) >= 0 : up; // occupancy up = good; noShows handled by unit absent
  return (
    <div className="panel p-4 sm:p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs text-muted-ink font-medium">{label}</p>
        <div className="h-8 w-8 rounded-md bg-pine-100 flex items-center justify-center">
          <Icon className="h-4 w-4 text-pine-700" />
        </div>
      </div>
      {loading ? (
        <div className="skeleton h-8 w-24 rounded mt-1.5" />
      ) : (
        <p className="kpi-value mt-1.5">{value}</p>
      )}
      <div className="flex items-center gap-2 mt-1 flex-wrap">
        <p className="text-[11px] text-muted-ink">{hint}</p>
        {delta !== undefined && delta !== null && (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
              good ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
            )}
            title={`${deltaHint ?? "vs previous period"}: ${delta > 0 ? "+" : ""}${delta}%`}
          >
            {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {delta > 0 ? "+" : ""}{delta}%
          </span>
        )}
      </div>
    </div>
  );
}

/** Current vs previous period — same-length window ending the day before `from`. */
function ComparisonPanel({ comparison }: {
  comparison: NonNullable<SummaryData["comparison"]>;
}) {
  const t = comparison.totals;
  const d = comparison.deltas;
  const rows: { label: string; cur: number; prev: number; delta: number | null; money?: boolean; pct?: boolean }[] = [
    { label: "Total Revenue", cur: t.revenue, prev: t.revenue, delta: d.revenue ?? null, money: true },
    { label: "Room Revenue", cur: t.room, prev: t.room, delta: d.room ?? null, money: true },
    { label: "F&B Revenue", cur: t.fnb, prev: t.fnb, delta: d.fnb ?? null, money: true },
    { label: "Misc Revenue", cur: t.misc, prev: t.misc, delta: d.misc ?? null, money: true },
    { label: "Avg Occupancy", cur: t.avgOccupancy, prev: t.avgOccupancy, delta: d.avgOccupancy ?? null, pct: true },
    { label: "Avg ADR", cur: t.avgAdr, prev: t.avgAdr, delta: d.avgAdr ?? null, money: true },
    { label: "Avg RevPAR", cur: t.avgRevpar, prev: t.avgRevpar, delta: d.avgRevpar ?? null, money: true },
    { label: "No-shows", cur: t.noShows, prev: t.noShows, delta: d.noShows ?? null },
  ];

  const fmtVal = (v: number, r: (typeof rows)[number]) =>
    r.money ? inr(v) : r.pct ? `${v}%` : String(Math.round(v));

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="flex items-center gap-2">
          <GitCompareArrows className="h-4 w-4 text-brass" />
          <p className="panel-title">Period Comparison</p>
        </div>
        <span className="text-xs text-muted-ink">
          {comparison.from} → {comparison.to} · previous period
        </span>
      </div>
      <div className="p-4 grid sm:grid-cols-2 xl:grid-cols-4 gap-3">
        {rows.map((r) => {
          const up = (r.delta ?? 0) > 0;
          const down = (r.delta ?? 0) < 0;
          // For no-shows, an increase is a warning, not a win
          const good = r.label === "No-shows" ? down : up;
          const flat = r.delta === null || r.delta === 0;
          return (
            <div key={r.label} className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
              <p className="text-[11px] uppercase tracking-wider text-muted-ink">{r.label}</p>
              <div className="flex items-baseline gap-2 mt-0.5 flex-wrap">
                <span className="font-display text-base font-semibold text-pine tabular-nums">{fmtVal(r.cur, r)}</span>
                <span className="text-[11px] text-muted-ink tabular-nums">was {fmtVal(r.prev, r)}</span>
              </div>
              <div className="mt-1">
                {flat ? (
                  <span className="text-[11px] text-muted-ink">no baseline / no change</span>
                ) : (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 text-[11px] font-semibold tabular-nums",
                      good ? "text-ok" : "text-warn"
                    )}
                  >
                    {up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                    {up ? "+" : ""}{r.delta}% vs prev.
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MixBar({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1">
        <span className="text-ink">{label}</span>
        <span className="font-medium text-pine">{inr(value)}</span>
      </div>
      <div className="h-2 rounded-full bg-plaster-deep overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${Math.min(100, Math.round(value))}%`, background: color }} />
      </div>
    </div>
  );
}

function InlineStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
      <p className="text-[11px] uppercase tracking-wider text-muted-ink">{label}</p>
      <p className="font-display text-base font-semibold text-pine capitalize">{value}</p>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="hidden sm:flex items-center gap-1.5 text-[11px] text-muted-ink">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function EmptyState({ icon: Icon, text, className }: {
  icon: React.ComponentType<{ className?: string }>;
  text: string; className?: string;
}) {
  return (
    <div className={cn("h-full flex flex-col items-center justify-center gap-2 text-center px-6", className)}>
      <div className="h-10 w-10 rounded-full bg-plaster-deep flex items-center justify-center">
        <Icon className="h-5 w-5 text-muted-ink" />
      </div>
      <p className="text-sm text-muted-ink max-w-xs">{text}</p>
    </div>
  );
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
