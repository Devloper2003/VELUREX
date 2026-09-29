"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Plus, Loader2, Pencil, BadgePercent, Info } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

interface RatePlan {
  id: string;
  name: string;
  code: string;
  description: string;
  roomTypeId: string | null;
  baseRate: number;
  weekendRate: number | null;
  seasonalStart: string | null;
  seasonalEnd: string | null;
  seasonalRate: number | null;
  inclusions: string;
  active: boolean;
  roomType: { id: string; name: string; code: string } | null;
}

interface RoomTypeLite { id: string; name: string; code: string }

const EMPTY_FORM = {
  name: "", code: "", description: "", roomTypeId: "any", baseRate: "", weekendRate: "",
  seasonalStart: "", seasonalEnd: "", seasonalRate: "", inclusions: "", active: true,
};

export default function RatePlansView() {
  const { toast } = useToast();
  const user = useSession((s) => s.user);
  const isAdmin = user?.role === "hotel_admin";

  const [plans, setPlans] = useState<RatePlan[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomTypeLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<RatePlan | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([
        api<{ ratePlans: RatePlan[] }>("/api/rate-plans"),
        api<{ roomTypes: RoomTypeLite[] }>("/api/room-types"),
      ]);
      setPlans(p.ratePlans);
      setRoomTypes(t.roomTypes);
    } catch (e) {
      toast({ title: "Could not load rate plans", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const inclusionChips = useMemo(
    () => (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean),
    []
  );

  async function toggleActive(plan: RatePlan, active: boolean) {
    // optimistic toggle
    setPlans((ps) => ps.map((p) => (p.id === plan.id ? { ...p, active } : p)));
    try {
      await api(`/api/rate-plans/${plan.id}`, { method: "PATCH", body: JSON.stringify({ active }) });
      toast({ title: active ? `${plan.name} activated` : `${plan.name} paused` });
    } catch (e) {
      setPlans((ps) => ps.map((p) => (p.id === plan.id ? { ...p, active: !active } : p)));
      toast({ title: "Could not update plan", description: (e as Error).message, variant: "destructive" });
    }
  }

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(p: RatePlan) {
    setEditing(p);
    setForm({
      name: p.name,
      code: p.code,
      description: p.description,
      roomTypeId: p.roomTypeId ?? "any",
      baseRate: String(p.baseRate),
      weekendRate: p.weekendRate === null ? "" : String(p.weekendRate),
      seasonalStart: p.seasonalStart ? p.seasonalStart.slice(0, 10) : "",
      seasonalEnd: p.seasonalEnd ? p.seasonalEnd.slice(0, 10) : "",
      seasonalRate: p.seasonalRate === null ? "" : String(p.seasonalRate),
      inclusions: p.inclusions,
      active: p.active,
    });
    setDialogOpen(true);
  }

  async function submit() {
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        code: form.code.trim(),
        description: form.description,
        roomTypeId: form.roomTypeId === "any" ? null : form.roomTypeId,
        baseRate: Number(form.baseRate),
        weekendRate: form.weekendRate === "" ? null : Number(form.weekendRate),
        seasonalStart: form.seasonalStart || null,
        seasonalEnd: form.seasonalEnd || null,
        seasonalRate: form.seasonalRate === "" ? null : Number(form.seasonalRate),
        inclusions: form.inclusions,
        active: form.active,
      };
      if (editing) {
        await api(`/api/rate-plans/${editing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast({ title: "Rate plan updated", description: `${payload.name} saved.` });
      } else {
        await api("/api/rate-plans", { method: "POST", body: JSON.stringify(payload) });
        toast({ title: "Rate plan created", description: `${payload.name} (${payload.code}) added.` });
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast({ title: editing ? "Update failed" : "Could not create plan", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="panel p-5"><div className="skeleton h-40 rounded" /></div>)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Usage note */}
      <div className="panel px-4 py-3 flex items-start gap-3">
        <Info className="h-4 w-4 text-brass mt-0.5 shrink-0" />
        <p className="text-[13px] text-muted-ink">
          <b className="text-pine">How rates apply:</b> the <b>weekend rate</b> overrides the base rate on Fri–Sun;
          the <b>seasonal rate</b> overrides everything within its date range. Plans scoped to a room type apply only to
          that category — plans without a type apply property-wide.
        </p>
        {isAdmin && (
          <button className="btn-brass ml-auto shrink-0 self-start" onClick={openAdd}><Plus className="h-4 w-4" /> New Rate Plan</button>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {plans.map((p) => (
          <div key={p.id} className={`panel p-4 flex flex-col gap-3 ${p.active ? "" : "opacity-70"}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-display font-semibold text-pine">{p.name}</p>
                <div className="flex items-center gap-1.5 mt-1">
                  <span className="badge border-brass/40 bg-brass-50 text-brass">{p.code}</span>
                  {p.roomType ? (
                    <span className="badge border-line-strong bg-plaster text-muted-ink">{p.roomType.name}</span>
                  ) : (
                    <span className="badge border-pine-700/30 bg-pine-100 text-pine-700">All types</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                {isAdmin && (
                  <button className="btn-ghost px-2 h-7" onClick={() => openEdit(p)} aria-label={`Edit ${p.name}`}>
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                )}
                {isAdmin ? (
                  <Switch checked={p.active} onCheckedChange={(v) => toggleActive(p, v)} aria-label={`Toggle ${p.name}`} />
                ) : (
                  <span className={`badge ${p.active ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"}`}>
                    {p.active ? "Active" : "Paused"}
                  </span>
                )}
              </div>
            </div>

            {p.description && <p className="text-[13px] text-muted-ink">{p.description}</p>}

            <div className="flex items-baseline gap-2">
              <BadgePercent className="h-4 w-4 text-brass" />
              <span className="font-display text-xl font-semibold text-pine">{inr(p.baseRate)}</span>
              <span className="text-[11px] text-muted-ink">base / night</span>
              {p.weekendRate !== null && (
                <span className="ml-auto text-[12px] text-pine-700 font-medium">Weekend {inr(p.weekendRate)}</span>
              )}
            </div>

            {p.seasonalStart && p.seasonalEnd && p.seasonalRate !== null && (
              <div className="rounded-md border border-brass/30 bg-brass-50/60 px-3 py-2 text-[12px]">
                <span className="font-medium text-brass">Seasonal {p.seasonalRate !== null ? inr(p.seasonalRate) : ""}</span>
                <span className="text-muted-ink"> · {fmtDate(p.seasonalStart)} → {fmtDate(p.seasonalEnd)}</span>
              </div>
            )}

            {p.inclusions && (
              <div className="flex flex-wrap gap-1 mt-auto">
                {inclusionChips(p.inclusions).map((inc) => (
                  <span key={inc} className="badge border-line-strong bg-plaster text-muted-ink">{inc}</span>
                ))}
              </div>
            )}
          </div>
        ))}
        {plans.length === 0 && (
          <div className="panel p-10 text-center text-sm text-muted-ink md:col-span-2 xl:col-span-3">No rate plans yet.</div>
        )}
      </div>

      {/* Add / Edit dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">{editing ? `Edit ${editing.name}` : "New Rate Plan"}</DialogTitle>
            <DialogDescription>Weekend rate covers Fri–Sun; the seasonal rate overrides within its range.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Plan Name *</label>
              <input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Monsoon Saver" />
            </div>
            <div>
              <label className="field-label">Code *</label>
              <input className="field" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="MON" />
            </div>
            <div className="col-span-2">
              <label className="field-label">Room Type</label>
              <Select value={form.roomTypeId} onValueChange={(v) => setForm({ ...form, roomTypeId: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">All room types</SelectItem>
                  {roomTypes.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="field-label">Base Rate (₹) *</label>
              <input className="field" type="number" min={0} value={form.baseRate} onChange={(e) => setForm({ ...form, baseRate: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Weekend Rate (₹)</label>
              <input className="field" type="number" min={0} value={form.weekendRate} onChange={(e) => setForm({ ...form, weekendRate: e.target.value })} placeholder="Fri–Sun" />
            </div>
            <div>
              <label className="field-label">Seasonal From</label>
              <input className="field" type="date" value={form.seasonalStart} onChange={(e) => setForm({ ...form, seasonalStart: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Seasonal To</label>
              <input className="field" type="date" value={form.seasonalEnd} onChange={(e) => setForm({ ...form, seasonalEnd: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Seasonal Rate (₹)</label>
              <input className="field" type="number" min={0} value={form.seasonalRate} onChange={(e) => setForm({ ...form, seasonalRate: e.target.value })} />
            </div>
            <div className="flex items-end pb-1.5 gap-2">
              <Switch checked={form.active} onCheckedChange={(v) => setForm({ ...form, active: v })} id="plan-active" />
              <label htmlFor="plan-active" className="text-[13px] text-muted-ink cursor-pointer">Active immediately</label>
            </div>
            <div className="col-span-2">
              <label className="field-label">Inclusions (comma separated)</label>
              <input className="field" value={form.inclusions} onChange={(e) => setForm({ ...form, inclusions: e.target.value })} placeholder="Breakfast, Wi-Fi, Airport pickup" />
            </div>
            <div className="col-span-2">
              <label className="field-label">Description</label>
              <textarea className="field h-16 py-2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setDialogOpen(false)}>Cancel</button>
            <button className="btn-pine" onClick={submit} disabled={saving || !form.name.trim() || !form.code.trim() || !(Number(form.baseRate) > 0)}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? "Save Changes" : "Create Plan"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
