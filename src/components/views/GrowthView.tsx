"use client";

/**
 * Growth & Revenue studio (tenant side) — Task 35-c.
 *
 * Tabs: Revenue Intelligence | Marketing Studio, driven by a shared range
 * selector (7d / 30d / 90d presets + custom dates). Data comes from
 * /api/growth/overview and /api/growth/campaigns.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate, fmtDateShort, toISODate } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import {
  Rocket, TrendingUp, Target, Megaphone, Users, IndianRupee, Percent, CalendarRange,
  Sparkles, Zap, ArrowUpRight, ArrowDownRight, MessageCircle, Mail, Ticket, Share2,
  UserRound, UserPlus, Clock, RefreshCw, Loader2, Pencil, Trash2, Wallet,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OverviewKpis {
  totalRevenue: number;
  roomRevenue: number;
  fnbRevenue: number;
  miscRevenue: number;
  adr: number;
  revpar: number;
  occupancyPct: number;
  arpu: number;
  repeatRatePct: number;
  directPct: number;
  uniqueGuests: number;
  totalBookings: number;
  directBookings: number;
}

interface GrowthOverview {
  from: string;
  to: string;
  kpis: OverviewKpis;
  trend: { date: string; total: number; room: number; fnb: number; misc: number }[];
  forecast: { method: string; basis: string; days: { date: string; projected: number }[] };
  funnel: { holds: number; redeemed: number; promosUsed: number; upsellsAttached: number; paidBookings: number };
  segments: {
    new: number;
    repeat: number;
    vip: number;
    lapsed: number;
    vipThreshold: number;
    topSpenders: { guestId: string; name: string; stays: number; spend: number; lastStay: string | null }[];
  };
  channelMix: { source: string; bookings: number; nights: number; roomRevenue: number; adr: number }[];
  marketing: {
    activeCampaigns: number;
    totalCampaigns: number;
    totalBudget: number;
    totalSpent: number;
    attributedRevenue: number;
    avgRoiPct: number;
    promoCodes: { code: string; discountType: string; discountValue: number; usedCount: number; maxUses: number; active: boolean }[];
  };
  payments: { cash: number; upi: number; card: number; netbanking: number; razorpay: number };
  comparison?: {
    from: string;
    to: string;
    totals: { revenue: number; avgAdr: number; avgRevpar: number; avgOccupancy: number };
    deltas: Partial<Record<"revenue" | "avgAdr" | "avgRevpar" | "avgOccupancy", number | null>>;
  };
}

interface Campaign {
  id: string;
  name: string;
  channel: string;
  status: string;
  audience: string;
  promoCode: string;
  budget: number;
  spent: number;
  reach: number;
  conversions: number;
  revenue: number;
  startsAt: string | null;
  endsAt: string | null;
  notes: string;
  createdAt: string;
}

interface CampaignsPayload {
  campaigns: Campaign[];
  summary: {
    total: number;
    byStatus: { draft: number; active: number; paused: number; completed: number };
    totalBudget: number;
    totalSpent: number;
    attributedRevenue: number;
    avgRoiPct: number;
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const BRAND = { room: "#1F4B43", fnb: "#B9873E", misc: "#4C7A5A", pine: "#0F2622" };
const AXIS_TICK = { fill: "#7a6f5d", fontSize: 11 };
const GRID_STROKE = "#e3d7c1";
const TOOLTIP_STYLE = {
  background: "#fbf8f2",
  border: "1px solid #e3d7c1",
  borderRadius: 8,
  fontSize: 12,
  color: "#26302c",
};

const CHANNEL_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  whatsapp: { label: "WhatsApp", icon: MessageCircle },
  email: { label: "Email", icon: Mail },
  promo: { label: "Promo", icon: Ticket },
  social: { label: "Social", icon: Share2 },
  direct: { label: "Direct", icon: UserRound },
};
const channelMeta = (c: string) => CHANNEL_META[c] ?? { label: c.replace(/_/g, " "), icon: Megaphone };

const STATUS_META: Record<string, string> = {
  draft: "border-line-strong bg-plaster text-muted-ink",
  active: "border-ok/40 bg-ok/10 text-ok",
  paused: "border-warn/40 bg-warn/10 text-warn",
  completed: "border-pine-600/30 bg-pine-100/60 text-pine-700",
};

const AUDIENCE_LABELS: Record<string, string> = {
  all_guests: "All guests",
  repeat: "Repeat guests",
  new: "New guests",
  vip: "VIP",
  lapsed: "Lapsed",
};

const SOURCE_META: Record<string, { label: string; direct: boolean }> = {
  front_desk: { label: "Front Desk", direct: true },
  booking_engine: { label: "Booking Engine", direct: true },
  walk_in: { label: "Walk-in", direct: true },
  ota: { label: "OTA", direct: false },
  phone: { label: "Phone", direct: false },
};

const emptyForm = {
  name: "",
  channel: "whatsapp",
  audience: "all_guests",
  promoCode: "",
  budget: "",
  startsAt: "",
  endsAt: "",
  notes: "",
};

// ─── Small helpers ───────────────────────────────────────────────────────────

function pct(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

function roiPct(revenue: number, spent: number): number | null {
  return spent > 0 ? Math.round((revenue / spent) * 100) : null;
}

/** Delta chip — green when up, red when down, gray when there is no baseline. */
function DeltaChip({ delta, suffix = "%" }: { delta: number | null | undefined; suffix?: string }) {
  if (delta === undefined || delta === null) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded-full bg-plaster-deep/60 px-1.5 py-0.5 text-[10px] font-semibold text-muted-ink">
        no baseline
      </span>
    );
  }
  const up = delta > 0;
  const flat = delta === 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums",
        flat ? "bg-plaster-deep/60 text-muted-ink" : up ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger"
      )}
      title="vs previous period of the same length"
    >
      {flat ? null : up ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
      {up ? "+" : ""}{delta}{suffix}
    </span>
  );
}

