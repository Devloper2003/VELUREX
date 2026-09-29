"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Cell, Line, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  Building2, CheckCircle2, Megaphone, Package, ReceiptIndianRupee, UserPlus,
  Wallet, Globe2, LifeBuoy, ShieldAlert, ArrowRight, CreditCard, TrendingUp,
  RefreshCw, Inbox,
} from "lucide-react";
import { EmptyState, ErrorState, Loading, SeverityChip, StatCard, inr, useOwnerApi, usePolling } from "@/components/owner/shared";
import { useOwner, type OwnerViewKey } from "@/lib/owner-store";

interface OverviewStats {
  totalBusinesses: number;
  active: number;
  trial: number;
  suspended: number;
  overdue: number;
  mrr: number;
  arr: number;
  newThisMonth: number;
}

interface OverviewAlert {
  kind: string;
  severity: "info" | "warn" | "danger";
  text: string;
}

interface OverviewData {
  stats: OverviewStats;
  revenueTrend: { month: string; revenue: number }[];
  planMix: { code: string; name: string; price: number; count: number }[];
  alerts: OverviewAlert[];
  openTickets: number;
}

const AXIS_TICK = { fill: "#7a6f5d", fontSize: 11 };
const TIP_STYLE = { background: "#FBF8F2", border: "1px solid #E3D7C1", borderRadius: 8, fontSize: 12, padding: "6px 10px" };
const TIP_LABEL = { color: "#0F2622", fontWeight: 600, marginBottom: 2 };

/** Donut palette per plan code (falls through for custom plans). */
const PLAN_COLORS = ["#B9873E", "#1F4B43", "#D9B779", "#4C7A5A", "#A44534", "#7A6F5D"];

