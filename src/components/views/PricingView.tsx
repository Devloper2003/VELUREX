"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDateShort } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  ArrowUp, CalendarClock, Gauge, Info, Loader2, Percent, Save, TrendingUp, Zap,
} from "lucide-react";

interface PricingSuggestion {
  date: string;
  occupancyProjected: number;
  baseRates: { roomTypeId: string; roomTypeName: string; currentBase: number; suggested: number }[];
}
interface PricingResponse {
  rule: { enabled: boolean; occupancyThreshold: number; rateIncreasePercent: number; activeNow: boolean };
  occupancyNow: number;
  totalRooms: number;
  occupiedRooms: number;
  suggestions: PricingSuggestion[];
  message: string;
}

export default function PricingView() {
  const user = useSession((s) => s.user);
  const isAdmin = user?.role === "hotel_admin";
  const { toast } = useToast();

  const [data, setData] = useState<PricingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [threshold, setThreshold] = useState(80);
  const [increase, setIncrease] = useState(10);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const ruleLoaded = useRef(false);

  const load = useCallback(async () => {
    try {
      const res = await api<PricingResponse>("/api/pricing");
      setData(res);
      // Only sync the editable rule from the server while the admin has no unsaved edits.
      if (!dirty || !ruleLoaded.current) {
        setEnabled(res.rule.enabled);
        setThreshold(res.rule.occupancyThreshold);
        setIncrease(res.rule.rateIncreasePercent);
        ruleLoaded.current = true;
      }
    } catch {
      /* keep stale */
    } finally {
      setLoading(false);
    }
  }, [dirty]);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const putRule = async (payload: { enabled?: boolean; occupancyThreshold?: number; rateIncreasePercent?: number }) => {
    const res = await api<{ rule: { enabled: boolean; occupancyThreshold: number; rateIncreasePercent: number } }>(
      "/api/pricing",
      { method: "PUT", body: JSON.stringify(payload) }
    );
    setEnabled(res.rule.enabled);
    setThreshold(res.rule.occupancyThreshold);
    setIncrease(res.rule.rateIncreasePercent);
    setDirty(false);
    load();
    return res;
  };

  const toggleEnabled = async (checked: boolean) => {
    setEnabled(checked); // optimistic
    try {
      await putRule({ enabled: checked });
      toast({ title: checked ? "Auto price increase enabled" : "Auto price increase disabled" });
    } catch (e) {
      setEnabled(!checked);
      toast({ title: "Could not update rule", description: (e as Error).message, variant: "destructive" });
    }
  };

  const saveRule = async () => {
    setSaving(true);
    try {
      await putRule({ occupancyThreshold: threshold, rateIncreasePercent: increase });
      toast({ title: "Pricing rule saved", description: `Threshold ${threshold}% · increase ${increase}%` });
    } catch (e) {
      toast({ title: "Could not save rule", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const applyRate = async (roomTypeId: string, roomTypeName: string, newRate: number, date: string | null) => {
    setApplying(date ? `${date}:${roomTypeId}` : roomTypeId);
    try {
      await api("/api/pricing/apply", {
        method: "POST",
        body: JSON.stringify({ roomTypeId, newRate }),
      });
      toast({ title: `${roomTypeName} base rate set to ${inr(newRate)}` });
      load();
    } catch (e) {
      toast({ title: "Could not apply rate", description: (e as Error).message, variant: "destructive" });
    } finally {
      setApplying(null);
    }
  };

  const applyAllForDate = async (s: PricingSuggestion) => {
    setApplying(`${s.date}:all`);
    try {
      for (const rt of s.baseRates) {
        await api("/api/pricing/apply", {
          method: "POST",
          body: JSON.stringify({ roomTypeId: rt.roomTypeId, newRate: rt.suggested }),
        });
      }
      toast({ title: `Applied suggested rates for ${fmtDateShort(s.date)}`, description: `${s.baseRates.length} room types updated` });
      load();
    } catch (e) {
      toast({ title: "Bulk apply failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setApplying(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="grid lg:grid-cols-3 gap-4">
        <div className="panel p-5 lg:col-span-1"><div className="skeleton h-72 rounded" /></div>
        <div className="panel p-5 lg:col-span-2"><div className="skeleton h-72 rounded" /></div>
      </div>
    );
  }
  if (!data) return <div className="panel p-6 text-sm text-danger">Could not load pricing rule. Check your connection.</div>;

  const activeNow = data.rule.enabled && data.occupancyNow >= data.rule.occupancyThreshold;

  return (
    <div className="grid lg:grid-cols-3 gap-4 items-start">
      {/* ── Rule panel ──────────────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="panel">
          <div className="panel-header">
            <p className="panel-title">Dynamic Pricing Rule</p>
            <TrendingUp className="h-4 w-4 text-brass" />
          </div>
          <div className="p-4 space-y-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-pine">Enable auto price increase</p>
                <p className="text-xs text-muted-ink">Suggest higher rates on high-demand dates</p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={toggleEnabled}
                disabled={!isAdmin || saving}
                aria-label="Enable auto price increase"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="field-label mb-0">Occupancy threshold</label>
                <span className="text-sm font-semibold text-brass">{threshold}%</span>
              </div>
              <Slider
                value={[threshold]}
                min={50}
                max={95}
                step={1}
                disabled={!isAdmin}
                onValueChange={(v) => {
                  setThreshold(v[0] ?? 80);
                  setDirty(true);
                }}
              />
              <div className="flex justify-between text-[10px] text-muted-ink mt-1">
                <span>50%</span>
                <span>95%</span>
              </div>
            </div>

            <div>
              <label className="field-label">Rate increase %</label>
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  className="field max-w-[110px]"
                  value={increase}
                  disabled={!isAdmin}
                  onChange={(e) => {
                    setIncrease(Number(e.target.value));
                    setDirty(true);
                  }}
                />
                <span className="text-xs text-muted-ink flex items-center gap-1">
                  <Percent className="h-3 w-3" /> on top of base rate
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-ink rounded-md bg-plaster/60 border border-line px-3 py-2">
              When occupancy exceeds the threshold, suggest raising rates by the increase % on the affected dates.
            </p>

            {isAdmin ? (
              <button className="btn-pine w-full" onClick={saveRule} disabled={saving || !dirty}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                {dirty ? "Save changes" : "Saved"}
              </button>
            ) : (
              <p className="text-xs text-muted-ink text-center">Only the hotel admin can change pricing rules.</p>
            )}
          </div>
        </div>

        {/* Live occupancy chip */}
        <div className="panel p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-md bg-pine-100 flex items-center justify-center">
                <Gauge className="h-4 w-4 text-pine-700" />
              </div>
              <div>
                <p className="text-xs text-muted-ink">Current occupancy</p>
                <p className="kpi-value text-xl">{data.occupancyNow}%</p>
              </div>
            </div>
            <span
              className={cn(
                "badge",
                activeNow ? "border-brass/40 bg-brass-50 text-brass" : "border-line-strong bg-plaster text-muted-ink"
              )}
            >
              <Zap className="h-3 w-3" />
              {activeNow ? "Rule active now" : data.rule.enabled ? "Below threshold" : "Rule off"}
            </span>
          </div>
          <p className="text-[11px] text-muted-ink mt-2">
            {data.occupiedRooms} of {data.totalRooms} rooms occupied · threshold {threshold}%
          </p>
        </div>

        {/* How rates flow */}
        <div className="panel p-4">
          <p className="text-sm font-medium text-pine flex items-center gap-2">
            <Info className="h-4 w-4 text-brass" /> How rates flow
          </p>
          <ul className="text-xs text-muted-ink space-y-1.5 mt-2 list-disc pl-4">
            <li>Applied rates update the room type base rate instantly.</li>
            <li>The booking engine quotes the new rate on the next availability check.</li>
            <li>Front desk new reservations default to the new base rate.</li>
            <li>Active rate plans (weekend / seasonal) still override the base on their dates.</li>
          </ul>
        </div>
      </div>

      {/* ── Suggestions panel ───────────────────────────────────────────────── */}
      <div className="panel lg:col-span-2">
        <div className="panel-header">
          <div className="flex items-center gap-3">
            <p className="panel-title">Suggestions — next 7 days</p>
            <span className="text-xs text-muted-ink hidden sm:inline">projected ≥ {threshold}% occupancy</span>
          </div>
          <CalendarClock className="h-4 w-4 text-brass" />
        </div>
        <div className="px-4 py-3 border-b border-line/70 text-xs text-muted-ink">{data.message}</div>

        {data.suggestions.length === 0 ? (
          <div className="px-4 py-14 text-center">
            <CalendarClock className="h-8 w-8 mx-auto text-brass mb-2" />
            <p className="text-sm text-muted-ink">
              No dates in the next 7 days cross the occupancy threshold — hold current rates.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line/70">
            {data.suggestions.map((s) => (
              <div key={s.date} className="px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5">
                    <p className="font-display font-semibold text-pine">{fmtDateShort(s.date)}</p>
                    <span className="badge border-brass/40 bg-brass-50 text-brass">
                      {s.occupancyProjected}% projected
                    </span>
                  </div>
                  {isAdmin && (
                    <button
                      className="btn-outline h-8 text-xs"
                      onClick={() => applyAllForDate(s)}
                      disabled={applying !== null}
                    >
                      {applying === `${s.date}:all` ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <ArrowUp className="h-3.5 w-3.5" />
                      )}
                      Apply all for {fmtDateShort(s.date)}
                    </button>
                  )}
                </div>
                <div className="mt-2 space-y-1.5">
                  {s.baseRates.map((rt) => (
                    <div key={rt.roomTypeId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                      <p className="text-[13px] font-medium text-pine">{rt.roomTypeName}</p>
                      <div className="flex items-center gap-3">
                        <p className="text-[13px] text-muted-ink">
                          {inr(rt.currentBase)}{" "}
                          <span className="inline-flex items-center gap-0.5 text-brass font-semibold">
                            <ArrowUp className="h-3.5 w-3.5" /> {inr(rt.suggested)}
                          </span>
                        </p>
                        {isAdmin && (
                          <button
                            className="btn-ghost h-7 px-2 text-xs text-brass hover:bg-brass-50"
                            onClick={() => applyRate(rt.roomTypeId, rt.roomTypeName, rt.suggested, s.date)}
                            disabled={applying !== null}
                          >
                            {applying === `${s.date}:${rt.roomTypeId}` ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              "Apply"
                            )}
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted-ink">
          Auto-refreshes every 60s · projections count confirmed + in-house reservations against sellable rooms
        </div>
      </div>
    </div>
  );
}