function KpiCard({ icon: Icon, label, value, hint, delta, loading }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; hint: string;
  delta?: number | null; loading?: boolean;
}) {
  return (
    <div className="panel p-4 sm:p-5">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium text-muted-ink">{label}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-pine-100">
          <Icon className="h-4 w-4 text-pine-700" />
        </div>
      </div>
      {loading ? (
        <div className="skeleton mt-1.5 h-8 w-24 rounded" />
      ) : (
        <p className="kpi-value mt-1.5">{value}</p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="text-[11px] text-muted-ink">{hint}</p>
        {!loading && delta !== undefined && <DeltaChip delta={delta} />}
      </div>
    </div>
  );
}

function PanelLegend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted-ink">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

function SkeletonBlock({ className }: { className?: string }) {
  return <div className={cn("skeleton animate-pulse rounded-md", className)} />;
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function GrowthView() {
  const { toast } = useToast();

  // Shared range selector — drives both tabs.
  const [from, setFrom] = useState(() => toISODate(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => toISODate(new Date()));
  const [preset, setPreset] = useState<7 | 30 | 90 | "custom">(30);

  const [overview, setOverview] = useState<GrowthOverview | null>(null);
  const [campaignsData, setCampaignsData] = useState<CampaignsPayload | null>(null);
  const [loading, setLoading] = useState(true);

  // Dialog state — create/edit share one form; separate dialogs for results + delete.
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [resultsFor, setResultsFor] = useState<Campaign | null>(null);
  const [results, setResults] = useState({ reach: "", conversions: "", revenue: "", spent: "" });
  const [deleteFor, setDeleteFor] = useState<Campaign | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [o, c] = await Promise.all([
        api<GrowthOverview>(`/api/growth/overview?from=${from}&to=${to}`),
        api<CampaignsPayload>("/api/growth/campaigns"),
      ]);
      setOverview(o);
      setCampaignsData(c);
    } catch (e) {
      toast({
        title: "Could not load growth data",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [from, to, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const applyPreset = (days: 7 | 30 | 90) => {
    setPreset(days);
    setFrom(toISODate(new Date(Date.now() - (days - 1) * 86400000)));
    setTo(toISODate(new Date()));
  };

  // ── Derived chart data ───────────────────────────────────────────────────

  const trendRows = useMemo(
    () =>
      (overview?.trend ?? []).map((r) => ({
        label: fmtDateShort(r.date),
        room: r.room,
        fnb: r.fnb,
        misc: r.misc,
      })),
    [overview]
  );

  /** Last 14 actual days + 7 projected — the dashed line connects at the seam. */
  const forecastRows = useMemo(() => {
    if (!overview) return [];
    const actual = overview.trend.slice(-14).map((r) => ({
      label: fmtDateShort(r.date),
      actual: r.total as number | null,
      projected: null as number | null,
    }));
    const projected = overview.forecast.days.map((d) => ({
      label: fmtDateShort(d.date),
      actual: null as number | null,
      projected: d.projected as number | null,
    }));
    if (actual.length > 0 && projected.length > 0) {
      actual[actual.length - 1].projected = actual[actual.length - 1].actual; // seam
    }
    return [...actual, ...projected];
  }, [overview]);

  const funnelStages = useMemo(() => {
    const f = overview?.funnel;
    if (!f) return [];
    const stages = [
      { key: "holds", label: "Holds created", value: f.holds },
      { key: "redeemed", label: "Holds redeemed", value: f.redeemed },
      { key: "paid", label: "Paid bookings", value: f.paidBookings },
    ];
    const max = Math.max(1, stages[0].value);
    return stages.map((s, i) => ({
      ...s,
      widthPct: Math.min(100, (s.value / max) * 100),
      convFromPrev: i === 0 ? null : pct(s.value, stages[i - 1].value),
    }));
  }, [overview]);

  const channelSplit = useMemo(() => {
    const mix = overview?.channelMix ?? [];
    const direct = mix.filter((c) => SOURCE_META[c.source]?.direct ?? true);
    const indirect = mix.filter((c) => !(SOURCE_META[c.source]?.direct ?? true));
    const sum = (arr: typeof mix) => ({
      bookings: arr.reduce((s, c) => s + c.bookings, 0),
      revenue: arr.reduce((s, c) => s + c.roomRevenue, 0),
    });
    const d = sum(direct);
    const i = sum(indirect);
    const total = d.bookings + i.bookings;
    return {
      direct: { ...d, pct: total > 0 ? Math.round((d.bookings / total) * 100) : 0 },
      indirect: { ...i, pct: total > 0 ? Math.round((i.bookings / total) * 100) : 0 },
      rows: mix,
      totalRevenue: mix.reduce((s, c) => s + c.roomRevenue, 0),
    };
  }, [overview]);

  const campaigns = campaignsData?.campaigns ?? [];
  const promoOptions = overview?.marketing.promoCodes ?? [];

  // ── Campaign mutations ───────────────────────────────────────────────────

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm);
    setFormOpen(true);
  };

  const openEdit = (c: Campaign) => {
    setEditing(c);
    setForm({
      name: c.name,
      channel: c.channel,
      audience: c.audience,
      promoCode: c.promoCode,
      budget: String(c.budget ?? 0),
      startsAt: c.startsAt ? toISODate(new Date(c.startsAt)) : "",
      endsAt: c.endsAt ? toISODate(new Date(c.endsAt)) : "",
      notes: c.notes ?? "",
    });
    setFormOpen(true);
  };

  const submitForm = async () => {
    if (!form.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        channel: form.channel,
        audience: form.audience,
        promoCode: form.promoCode || "",
        budget: Number(form.budget || 0),
        startsAt: form.startsAt || null,
        endsAt: form.endsAt || null,
        notes: form.notes,
      };
      if (editing) {
        await api(`/api/growth/campaigns/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast({ title: "Campaign updated", description: form.name.trim() });
      } else {
        await api("/api/growth/campaigns", { method: "POST", body: JSON.stringify(payload) });
        toast({ title: "Campaign created", description: `${form.name.trim()} is ready in draft` });
      }
      setFormOpen(false);
      load();
    } catch (e) {
      toast({
        title: editing ? "Update failed" : "Could not create campaign",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const openResults = (c: Campaign) => {
    setResultsFor(c);
    setResults({
      reach: String(c.reach ?? 0),
      conversions: String(c.conversions ?? 0),
      revenue: String(c.revenue ?? 0),
      spent: String(c.spent ?? 0),
    });
  };

  const submitResults = async () => {
    if (!resultsFor) return;
    setSaving(true);
    try {
      await api(`/api/growth/campaigns/${resultsFor.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          reach: Number(results.reach || 0),
          conversions: Number(results.conversions || 0),
          revenue: Number(results.revenue || 0),
          spent: Number(results.spent || 0),
        }),
      });
      toast({ title: "Results recorded", description: resultsFor.name });
      setResultsFor(null);
      load();
    } catch (e) {
      toast({
        title: "Could not record results",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  const setStatus = async (c: Campaign, status: string) => {
    try {
      await api(`/api/growth/campaigns/${c.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast({ title: `Campaign ${status}`, description: c.name });
      load();
    } catch (e) {
      toast({
        title: "Status change failed",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    }
  };

  const confirmDelete = async () => {
    if (!deleteFor) return;
    setDeleting(true);
    try {
      await api(`/api/growth/campaigns/${deleteFor.id}`, { method: "DELETE" });
      toast({ title: "Campaign deleted", description: deleteFor.name });
      setDeleteFor(null);
      load();
    } catch (e) {
      toast({
        title: "Delete failed",
        description: e instanceof Error ? e.message : "Please try again",
        variant: "destructive",
      });
    } finally {
      setDeleting(false);
    }
  };

  // ── Lifecycle buttons per status ─────────────────────────────────────────
  const lifecycleActions = (status: string): { label: string; next: string; cls: string }[] => {
    if (status === "draft") return [{ label: "Activate", next: "active", cls: "text-ok hover:bg-ok/10" }];
    if (status === "active")
      return [
        { label: "Pause", next: "paused", cls: "text-warn hover:bg-warn/10" },
        { label: "Complete", next: "completed", cls: "text-pine-700 hover:bg-pine-100" },
      ];
    if (status === "paused")
      return [
        { label: "Activate", next: "active", cls: "text-ok hover:bg-ok/10" },
        { label: "Complete", next: "completed", cls: "text-pine-700 hover:bg-pine-100" },
      ];
    return [];
  };

  const k = overview?.kpis;
  const cmp = overview?.comparison;
  const f = overview?.funnel;
  const seg = overview?.segments;
  const mkt = overview?.marketing;
  const cSum = campaignsData?.summary;

  return (
    <div className="space-y-4">
      {/* ── Toolbar: range selector (drives both tabs) ──────────────────── */}
      <div className="panel flex flex-wrap items-end gap-3 px-4 py-3">
        <div className="flex items-center gap-2 pb-0.5">
          <CalendarRange className="h-4 w-4 text-brass" />
          <span className="hidden text-xs font-semibold uppercase tracking-wider text-muted-ink sm:inline">
            Growth range
          </span>
        </div>
        <div className="flex items-center gap-1 pb-0.5">
          {([7, 30, 90] as const).map((d) => (
            <button
              key={d}
              className={cn("btn-ghost h-9", preset === d && "bg-pine-100 font-semibold text-pine-700")}
              onClick={() => applyPreset(d)}
            >
              {d}d
            </button>
          ))}
        </div>
        <div>
          <span className="field-label">From</span>
          <input
            type="date"
            className="field w-40"
            value={from}
            max={to}
            onChange={(e) => {
              setPreset("custom");
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
              setPreset("custom");
              const v = e.target.value;
              setTo(v);
              if (v && v < from) setFrom(v);
            }}
          />
        </div>
        <button className="btn-outline ml-auto" onClick={load} disabled={loading}>
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          Refresh
        </button>
      </div>

      <Tabs defaultValue="revenue" className="space-y-4">
        <TabsList>
          <TabsTrigger value="revenue" className="gap-1.5">
            <TrendingUp className="h-3.5 w-3.5" /> Revenue Intelligence
          </TabsTrigger>
          <TabsTrigger value="marketing" className="gap-1.5">
            <Megaphone className="h-3.5 w-3.5" /> Marketing Studio
          </TabsTrigger>
        </TabsList>

        {/* ══ Revenue Intelligence ══════════════════════════════════════ */}
        <TabsContent value="revenue" className="space-y-4">
          {/* KPI row */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            <KpiCard
              icon={IndianRupee}
              label="Total Revenue"
              value={inr(k?.totalRevenue)}
              hint={`${overview?.from ?? from} → ${overview?.to ?? to}`}
              delta={cmp?.deltas.revenue}
              loading={loading && !overview}
            />
            <KpiCard
              icon={IndianRupee}
              label="ADR"
              value={inr(k?.adr)}
              hint="avg daily rate"
              delta={cmp?.deltas.avgAdr}
              loading={loading && !overview}
            />
            <KpiCard
              icon={TrendingUp}
              label="RevPAR"
              value={inr(k?.revpar)}
              hint="revenue per available room"
              delta={cmp?.deltas.avgRevpar}
              loading={loading && !overview}
            />
            <KpiCard
              icon={Percent}
              label="Occupancy"
              value={`${k?.occupancyPct ?? 0}%`}
              hint="avg across range"
              delta={cmp?.deltas.avgOccupancy}
              loading={loading && !overview}
            />
            <KpiCard
              icon={Users}
              label="Repeat Rate"
              value={`${k?.repeatRatePct ?? 0}%`}
              hint={`${k?.uniqueGuests ?? 0} guests with stays · ARPU ${inr(k?.arpu)}`}
              loading={loading && !overview}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Revenue trend — stacked areas */}
            <div className="panel lg:col-span-2">
              <div className="panel-header">
                <p className="panel-title">Revenue Trend — Stacked</p>
                <div className="flex items-center gap-3">
                  <PanelLegend color={BRAND.room} label="Rooms" />
                  <PanelLegend color={BRAND.fnb} label="F&B" />
                  <PanelLegend color={BRAND.misc} label="Misc" />
                </div>
              </div>
              <div className="h-[300px] min-h-[240px] p-4">
                {trendRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trendRows} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                      <defs>
                        {(["room", "fnb", "misc"] as const).map((key) => (
                          <linearGradient key={key} id={`grad-${key}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor={BRAND[key]} stopOpacity={0.45} />
                            <stop offset="100%" stopColor={BRAND[key]} stopOpacity={0.08} />
                          </linearGradient>
                        ))}
                      </defs>
                      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval="preserveStartEnd" />
                      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v) => inr(Number(v))} width={72} />
                      <Tooltip
                        formatter={(v, name) => [inr(Number(v)), String(name)]}
                        contentStyle={TOOLTIP_STYLE}
                        cursor={{ stroke: BRAND.fnb, strokeDasharray: "3 3" }}
                      />
                      <Area type="monotone" dataKey="room" name="Rooms" stackId="rev" stroke={BRAND.room} fill="url(#grad-room)" strokeWidth={2} />
                      <Area type="monotone" dataKey="fnb" name="F&B" stackId="rev" stroke={BRAND.fnb} fill="url(#grad-fnb)" strokeWidth={2} />
                      <Area type="monotone" dataKey="misc" name="Misc" stackId="rev" stroke={BRAND.misc} fill="url(#grad-misc)" strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : loading ? (
                  <SkeletonBlock className="h-full w-full" />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-plaster-deep">
                      <IndianRupee className="h-5 w-5 text-muted-ink" />
                    </div>
                    <p className="text-sm text-muted-ink">No revenue recorded in this range</p>
                  </div>
                )}
              </div>
            </div>

            {/* Funnel — holds → redeemed → paid */}
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Booking Funnel</p>
                <Target className="h-4 w-4 text-brass" />
              </div>
              <div className="space-y-1 p-4">
                {f ? (
                  <>
                    {funnelStages.map((s) => (
                      <div key={s.key}>
                        {s.convFromPrev !== null && (
                          <div className="flex items-center gap-1.5 pl-1 text-[11px] text-muted-ink">
                            <ArrowDownRight className="h-3 w-3 text-brass" />
                            <span className="tabular-nums">{s.convFromPrev}%</span> convert from previous stage
                          </div>
                        )}
                        <div className="py-1.5">
                          <div className="mb-1 flex items-center justify-between text-[13px]">
                            <span className="text-ink">{s.label}</span>
                            <span className="font-semibold tabular-nums text-pine">{s.value}</span>
                          </div>
                          <div className="h-2.5 overflow-hidden rounded-full bg-plaster-deep/60">
                            <div
                              className={cn("h-full rounded-full transition-[width] duration-700 ease-out", s.key === "paid" ? "bg-ok" : s.key === "redeemed" ? "bg-brass" : "bg-pine-700")}
                              style={{ width: `${Math.max(s.widthPct, s.value > 0 ? 2 : 0)}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                    <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
                      <span className="badge border-line-strong bg-plaster text-muted-ink" title="Distinct promo codes on holds + bookings in range">
                        <Ticket className="h-3 w-3" /> {f.promosUsed} promo{f.promosUsed === 1 ? "" : "s"} used
                      </span>
                      <span className="badge border-line-strong bg-plaster text-muted-ink" title="Bookings with upsell add-ons attached">
                        <Zap className="h-3 w-3" /> {f.upsellsAttached} upsell{f.upsellsAttached === 1 ? "" : "s"} attached
                      </span>
                    </div>
                  </>
                ) : (
                  <SkeletonBlock className="h-40 w-full" />
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* Forecast */}
            <div className="panel lg:col-span-2">
              <div className="panel-header">
                <div className="flex items-center gap-2">
                  <p className="panel-title">7-Day Revenue Forecast</p>
                  <span className="badge border-brass/40 bg-brass/10 text-brass">
                    <Zap className="h-3 w-3" /> Estimate — 4-week weekday moving average
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <PanelLegend color={BRAND.pine} label="Actual" />
                  <PanelLegend color={BRAND.fnb} label="Projected" />
                </div>
              </div>
              <div className="h-[300px] min-h-[240px] p-4">
                {forecastRows.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={forecastRows} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
                      <CartesianGrid stroke={GRID_STROKE} strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: GRID_STROKE }} interval="preserveStartEnd" />
                      <YAxis tick={AXIS_TICK} tickLine={false} axisLine={false} tickFormatter={(v) => inr(Number(v))} width={72} />
                      <Tooltip
                        formatter={(v, name) => (v === null || v === undefined ? ["—", String(name)] : [inr(Number(v)), String(name)])}
                        contentStyle={TOOLTIP_STYLE}
                        cursor={{ stroke: BRAND.fnb, strokeDasharray: "3 3" }}
                      />
                      <Line
                        type="monotone"
                        dataKey="actual"
                        name="Actual"
                        stroke={BRAND.pine}
                        strokeWidth={2}
                        dot={{ r: 2.5, fill: BRAND.pine, strokeWidth: 0 }}
                        connectNulls
                      />
                      <Line
                        type="monotone"
                        dataKey="projected"
                        name="Projected"
                        stroke={BRAND.fnb}
                        strokeWidth={2}
                        strokeDasharray="6 4"
                        dot={{ r: 2.5, fill: BRAND.fnb, strokeWidth: 0 }}
                        connectNulls
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <SkeletonBlock className="h-full w-full" />
                )}
              </div>
              {overview && (
                <p className="border-t border-line px-4 py-2 text-[11px] leading-snug text-muted-ink">
                  {overview.forecast.basis} Next 7 days project {inr(overview.forecast.days.reduce((s, d) => s + d.projected, 0))} of revenue.
                </p>
              )}
            </div>

            {/* Segments + top spenders */}
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Guest Segments</p>
                <Users className="h-4 w-4 text-brass" />
              </div>
              <div className="p-4">
                {seg ? (
                  <>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        { label: "New", value: seg.new, icon: UserPlus, hint: "first stay in range", tone: "bg-ok/10 text-ok" },
                        { label: "Repeat", value: seg.repeat, icon: Users, hint: "returning guests", tone: "bg-pine-100 text-pine-700" },
                        { label: "VIP", value: seg.vip, icon: Sparkles, hint: `lifetime ≥ ${inr(seg.vipThreshold)}`, tone: "bg-brass/10 text-brass" },
                        { label: "Lapsed", value: seg.lapsed, icon: Clock, hint: "no stay in 90 days", tone: "bg-warn/10 text-warn" },
                      ].map((tile) => (
                        <div key={tile.label} className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                          <div className="flex items-center justify-between">
                            <p className="text-[11px] uppercase tracking-wider text-muted-ink">{tile.label}</p>
                            <span className={cn("flex h-6 w-6 items-center justify-center rounded-md", tile.tone)}>
                              <tile.icon className="h-3.5 w-3.5" />
                            </span>
                          </div>
                          <p className="font-display text-lg font-semibold text-pine tabular-nums">{tile.value}</p>
                          <p className="text-[10px] text-muted-ink">{tile.hint}</p>
                        </div>
                      ))}
                    </div>

                    <p className="mb-2 mt-4 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">
                      Top spenders · {overview?.from} → {overview?.to}
                    </p>
                    {seg.topSpenders.length > 0 ? (
                      <div className="max-h-72 overflow-y-auto scroll-slim">
                        <table className="w-full">
                          <thead>
                            <tr>
                              <th className="th">Guest</th>
                              <th className="th text-right">Stays</th>
                              <th className="th text-right">Spend</th>
                              <th className="th text-right">Last stay</th>
                            </tr>
                          </thead>
                          <tbody>
                            {seg.topSpenders.map((g) => (
                              <tr key={g.guestId} className="hover:bg-plaster/50">
                                <td className="td max-w-[140px] truncate font-medium text-pine" title={g.name}>{g.name}</td>
                                <td className="td text-right tabular-nums">{g.stays}</td>
                                <td className="td text-right font-semibold text-brass tabular-nums">{inr(g.spend)}</td>
                                <td className="td whitespace-nowrap text-right text-[11px] text-muted-ink">{g.lastStay ? fmtDateShort(g.lastStay) : "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="py-4 text-center text-sm text-muted-ink">No guest folio activity in this range</p>
                    )}
                  </>
                ) : (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      {[0, 1, 2, 3].map((i) => (
                        <SkeletonBlock key={i} className="h-16 w-full" />
                      ))}
                    </div>
                    <SkeletonBlock className="h-40 w-full" />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Channel mix — direct vs OTA */}
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Channel Mix — Direct vs OTA</p>
              <span className="text-xs text-muted-ink">
                {k?.totalBookings ?? 0} bookings · {inr(channelSplit.totalRevenue)} room revenue
              </span>
            </div>
            {overview && overview.channelMix.length > 0 ? (
              <div className="space-y-4 p-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  {[
                    { label: "Direct", meta: channelSplit.direct, color: BRAND.room, hint: "front desk · booking engine · walk-in" },
                    { label: "OTA & Phone", meta: channelSplit.indirect, color: BRAND.fnb, hint: "ota · phone" },
                  ].map((row) => (
                    <div key={row.label} className="rounded-md border border-line bg-plaster/40 p-3">
                      <div className="mb-1.5 flex items-baseline justify-between gap-2">
                        <p className="text-[13px] font-semibold text-pine">{row.label}</p>
                        <p className="text-sm font-semibold tabular-nums text-pine">{row.meta.pct}%</p>
                      </div>
                      <div className="h-2.5 overflow-hidden rounded-full bg-plaster-deep/60">
                        <div
                          className="h-full rounded-full transition-[width] duration-700 ease-out"
                          style={{ width: `${row.meta.pct}%`, background: row.color }}
                        />
                      </div>
                      <p className="mt-1.5 text-[11px] text-muted-ink">
                        {row.meta.bookings} booking{row.meta.bookings === 1 ? "" : "s"} · {inr(row.meta.revenue)} room revenue
                      </p>
                      <p className="text-[10px] text-muted-ink">{row.hint}</p>
                    </div>
                  ))}
                </div>
                {/* Per-source detail */}
                <div className="space-y-2.5">
                  {channelSplit.rows.map((c) => {
                    const share = channelSplit.totalRevenue > 0 ? (c.roomRevenue / channelSplit.totalRevenue) * 100 : 0;
                    const meta = SOURCE_META[c.source];
                    return (
                      <div key={c.source} className="grid grid-cols-[110px_1fr_auto] items-center gap-3 sm:grid-cols-[150px_1fr_auto]">
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium text-pine">{meta?.label ?? c.source.replace(/_/g, " ")}</p>
                          <p className="text-[11px] text-muted-ink">
                            {meta?.direct ? "direct" : "indirect"} · {c.nights} night{c.nights === 1 ? "" : "s"}
                          </p>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-plaster-deep/60">
                          <div
                            className={cn("h-full rounded-full transition-[width] duration-700", meta?.direct ? "bg-pine-700" : "bg-brass")}
                            style={{ width: `${Math.max(share, c.roomRevenue > 0 ? 2 : 0)}%` }}
                          />
                        </div>
                        <div className="whitespace-nowrap text-right">
                          <p className="text-[13px] font-semibold tabular-nums text-pine">{inr(c.roomRevenue)}</p>
                          <p className="text-[11px] tabular-nums text-muted-ink">{share.toFixed(0)}% · ADR {inr(c.adr)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="p-4 text-sm text-muted-ink">{loading ? "Loading channels…" : "No stays recorded in this range."}</div>
            )}
          </div>
        </TabsContent>

        {/* ══ Marketing Studio ══════════════════════════════════════════ */}
        <TabsContent value="marketing" className="space-y-4">
          {/* Summary strip */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <KpiCard icon={Megaphone} label="Active Campaigns" value={String(cSum?.byStatus.active ?? 0)} hint={`${cSum?.total ?? 0} total · ${cSum?.byStatus.draft ?? 0} draft`} loading={loading && !campaignsData} />
            <KpiCard icon={Wallet} label="Total Budget" value={inr(cSum?.totalBudget)} hint={`${inr(cSum?.totalSpent)} spent`} loading={loading && !campaignsData} />
            <KpiCard icon={IndianRupee} label="Attributed Revenue" value={inr(cSum?.attributedRevenue)} hint="Σ campaign revenue" loading={loading && !campaignsData} />
            <KpiCard icon={Percent} label="Avg ROI" value={cSum && cSum.avgRoiPct > 0 ? `${cSum.avgRoiPct}%` : "—"} hint="revenue ÷ spend" loading={loading && !campaignsData} />
          </div>

          {/* Toolbar */}
          <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-2">
              <Megaphone className="h-4 w-4 text-brass" />
              <p className="panel-title">Campaigns</p>
              {cSum && (
                <span className="text-xs text-muted-ink">
                  {cSum.byStatus.active} active · {cSum.byStatus.paused} paused · {cSum.byStatus.completed} completed
                </span>
              )}
            </div>
            <button className="btn-brass" onClick={openCreate}>
              <Rocket className="h-4 w-4" /> New campaign
            </button>
          </div>

          {/* Campaign list */}
          {loading && !campaignsData ? (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <SkeletonBlock key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : campaigns.length === 0 ? (
            /* Empty state */
            <div className="panel">
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-14 text-center">
                <div className="relative flex h-16 w-16 items-center justify-center rounded-full bg-plaster-deep">
                  <span className="absolute inset-0 animate-pulse rounded-full bg-brass/10" />
                  <Megaphone className="h-7 w-7 text-brass" />
                </div>
                <div>
                  <p className="font-display text-lg font-semibold text-pine">Launch your first campaign</p>
                  <p className="mx-auto mt-1 max-w-sm text-sm text-muted-ink">
                    Reach the right guests on WhatsApp, email or promo codes — then track reach, conversions and attributed revenue here.
                  </p>
                </div>
                <button className="btn-brass mt-1" onClick={openCreate}>
                  <Sparkles className="h-4 w-4" /> Create campaign
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Desktop table */}
              <div className="panel hidden overflow-x-auto scroll-slim md:block">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr>
                      <th className="th">Campaign</th>
                      <th className="th">Channel</th>
                      <th className="th">Audience</th>
                      <th className="th">Status</th>
                      <th className="th w-40">Budget vs spent</th>
                      <th className="th text-right">Revenue</th>
                      <th className="th text-right">ROI</th>
                      <th className="th">Dates</th>
                      <th className="th text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((c) => {
                      const meta = channelMeta(c.channel);
                      const roi = roiPct(c.revenue, c.spent);
                      const budgetPct = c.budget > 0 ? Math.min(100, (c.spent / c.budget) * 100) : c.spent > 0 ? 100 : 0;
                      return (
                        <tr key={c.id} className="hover:bg-plaster/50">
                          <td className="td max-w-[220px]">
                            <p className="truncate font-medium text-pine" title={c.name}>{c.name}</p>
                            {c.promoCode && (
                              <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-brass">
                                <Ticket className="h-3 w-3" /> {c.promoCode}
                              </span>
                            )}
                          </td>
                          <td className="td">
                            <span className="flex items-center gap-1.5 text-[13px] text-ink">
                              <meta.icon className="h-3.5 w-3.5 text-brass" /> {meta.label}
                            </span>
                          </td>
                          <td className="td">
                            <span className="badge border-line-strong bg-plaster text-muted-ink">{AUDIENCE_LABELS[c.audience] ?? c.audience}</span>
                          </td>
                          <td className="td">
                            <span className={cn("badge capitalize", STATUS_META[c.status] ?? "border-line-strong bg-plaster text-muted-ink")}>{c.status}</span>
                          </td>
                          <td className="td">
                            <div className="h-2 w-full min-w-[80px] overflow-hidden rounded-full bg-plaster-deep/60">
                              <div className="h-full rounded-full bg-brass transition-[width]" style={{ width: `${budgetPct}%` }} />
                            </div>
                            <p className={cn("mt-1 text-[11px] tabular-nums", c.spent > c.budget && c.budget > 0 ? "text-warn" : "text-muted-ink")}>
                              {inr(c.spent)} / {inr(c.budget)}
                            </p>
                          </td>
                          <td className="td text-right font-semibold tabular-nums text-pine">{inr(c.revenue)}</td>
                          <td className={cn("td text-right font-semibold tabular-nums", roi !== null && roi >= 100 ? "text-ok" : "text-pine")}>
                            {roi === null ? "—" : `${roi}%`}
                          </td>
                          <td className="td whitespace-nowrap text-[11px] text-muted-ink">
                            {c.startsAt ? fmtDate(c.startsAt) : "—"} → {c.endsAt ? fmtDate(c.endsAt) : "—"}
                          </td>
                          <td className="td">
                            <div className="flex items-center justify-end gap-1">
                              {lifecycleActions(c.status).map((a) => (
                                <button key={a.next} className={cn("rounded-md px-2 py-1 text-[11px] font-semibold transition-colors", a.cls)} onClick={() => setStatus(c, a.next)}>
                                  {a.label}
                                </button>
                              ))}
                              <button className="rounded-md px-2 py-1 text-[11px] font-semibold text-pine-700 transition-colors hover:bg-pine-100" onClick={() => openEdit(c)} title="Edit">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button className="rounded-md px-2 py-1 text-[11px] font-semibold text-brass transition-colors hover:bg-brass/10" onClick={() => openResults(c)} title="Record results">
                                <TrendingUp className="h-3.5 w-3.5" />
                              </button>
                              <button className="rounded-md px-2 py-1 text-[11px] font-semibold text-danger transition-colors hover:bg-danger/10" onClick={() => setDeleteFor(c)} title="Delete">
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile cards */}
              <div className="space-y-3 md:hidden">
                {campaigns.map((c) => {
                  const meta = channelMeta(c.channel);
                  const roi = roiPct(c.revenue, c.spent);
                  const budgetPct = c.budget > 0 ? Math.min(100, (c.spent / c.budget) * 100) : c.spent > 0 ? 100 : 0;
                  return (
                    <div key={c.id} className="panel space-y-3 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-medium text-pine">{c.name}</p>
                          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-ink">
                            <span className="flex items-center gap-1">
                              <meta.icon className="h-3 w-3 text-brass" /> {meta.label}
                            </span>
                            <span>· {AUDIENCE_LABELS[c.audience] ?? c.audience}</span>
                            {c.promoCode && <span className="text-brass">· {c.promoCode}</span>}
                          </p>
                        </div>
                        <span className={cn("badge shrink-0 capitalize", STATUS_META[c.status] ?? "border-line-strong bg-plaster text-muted-ink")}>{c.status}</span>
                      </div>
                      <div>
                        <div className="mb-1 flex justify-between text-[11px] text-muted-ink">
                          <span>Budget {inr(c.budget)}</span>
                          <span>Spent {inr(c.spent)}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-full bg-plaster-deep/60">
                          <div className="h-full rounded-full bg-brass" style={{ width: `${budgetPct}%` }} />
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[12px]">
                        <span className="text-muted-ink">Revenue <b className="text-pine">{inr(c.revenue)}</b></span>
                        <span className="text-muted-ink">ROI <b className="text-pine">{roi === null ? "—" : `${roi}%`}</b></span>
                        <span className="text-muted-ink">{c.startsAt ? fmtDateShort(c.startsAt) : "—"} → {c.endsAt ? fmtDateShort(c.endsAt) : "—"}</span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-line pt-2.5">
                        {lifecycleActions(c.status).map((a) => (
                          <button key={a.next} className={cn("rounded-md px-2.5 py-1.5 text-[12px] font-semibold transition-colors", a.cls)} onClick={() => setStatus(c, a.next)}>
                            {a.label}
                          </button>
                        ))}
                        <span className="flex-1" />
                        <button className="btn-ghost h-8 px-2 text-pine-700" onClick={() => openEdit(c)} title="Edit">
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button className="btn-ghost h-8 px-2 text-brass" onClick={() => openResults(c)} title="Record results">
                          <TrendingUp className="h-3.5 w-3.5" />
                        </button>
                        <button className="btn-ghost h-8 px-2 text-danger" onClick={() => setDeleteFor(c)} title="Delete">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      {/* ── New / Edit campaign dialog ─────────────────────────────────── */}
      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">{editing ? "Edit campaign" : "New campaign"}</DialogTitle>
            <DialogDescription>
              {editing ? "Update the campaign setup — lifecycle and results are managed from the list." : "Campaigns start in draft — activate when ready and record results as they run."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="camp-name">Name</Label>
              <Input
                id="camp-name"
                value={form.name}
                maxLength={120}
                placeholder="Diwali direct-booking push"
                onChange={(e) => setForm((s) => ({ ...s, name: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Channel</Label>
                <Select value={form.channel} onValueChange={(v) => setForm((s) => ({ ...s, channel: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(CHANNEL_META).map(([value, meta]) => (
                      <SelectItem key={value} value={value}>
                        <span className="flex items-center gap-2">
                          <meta.icon className="h-3.5 w-3.5" /> {meta.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Audience</Label>
                <Select value={form.audience} onValueChange={(v) => setForm((s) => ({ ...s, audience: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
                      <SelectItem key={value} value={value}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Promo code (optional)</Label>
                <Select
                  value={form.promoCode || "none"}
                  onValueChange={(v) => setForm((s) => ({ ...s, promoCode: v === "none" ? "" : v }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No promo code</SelectItem>
                    {promoOptions.map((p) => (
                      <SelectItem key={p.code} value={p.code} disabled={!p.active}>
                        {p.code} · {p.discountType === "percent" ? `${p.discountValue}%` : inr(p.discountValue)} off · {p.usedCount}/{p.maxUses} used
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {promoOptions.length === 0 && (
                  <p className="text-[11px] text-muted-ink">No promo codes yet — create them in Booking Engine → Promos.</p>
                )}
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="camp-budget">Budget (₹)</Label>
                <Input
                  id="camp-budget"
                  type="number"
                  min={0}
                  value={form.budget}
                  placeholder="10000"
                  onChange={(e) => setForm((s) => ({ ...s, budget: e.target.value }))}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="camp-start">Start date</Label>
                <Input id="camp-start" type="date" value={form.startsAt} onChange={(e) => setForm((s) => ({ ...s, startsAt: e.target.value }))} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="camp-end">End date</Label>
                <Input id="camp-end" type="date" value={form.endsAt} min={form.startsAt || undefined} onChange={(e) => setForm((s) => ({ ...s, endsAt: e.target.value }))} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="camp-notes">Notes</Label>
              <Textarea
                id="camp-notes"
                rows={2}
                value={form.notes}
                placeholder="Creative, target list, follow-up plan…"
                onChange={(e) => setForm((s) => ({ ...s, notes: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFormOpen(false)} disabled={saving}>Cancel</Button>
            <Button onClick={submitForm} disabled={saving} className="bg-brass text-white hover:bg-brass/90">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Save changes" : "Create campaign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Record results dialog ──────────────────────────────────────── */}
      <Dialog open={resultsFor !== null} onOpenChange={(open) => !open && setResultsFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Record results</DialogTitle>
            <DialogDescription>
              Actuals for “{resultsFor?.name}” — used for ROI and the marketing summary.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="res-reach">Reach (people contacted)</Label>
              <Input id="res-reach" type="number" min={0} value={results.reach} onChange={(e) => setResults((s) => ({ ...s, reach: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-conv">Conversions (bookings)</Label>
              <Input id="res-conv" type="number" min={0} value={results.conversions} onChange={(e) => setResults((s) => ({ ...s, conversions: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-rev">Attributed revenue (₹)</Label>
              <Input id="res-rev" type="number" min={0} value={results.revenue} onChange={(e) => setResults((s) => ({ ...s, revenue: e.target.value }))} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="res-spent">Spent (₹)</Label>
              <Input id="res-spent" type="number" min={0} value={results.spent} onChange={(e) => setResults((s) => ({ ...s, spent: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResultsFor(null)} disabled={saving}>Cancel</Button>
            <Button onClick={submitResults} disabled={saving} className="bg-brass text-white hover:bg-brass/90">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save results
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirm dialog ──────────────────────────────────────── */}
      <Dialog open={deleteFor !== null} onOpenChange={(open) => !open && setDeleteFor(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Delete campaign?</DialogTitle>
            <DialogDescription>
              “{deleteFor?.name}” and its recorded results will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteFor(null)} disabled={deleting}>Cancel</Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting && <Loader2 className="h-4 w-4 animate-spin" />} Delete campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
