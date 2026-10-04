"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { AlertTriangle, Building2, Globe2, Layers, Package, RefreshCw, TrendingUp, Users } from "lucide-react";
import { EmptyState, ErrorState, Loading, StatCard, inr, useOwnerApi } from "@/components/owner/shared";

interface AnalyticsKpis {
  mrr: number;
  arr: number;
  churnRate: number;
  arpu: number;
  ltv: number;
  lifetimeMonths: number;
  trialConversion: number;
  activeCount: number;
  cancelledCount: number;
}

interface AnalyticsData {
  kpis: AnalyticsKpis;
  mrrTrend: { month: string; mrr: number }[];
  planDistribution: { name: string; code: string; price: number; count: number }[];
  moduleUsage: { module: string; tenants: number }[];
  citySplit: { city: string; count: number }[];
  stateSplit: { state: string; count: number }[];
  /** Platform-growth extension (Task 35-c) — optional so old payloads still render. */
  growth?: GrowthExtension;
}

interface GrowthExtension {
  mrrBasis: string;
  mrrTrend: { month: string; mrr: number }[];
  signupsTrend: { month: string; count: number }[];
  gmvTrend: { month: string; gmv: number; bookings: number }[];
  topBusinesses: { propertyId: string; name: string; revenue: number; bookings: number; plan: string }[];
  planMix: { planCode: string; count: number }[];
  retention: {
    active: number;
    trial: number;
    overdue: number;
    suspended: number;
    cancelled: number;
    trialsExpiring7d: number;
  };
}

const DONUT = ["#0F2622", "#B9873E", "#2A5D54", "#D9B779", "#4C7A5A", "#C08A2E", "#A44534", "#7EA08C"];
/** Plan-mix palette — pine / brass / sage / plaster tones (Task 35-c). */
const PLAN_MIX = ["#0F2622", "#B9873E", "#4C7A5A", "#C9BBA4", "#7EA08C", "#C08A2E", "#A44534"];
const AXIS_TICK = { fill: "#7a6f5d", fontSize: 11 };
const TIP_STYLE = { background: "#FBF8F2", border: "1px solid #E3D7C1", borderRadius: 8, fontSize: 12, padding: "6px 10px" };
const TIP_LABEL = { color: "#0F2622", fontWeight: 600, marginBottom: 2 };

function compact(n: number): string {
  if (Math.abs(n) >= 10000000) return `${(n / 10000000).toFixed(n % 10000000 === 0 ? 0 : 1)}Cr`;
  if (Math.abs(n) >= 100000) return `${(n / 100000).toFixed(n % 100000 === 0 ? 0 : 1)}L`;
  if (Math.abs(n) >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function GeoRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1 text-[13px]">
      <span className="truncate text-ink">{label}</span>
      <span className="badge shrink-0 border-line-strong bg-plaster text-muted-ink">{count}</span>
    </div>
  );
}

/** Month key "2026-02" → "Feb '26" for chart axes. */
function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const idx = Number(m) - 1;
  return names[idx] ? `${names[idx]} '${y.slice(2)}` : key;
}

/** Retention badge — count + label with the shared status tone. */
function RetentionBadge({ label, count, tone }: { label: string; count: number; tone: string }) {
  return (
    <span className={`badge ${tone}`}>
      {label}
      <span className="ml-0.5 font-bold tabular-nums">{count}</span>
    </span>
  );
}