/** Compact ₹ axis labels: 1.2L, 3Cr, 48k. */
function compact(n: number): string {
  if (Math.abs(n) >= 10000000) return `${(n / 10000000).toFixed(n % 10000000 === 0 ? 0 : 1)}Cr`;
  if (Math.abs(n) >= 100000) return `${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

/** Alert kind → the tab that resolves it. */
const ALERT_VIEW: Record<string, OwnerViewKey> = {
  renewal: "subscriptions",
  overdue: "billing",
  ota: "integrations",
  ticket: "tickets",
  queue: "integrations",
};

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

export default function DashboardView() {
  const api = useOwnerApi();
  const setView = useOwner((s) => s.setView);
  const [data, setData] = useState<OverviewData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<OverviewData>("/api/owner/overview");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load platform overview");
    }
  }, [api]);

  // Initial load — promise chain (not a setState-containing fn handed to useEffect directly).
  useEffect(() => {
    let alive = true;
    api<OverviewData>("/api/owner/overview")
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load platform overview");
      });
    return () => {
      alive = false;
    };
  }, [api]);
  usePolling(load, 60000);

  const stats = data?.stats;
  const trend = data?.revenueTrend ?? [];
  const planMix = data?.planMix ?? [];
  const alerts = data?.alerts ?? [];
  const total12m = trend.reduce((s, t) => s + (t.revenue ?? 0), 0);
  const maxCount = Math.max(1, ...planMix.map((p) => p.count ?? 0));
  const totalTenants = planMix.reduce((s, p) => s + (p.count ?? 0), 0);

  // Cumulative collection curve (derived client-side — no API change). Pure scan, n = 12.
  const trendWithCum = useMemo(
    () =>
      trend.map((t, i) => ({
        ...t,
        cumulative: trend.slice(0, i + 1).reduce((s, x) => s + (x.revenue ?? 0), 0),
      })),
    [trend]
  );

  const donutData = useMemo(
    () => planMix.filter((p) => (p.count ?? 0) > 0).map((p) => ({ name: p.name, value: p.count ?? 0, price: p.price })),
    [planMix]
  );

  const quickActions: { label: string; hint: string; icon: React.ComponentType<{ className?: string }>; view: "add-business" | "billing" | "announcements" }[] = [
    { label: "Add Business", hint: "Onboard a hotel with trial + checklist", icon: UserPlus, view: "add-business" },
    { label: "Create Invoice", hint: "Manual GST invoice for a tenant", icon: ReceiptIndianRupee, view: "billing" },
    { label: "Send Announcement", hint: "Banner to all or one audience", icon: Megaphone, view: "announcements" },
  ];

  return (
    <div className="space-y-4">
      {!error && !data && (
        <div className="panel">
          <Loading label="Loading platform overview…" />
        </div>
      )}
      {error && !data && (
        <div className="panel">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}

      {data && stats && (
        <>
          {error && (
            <div className="panel border-warn/50 bg-warn/10 px-4 py-2.5 text-[13px] text-warn flex items-center gap-2">
              <RefreshCw className="h-3.5 w-3.5 shrink-0" />
              Live refresh failed ({error}) — showing the last loaded snapshot. Retrying every 60s.
            </div>
          )}

          {/* Hero band */}
          <div className="pine-texture bg-pine rounded-lg text-panel px-5 py-5 sm:px-6 relative overflow-hidden">
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="font-script text-brass-light text-3xl leading-none">{greeting()}, Owner</p>
                <h2 className="font-display text-xl font-semibold tracking-tight mt-2">
                  Velurex HMS <span className="text-brass-light">·</span> Platform Overview
                </h2>
                <p className="text-[12px] text-panel/60 mt-1">
                  {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "long", year: "numeric" })}
                  {" · "}everything below is live data from your tenants
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="badge border-brass/40 bg-brass/15 text-brass-light">
                  <Building2 className="h-3 w-3" /> {stats.totalBusinesses ?? 0} businesses
                </span>
                <span className="badge border-panel/20 bg-panel/10 text-panel/80">
                  <LifeBuoy className="h-3 w-3" /> {data.openTickets ?? 0} open tickets
                </span>
              </div>
            </div>
          </div>

          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            <StatCard label="Total Businesses" value={String(stats.totalBusinesses ?? 0)} sub={`+${stats.newThisMonth ?? 0} onboarded this month`} icon={Building2} tone="brass" onClick={() => setView("businesses")} />
            <StatCard label="Active" value={String(stats.active ?? 0)} sub={`of ${stats.totalBusinesses ?? 0} businesses`} icon={CheckCircle2} tone="ok" onClick={() => setView("businesses")} />
            <StatCard label="Trials" value={String(stats.trial ?? 0)} sub="in trial period" icon={Globe2} tone="pine" onClick={() => setView("subscriptions")} />
            <StatCard
              label="Overdue / Suspended"
              value={String((stats.overdue ?? 0) + (stats.suspended ?? 0))}
              sub={`${stats.overdue ?? 0} overdue · ${stats.suspended ?? 0} suspended`}
              icon={ShieldAlert}
              tone="danger"
              valueClass={(stats.overdue ?? 0) + (stats.suspended ?? 0) > 0 ? "text-danger" : ""}
              onClick={() => setView("billing")}
            />
            <StatCard label="MRR" value={inr(stats.mrr ?? 0)} sub="monthly recurring revenue" icon={Wallet} tone="brass" valueClass="text-brass" onClick={() => setView("analytics")} />
            <StatCard label="ARR" value={inr(stats.arr ?? 0)} sub="12 × MRR run-rate" icon={TrendingUp} tone="pine" onClick={() => setView("analytics")} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Left: revenue + plan mix */}
            <div className="lg:col-span-2 space-y-4">
              <div className="panel">
                <div className="panel-header">
                  <div>
                    <p className="panel-title">Revenue trend</p>
                    <p className="text-[11px] text-muted-ink mt-0.5">{inr(total12m)} collected · last 12 months</p>
                  </div>
                  <div className="flex items-center gap-3 text-[10px] text-muted-ink">
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-brass" aria-hidden /> Monthly</span>
                    <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm bg-pine-700" aria-hidden /> Cumulative</span>
                  </div>
                </div>
                <div className="p-4 pt-3">
                  {trend.length > 0 ? (
                    <ResponsiveContainer width="100%" height={230}>
                      <AreaChart data={trendWithCum} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#B9873E" stopOpacity={0.32} />
                            <stop offset="100%" stopColor="#B9873E" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="#0F2622" strokeOpacity={0.07} vertical={false} strokeDasharray="4 4" />
                        <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={48} tickFormatter={(v) => compact(Number(v))} />
                        <Tooltip
                          contentStyle={TIP_STYLE}
                          labelStyle={TIP_LABEL}
                          itemStyle={{ color: "#26302C" }}
                          formatter={(value, name) => [inr(Number(value)), String(name)]}
                        />
                        <Area type="monotone" dataKey="revenue" name="Monthly" stroke="#B9873E" strokeWidth={2} fill="url(#revGrad)" />
                        <Line type="monotone" dataKey="cumulative" name="Cumulative" stroke="#1F4B43" strokeWidth={1.6} strokeDasharray="5 4" dot={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : (
                    <EmptyState icon={ReceiptIndianRupee} title="No revenue recorded yet" hint="Collections appear here as tenant invoices are paid." />
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <p className="panel-title">Plan mix</p>
                  <p className="text-[11px] text-muted-ink">{totalTenants} subscribed tenant{totalTenants === 1 ? "" : "s"} across plans</p>
                </div>
                <div className="p-4 grid grid-cols-1 sm:grid-cols-[190px_1fr] gap-4 items-center">
                  {donutData.length > 0 ? (
                    <>
                      <div className="relative h-[170px]">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={donutData}
                              dataKey="value"
                              nameKey="name"
                              innerRadius={52}
                              outerRadius={76}
                              paddingAngle={3}
                              strokeWidth={0}
                            >
                              {donutData.map((entry, i) => (
                                <Cell key={entry.name} fill={PLAN_COLORS[i % PLAN_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={TIP_STYLE}
                              labelStyle={TIP_LABEL}
                              formatter={(value, name) => [`${value} tenant${Number(value) === 1 ? "" : "s"}`, String(name)]}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none" aria-hidden>
                          <p className="font-display text-2xl font-semibold text-pine leading-none">{totalTenants}</p>
                          <p className="text-[10px] uppercase tracking-wider text-muted-ink mt-1">tenants</p>
                        </div>
                      </div>
                      <div className="space-y-3">
                        {planMix.map((p, i) => (
                          <div key={p.code}>
                            <div className="flex items-baseline justify-between gap-2 text-xs">
                              <span className="flex items-center gap-2 font-medium text-pine">
                                <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ background: PLAN_COLORS[i % PLAN_COLORS.length] }} aria-hidden />
                                {p.name}
                              </span>
                              <span className="text-muted-ink">
                                {p.count} tenant{p.count === 1 ? "" : "s"} · {inr(p.price)}/mo
                              </span>
                            </div>
                            <div className="mt-1 h-2 rounded-full bg-plaster-deep/60 overflow-hidden">
                              <div className="h-2 rounded-full bar-grow" style={{ width: `${((p.count ?? 0) / maxCount) * 100}%`, background: PLAN_COLORS[i % PLAN_COLORS.length] }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="sm:col-span-2">
                      <EmptyState icon={Package} title="No plans configured" hint="Create plans to see the subscription mix." />
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Right: alerts + quick actions */}
            <div className="space-y-4">
              <div className="panel">
                <div className="panel-header">
                  <p className="panel-title">Alerts</p>
                  {(data.openTickets ?? 0) > 0 && (
                    <span className="badge border-danger/40 bg-danger/10 text-danger">
                      {data.openTickets} open ticket{data.openTickets === 1 ? "" : "s"}
                    </span>
                  )}
                </div>
                <div className="p-2.5 space-y-1 max-h-72 overflow-y-auto scroll-slim">
                  {alerts.length > 0 ? (
                    alerts.map((a, i) => {
                      const target = ALERT_VIEW[a.kind];
                      const body = (
                        <>
                          <div className="flex items-start justify-between gap-2 w-full">
                            <p className="text-[13px] text-ink leading-snug flex-1 min-w-0">{a.text}</p>
                            <SeverityChip severity={a.severity} kind={a.kind} />
                          </div>
                          {target && (
                            <span className="flex items-center gap-1 text-[10.5px] font-medium text-brass mt-1">
                              Resolve in {VIEW_LABELS[target]} <ArrowRight className="h-3 w-3" />
                            </span>
                          )}
                        </>
                      );
                      return target ? (
                        <button
                          key={`${a.kind}-${i}`}
                          onClick={() => setView(target)}
                          className="w-full text-left flex flex-col rounded-md px-2.5 py-2 hover:bg-brass-50/70 transition"
                        >
                          {body}
                        </button>
                      ) : (
                        <div key={`${a.kind}-${i}`} className="flex flex-col rounded-md px-2.5 py-2 hover:bg-plaster/60 transition">
                          {body}
                        </div>
                      );
                    })
                  ) : (
                    <EmptyState icon={CheckCircle2} title="All clear" hint="No renewals, payments or sync issues need attention." />
                  )}
                </div>
              </div>

              <div className="panel">
                <div className="panel-header">
                  <p className="panel-title">Quick actions</p>
                  <Inbox className="h-4 w-4 text-muted-ink/60" aria-hidden />
                </div>
                <div className="p-3 grid gap-2">
                  {quickActions.map((a) => (
                    <button
                      key={a.view}
                      className="group w-full flex items-center gap-3 rounded-md border border-line bg-panel px-3 py-2.5 text-left hover:border-brass/50 hover:bg-brass-50/50 transition"
                      onClick={() => setView(a.view)}
                    >
                      <span className="icon-chip h-8 w-8 group-hover:scale-105 transition-transform">
                        <a.icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-pine">{a.label}</span>
                        <span className="block text-[11px] text-muted-ink truncate">{a.hint}</span>
                      </span>
                      <ArrowRight className="h-3.5 w-3.5 text-muted-ink group-hover:text-brass group-hover:translate-x-0.5 transition" />
                    </button>
                  ))}
                </div>
              </div>

              {/* Subscription nudge card */}
              <div className="panel border-brass/30 bg-gradient-to-br from-brass-50/80 to-panel px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <span className="icon-chip"><CreditCard className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <p className="font-display text-[14px] font-semibold text-pine">Plans are pure data</p>
                    <p className="text-[11.5px] text-muted-ink mt-0.5 leading-relaxed">
                      Limits &amp; features live in each plan&apos;s features JSON — edit them anytime, enforcement updates instantly for every tenant.
                    </p>
                    <button className="btn-brass h-7 text-[12px] mt-2.5" onClick={() => setView("subscriptions")}>
                      Manage plans &amp; subscriptions
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

const VIEW_LABELS: Record<OwnerViewKey, string> = {
  dashboard: "Dashboard",
  analytics: "Analytics",
  businesses: "Businesses",
  "add-business": "Add Business",
  users: "Users",
  onboarding: "Onboarding",
  subscriptions: "Subscriptions",
  billing: "Billing",
  coupons: "Coupons",
  tickets: "Support Tickets",
  announcements: "Announcements",
  audit: "Audit Logs",
  integrations: "Integrations",
  settings: "Platform Settings",
  health: "System Health",
  team: "Team & Roles",
};