export default function AnalyticsView() {
  const api = useOwnerApi();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api<AnalyticsData>("/api/owner/analytics");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics");
    }
  }, [api]);

  // Initial load — promise chain (not a setState-containing fn handed to useEffect directly).
  useEffect(() => {
    let alive = true;
    api<AnalyticsData>("/api/owner/analytics")
      .then((d) => {
        if (alive) {
          setData(d);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load analytics");
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const k = data?.kpis;
  const mrrTrend = data?.mrrTrend ?? [];
  const dist = data?.planDistribution ?? [];
  const moduleUsage = data?.moduleUsage ?? [];
  const citySplit = data?.citySplit ?? [];
  const stateSplit = data?.stateSplit ?? [];

  // ── Platform growth extension (Task 35-c) ──
  const growth = data?.growth;
  const gMrr = (growth?.mrrTrend ?? []).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const gSignups = (growth?.signupsTrend ?? []).map((s) => ({ ...s, label: monthLabel(s.month) }));
  const gGmv = (growth?.gmvTrend ?? []).map((g) => ({ ...g, label: monthLabel(g.month) }));
  const gPlanMix = growth?.planMix ?? [];
  const gTop = growth?.topBusinesses ?? [];
  const gRetention = growth?.retention;
  const gMrrHasData = gMrr.some((m) => m.mrr > 0);
  const gSignupsHasData = gSignups.some((s) => s.count > 0);
  const gGmvHasData = gGmv.some((g) => g.gmv > 0 || g.bookings > 0);
  const maxMod = Math.max(1, ...moduleUsage.map((m) => m.tenants ?? 0));
  const donutHasData = dist.some((d) => (d.count ?? 0) > 0);

  const kpis: { label: string; value: string; sub: string; valueClass?: string }[] = k
    ? [
        { label: "MRR", value: inr(k.mrr ?? 0), sub: `${k.activeCount ?? 0} active subscriptions`, valueClass: "text-brass" },
        { label: "ARR", value: inr(k.arr ?? 0), sub: "12 × MRR run-rate" },
        {
          label: "Churn",
          value: `${k.churnRate ?? 0}%`,
          sub: `${k.cancelledCount ?? 0} cancellations tracked`,
          valueClass: (k.churnRate ?? 0) > 5 ? "text-danger" : undefined,
        },
        { label: "ARPU", value: inr(k.arpu ?? 0), sub: "per active tenant / mo" },
        { label: "Est. LTV", value: inr(k.ltv ?? 0), sub: `${k.lifetimeMonths ?? 24}-month avg lifetime` },
        { label: "Trial conversion", value: `${k.trialConversion ?? 0}%`, sub: "trial → paid plans" },
      ]
    : [];

  return (
    <div className="space-y-4">
      {!error && !data && (
        <div className="panel">
          <Loading label="Crunching growth analytics…" />
        </div>
      )}
      {error && !data && (
        <div className="panel">
          <ErrorState message={error} onRetry={() => void load()} />
        </div>
      )}

      {data && k && (
        <>
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {kpis.map((c) => (
              <StatCard key={c.label} label={c.label} value={c.value} sub={c.sub} valueClass={c.valueClass} />
            ))}
          </div>

          {/* MRR growth */}
          <div className="panel">
            <div className="panel-header">
              <div>
                <p className="panel-title">MRR growth</p>
                <p className="text-[11px] text-muted-ink mt-0.5">Monthly recurring revenue · last 12 months</p>
              </div>
              <button className="btn-ghost h-8" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
            </div>
            <div className="p-4 pt-3">
              {mrrTrend.length > 0 ? (
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={mrrTrend} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <XAxis dataKey="month" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                    <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => compact(Number(v))} />
                    <Tooltip
                      contentStyle={TIP_STYLE}
                      labelStyle={TIP_LABEL}
                      itemStyle={{ color: "#26302C" }}
                      formatter={(value) => inr(Number(value))}
                    />
                    <Line
                      type="monotone"
                      dataKey="mrr"
                      name="MRR"
                      stroke="#B9873E"
                      strokeWidth={2}
                      dot={{ r: 2.5, fill: "#B9873E", strokeWidth: 0 }}
                      activeDot={{ r: 4, fill: "#0F2622" }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              ) : (
                <EmptyState icon={Layers} title="No MRR history yet" hint="The trend builds as subscriptions run their first months." />
              )}
            </div>
          </div>

          {/* 3-col: plan donut · module usage · geo split */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Plan distribution</p>
                <p className="text-[11px] text-muted-ink">by live subscriptions</p>
              </div>
              <div className="p-4 pt-2">
                {donutHasData ? (
                  <>
                    <ResponsiveContainer width="100%" height={180}>
                      <PieChart>
                        <Pie
                          data={dist}
                          dataKey="count"
                          nameKey="name"
                          innerRadius={52}
                          outerRadius={80}
                          paddingAngle={2}
                          stroke="#FBF8F2"
                          strokeWidth={2}
                        >
                          {dist.map((d, i) => (
                            <Cell key={d.code ?? d.name} fill={DONUT[i % DONUT.length]} />
                          ))}
                        </Pie>
                        <Tooltip
                          contentStyle={TIP_STYLE}
                          labelStyle={TIP_LABEL}
                          itemStyle={{ color: "#26302C" }}
                          formatter={(value) => `${value} tenant${Number(value) === 1 ? "" : "s"}`}
                        />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="mt-2 space-y-1.5">
                      {dist.map((d, i) => (
                        <div key={d.code ?? d.name} className="flex items-center gap-2 text-xs">
                          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: DONUT[i % DONUT.length] }} />
                          <span className="flex-1 truncate font-medium text-pine">{d.name}</span>
                          <span className="text-muted-ink">
                            {d.count} · {inr(d.price)}/mo
                          </span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : (
                  <EmptyState icon={Package} title="No plan data" hint="Distribution appears once businesses subscribe to plans." />
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Module usage</p>
                <p className="text-[11px] text-muted-ink">tenants actively using</p>
              </div>
              <div className="p-4 space-y-3">
                {moduleUsage.length > 0 ? (
                  moduleUsage.map((m) => (
                    <div key={m.module}>
                      <div className="flex items-baseline justify-between gap-2 text-xs">
                        <span className="truncate pr-2 font-medium text-pine">{m.module}</span>
                        <span className="shrink-0 text-muted-ink">
                          {m.tenants} tenant{m.tenants === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="mt-1 h-2 rounded-full bg-plaster-deep/60">
                        <div className="h-2 rounded-full bg-pine-700 transition-all" style={{ width: `${((m.tenants ?? 0) / maxMod) * 100}%` }} />
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState icon={Layers} title="No usage signals" hint="Module adoption appears after tenants go live." />
                )}
              </div>
            </div>

            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Geo split</p>
                <p className="text-[11px] text-muted-ink">where tenants operate</p>
              </div>
              <div className="p-4 pt-2 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Cities</p>
                  <div className="max-h-56 overflow-y-auto scroll-slim pr-1">
                    {citySplit.length > 0 ? (
                      citySplit.map((c) => <GeoRow key={c.city} label={c.city} count={c.count} />)
                    ) : (
                      <p className="py-2 text-xs text-muted-ink">No cities recorded.</p>
                    )}
                  </div>
                </div>
                <div>
                  <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">States</p>
                  <div className="max-h-56 overflow-y-auto scroll-slim pr-1">
                    {stateSplit.length > 0 ? (
                      stateSplit.map((s) => <GeoRow key={s.state} label={s.state} count={s.count} />)
                    ) : (
                      <p className="py-2 text-xs text-muted-ink">No states recorded.</p>
                    )}
                  </div>
                </div>
              </div>
              <div className="border-t border-line px-4 py-2.5 flex items-center gap-2 text-[11px] text-muted-ink">
                <Globe2 className="h-3.5 w-3.5 text-brass" />
                {citySplit.length} cit{citySplit.length === 1 ? "y" : "ies"} · {stateSplit.length} state{stateSplit.length === 1 ? "" : "s"} across the footprint
              </div>
            </div>
          </div>

          {/* ── Platform Growth (Task 35-c) ─────────────────────────────── */}
          {growth && gRetention && (
            <div className="space-y-4">
              {/* Retention badge strip */}
              <div className="panel flex flex-wrap items-center gap-2 px-4 py-3">
                <p className="mr-1 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Retention</p>
                <RetentionBadge label="Active" count={gRetention.active} tone="border-ok/40 bg-ok/10 text-ok" />
                <RetentionBadge label="Trial" count={gRetention.trial} tone="border-brass/40 bg-brass/10 text-brass" />
                <RetentionBadge label="Overdue" count={gRetention.overdue} tone="border-warn/50 bg-warn/10 text-warn" />
                <RetentionBadge label="Suspended" count={gRetention.suspended} tone="border-danger/40 bg-danger/10 text-danger" />
                <RetentionBadge label="Cancelled" count={gRetention.cancelled} tone="border-line-strong bg-plaster text-muted-ink" />
                {gRetention.trialsExpiring7d > 0 && (
                  <span className="badge border-warn/50 bg-warn/10 text-warn" title="Trials ending within 7 days">
                    <AlertTriangle className="h-3 w-3" />
                    {gRetention.trialsExpiring7d} trial{gRetention.trialsExpiring7d === 1 ? "" : "s"} expiring in 7d
                  </span>
                )}
              </div>

              {/* MRR trend + signups */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <p className="panel-title">MRR — billed</p>
                      <p className="text-[11px] text-muted-ink mt-0.5">last 12 months · {growth.mrrBasis}</p>
                    </div>
                    <TrendingUp className="h-4 w-4 text-brass" />
                  </div>
                  <div className="p-4 pt-3">
                    {gMrrHasData ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <LineChart data={gMrr} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#E3D7C1" strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => compact(Number(v))} />
                          <Tooltip
                            contentStyle={TIP_STYLE}
                            labelStyle={TIP_LABEL}
                            itemStyle={{ color: "#26302C" }}
                            formatter={(value) => inr(Number(value))}
                          />
                          <Line
                            type="monotone"
                            dataKey="mrr"
                            name="MRR"
                            stroke="#B9873E"
                            strokeWidth={2}
                            dot={{ r: 2.5, fill: "#B9873E", strokeWidth: 0 }}
                            activeDot={{ r: 4, fill: "#0F2622" }}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState icon={Layers} title="No billed revenue yet" hint="The trend builds once subscription invoices are raised." />
                    )}
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-header">
                    <div>
                      <p className="panel-title">New businesses</p>
                      <p className="text-[11px] text-muted-ink mt-0.5">signups per month · demo &amp; deleted excluded</p>
                    </div>
                    <Users className="h-4 w-4 text-brass" />
                  </div>
                  <div className="p-4 pt-3">
                    {gSignupsHasData ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={gSignups} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#E3D7C1" strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
                          <Tooltip
                            contentStyle={TIP_STYLE}
                            labelStyle={TIP_LABEL}
                            itemStyle={{ color: "#26302C" }}
                            formatter={(value) => `${value} signup${Number(value) === 1 ? "" : "s"}`}
                            cursor={{ fill: "rgba(185,135,62,0.08)" }}
                          />
                          <Bar dataKey="count" name="Signups" fill="#0F2622" radius={[3, 3, 0, 0]} maxBarSize={36} />
                        </BarChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState icon={Users} title="No signups in the last 12 months" hint="New businesses appear here as they onboard." />
                    )}
                  </div>
                </div>
              </div>

              {/* Plan mix + GMV */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <div className="panel">
                  <div className="panel-header">
                    <p className="panel-title">Plan mix</p>
                    <p className="text-[11px] text-muted-ink">all subscriptions by plan</p>
                  </div>
                  <div className="p-4 pt-2">
                    {gPlanMix.length > 0 ? (
                      <>
                        <ResponsiveContainer width="100%" height={180}>
                          <PieChart>
                            <Pie data={gPlanMix} dataKey="count" nameKey="planCode" innerRadius={52} outerRadius={80} paddingAngle={2} stroke="#FBF8F2" strokeWidth={2}>
                              {gPlanMix.map((d, i) => (
                                <Cell key={d.planCode} fill={PLAN_MIX[i % PLAN_MIX.length]} />
                              ))}
                            </Pie>
                            <Tooltip
                              contentStyle={TIP_STYLE}
                              labelStyle={TIP_LABEL}
                              itemStyle={{ color: "#26302C" }}
                              formatter={(value) => `${value} subscription${Number(value) === 1 ? "" : "s"}`}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="mt-2 space-y-1.5">
                          {gPlanMix.map((d, i) => (
                            <div key={d.planCode} className="flex items-center gap-2 text-xs">
                              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PLAN_MIX[i % PLAN_MIX.length] }} />
                              <span className="flex-1 truncate font-medium text-pine uppercase">{d.planCode}</span>
                              <span className="text-muted-ink">{d.count}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <EmptyState icon={Package} title="No subscriptions yet" hint="Plan mix appears once businesses subscribe." />
                    )}
                  </div>
                </div>

                <div className="panel lg:col-span-2">
                  <div className="panel-header">
                    <div>
                      <p className="panel-title">Tenant GMV</p>
                      <p className="text-[11px] text-muted-ink mt-0.5">booked value (non-cancelled) + bookings per month</p>
                    </div>
                    <Building2 className="h-4 w-4 text-brass" />
                  </div>
                  <div className="p-4 pt-3">
                    {gGmvHasData ? (
                      <ResponsiveContainer width="100%" height={220}>
                        <ComposedChart data={gGmv} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                          <CartesianGrid stroke="#E3D7C1" strokeDasharray="3 3" vertical={false} />
                          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
                          <YAxis yAxisId="gmv" tick={AXIS_TICK} axisLine={false} tickLine={false} width={52} tickFormatter={(v) => compact(Number(v))} />
                          <YAxis yAxisId="bookings" orientation="right" allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} />
                          <Tooltip
                            contentStyle={TIP_STYLE}
                            labelStyle={TIP_LABEL}
                            itemStyle={{ color: "#26302C" }}
                            formatter={(value, name) => (name === "GMV" ? inr(Number(value)) : `${value} booking${Number(value) === 1 ? "" : "s"}`)}
                            cursor={{ fill: "rgba(185,135,62,0.08)" }}
                          />
                          <Bar yAxisId="gmv" dataKey="gmv" name="GMV" stackId="gmv" fill="#B9873E" radius={[3, 3, 0, 0]} maxBarSize={36} />
                          <Line
                            yAxisId="bookings"
                            type="monotone"
                            dataKey="bookings"
                            name="Bookings"
                            stroke="#0F2622"
                            strokeWidth={2}
                            dot={{ r: 2.5, fill: "#0F2622", strokeWidth: 0 }}
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    ) : (
                      <EmptyState icon={Building2} title="No booked value yet" hint="GMV builds up as tenants take bookings." />
                    )}
                  </div>
                </div>
              </div>

              {/* Top businesses */}
              <div className="panel">
                <div className="panel-header">
                  <div>
                    <p className="panel-title">Top businesses</p>
                    <p className="text-[11px] text-muted-ink mt-0.5">by booked revenue · last 90 days</p>
                  </div>
                </div>
                {gTop.length > 0 ? (
                  <div className="overflow-x-auto scroll-slim">
                    <table className="w-full min-w-[560px]">
                      <thead>
                        <tr>
                          <th className="th">Business</th>
                          <th className="th">Plan</th>
                          <th className="th text-right">Bookings</th>
                          <th className="th text-right">Booked revenue</th>
                        </tr>
                      </thead>
                      <tbody>
                        {gTop.map((b) => (
                          <tr key={b.propertyId} className="hover:bg-plaster/50">
                            <td className="td max-w-[260px] truncate font-medium text-pine" title={b.name}>{b.name}</td>
                            <td className="td">
                              <span className="badge border-line-strong bg-plaster uppercase text-muted-ink">{b.plan}</span>
                            </td>
                            <td className="td text-right tabular-nums">{b.bookings}</td>
                            <td className="td text-right font-semibold tabular-nums text-pine">{inr(b.revenue)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="p-4">
                    <EmptyState icon={Building2} title="No bookings in the last 90 days" hint="Top businesses rank by booked revenue across live tenants." />
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
