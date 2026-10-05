"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Package, Pencil, Plus, Trash2,
} from "lucide-react";
import { EmptyState, ErrorState, Loading, StatusBadge, inr, useOwnerApi } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  ADDON_BADGES, describeGrants, FEATURES, stringifyGrants,
  type FeatureDef,
} from "@/lib/feature-catalog";
import { IconFor, FEATURE_ICON_KEYS } from "@/components/feature-icons";
import { cn } from "@/lib/utils";

const ADDON_ICON_KEYS = FEATURE_ICON_KEYS;

/* ─── types ──────────────────────────────────────────────────────────────── */

interface CatalogAddon {
  id: string;
  key: string;
  name: string;
  description: string;
  category: string; // feature | capacity | service
  price: number;
  oneOff: boolean;
  grants: Record<string, unknown>;
  planCodes: string[];
  badge: string;
  icon: string;
  sortOrder: number;
  active: boolean;
  purchaseCount: number;
  totalQty: number;
}

interface PlanLite { id: string; code: string; name: string; active: boolean }

const CATEGORY_META: Record<string, { label: string; hint: string; badgeCls: string }> = {
  feature: { label: "Feature unlock", hint: "Turns on a module — single purchase", badgeCls: "border-brass/40 bg-brass/10 text-brass" },
  capacity: { label: "Capacity pack", hint: "Raises a limit — stackable", badgeCls: "border-ok/40 bg-ok/10 text-ok" },
  service: { label: "Service", hint: "One-off or ongoing human service", badgeCls: "border-line-strong bg-plaster text-muted-ink" },
};

function draftFrom(a?: CatalogAddon) {
  return {
    key: a?.key ?? "",
    name: a?.name ?? "",
    description: a?.description ?? "",
    category: a?.category ?? "feature",
    price: a?.price ?? 999,
    oneOff: a?.oneOff ?? false,
    grants: (a?.grants ?? {}) as Record<string, unknown>,
    planCodes: a?.planCodes ?? [],
    badge: a?.badge ?? "",
    icon: a?.icon ?? "puzzle",
    sortOrder: a?.sortOrder ?? 50,
    active: a?.active ?? true,
  };
}
type Draft = ReturnType<typeof draftFrom>;

/* ─── grant editor row ───────────────────────────────────────────────────── */

function GrantRow({ def, value, onChange }: { def: FeatureDef; value: unknown; onChange: (v: unknown) => void }) {
  if (def.type === "boolean") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{def.label}</p>
          <p className="text-[11px] text-muted-ink truncate">{def.description}</p>
        </div>
        <Switch checked={value === true} onCheckedChange={(c) => onChange(c ? true : undefined)} />
      </div>
    );
  }
  if (def.type === "limit") {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink">{def.label}</p>
          <p className="text-[11px] text-muted-ink">Added to the tenant&apos;s cap (0 = no boost)</p>
        </div>
        <Input
          type="number"
          className="w-24 h-9"
          value={typeof value === "number" ? value : 0}
          onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
      </div>
    );
  }
  // enum tier
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-ink">{def.label}</p>
        <p className="text-[11px] text-muted-ink">Grants this tier while active</p>
      </div>
      <Select value={typeof value === "string" ? value : ""} onValueChange={(v) => onChange(v === "none" ? undefined : v)}>
        <SelectTrigger className="w-40 h-9"><SelectValue placeholder="No change" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No change</SelectItem>
          {(def.options ?? []).map((o) => <SelectItem key={o} value={o}>{o.replace(/_/g, " ")}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}

/* ─── main view ──────────────────────────────────────────────────────────── */

export default function AddonsCatalogView() {
  const api = useOwnerApi();
  const { toast } = useToast();
  const [addons, setAddons] = useState<CatalogAddon[] | null>(null);
  const [plans, setPlans] = useState<PlanLite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<CatalogAddon | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(undefined));
  const [confirmDelete, setConfirmDelete] = useState<CatalogAddon | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, p] = await Promise.all([
        api<{ addons: CatalogAddon[] }>("/api/owner/addons"),
        api<{ plans: PlanLite[] }>("/api/owner/plans"),
      ]);
      setAddons(a.addons ?? []);
      setPlans(p.plans ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load add-on catalogue");
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return addons ?? [];
    return (addons ?? []).filter((a) => `${a.name} ${a.key} ${a.category} ${a.badge}`.toLowerCase().includes(q));
  }, [addons, search]);

  const openCreate = () => { setEditing(null); setDraft(draftFrom(undefined)); setEditorOpen(true); };
  const openEdit = (a: CatalogAddon) => { setEditing(a); setDraft(draftFrom(a)); setEditorOpen(true); };

  const save = async () => {
    if (!draft.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const body = {
        ...draft,
        grants: stringifyGrants(draft.grants),
      };
      if (editing) {
        await api(`/api/owner/addons/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
        toast({ title: "Add-on updated", description: `${draft.name} — changes apply to every holder immediately.` });
      } else {
        await api("/api/owner/addons", { method: "POST", body: JSON.stringify(body) });
        toast({ title: "Add-on created", description: `${draft.name} is now live in the tenant catalogue.` });
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not save add-on", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (a: CatalogAddon) => {
    setBusy(true);
    try {
      const res = await api<{ deactivated?: boolean; purchases?: number }>(`/api/owner/addons/${a.id}`, { method: "DELETE" });
      toast({
        title: res.deactivated ? "Add-on deactivated" : "Add-on deleted",
        description: res.deactivated
          ? `${res.purchases} active purchase${res.purchases === 1 ? "" : "s"} kept — history preserved.`
          : `${a.name} removed from the catalogue.`,
      });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast({ title: "Could not remove add-on", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (a: CatalogAddon) => {
    setBusy(true);
    try {
      await api(`/api/owner/addons/${a.id}`, { method: "PATCH", body: JSON.stringify({ active: !a.active }) });
      await load();
    } catch (e) {
      toast({ title: "Could not update", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!addons) return <Loading label="Loading add-on catalogue…" />;

  const counts = {
    all: addons.length,
    active: addons.filter((a) => a.active).length,
    feature: addons.filter((a) => a.category === "feature").length,
    capacity: addons.filter((a) => a.category === "capacity").length,
    service: addons.filter((a) => a.category === "service").length,
  };

  return (
    <div className="space-y-4">
      {/* header + stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Total add-ons", value: counts.all, cls: "text-pine" },
          { label: "Live on storefront", value: counts.active, cls: "text-ok" },
          { label: "Feature unlocks", value: counts.feature, cls: "text-brass" },
          { label: "Capacity packs", value: counts.capacity, cls: "text-pine" },
        ].map((s) => (
          <div key={s.label} className="panel p-4">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-ink font-semibold">{s.label}</p>
            <p className={cn("font-display text-2xl font-semibold mt-1", s.cls)}>{s.value}</p>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-header flex-wrap gap-3">
          <p className="panel-title">Add-ons catalogue</p>
          <div className="flex items-center gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search add-ons…"
              className="h-9 w-44"
            />
            <button className="btn-brass h-9" onClick={openCreate}>
              <Plus className="h-4 w-4" /> New add-on
            </button>
          </div>
        </div>

        {filtered.length === 0 ? (
          <EmptyState
            icon={Package}
            title={search ? "No matches" : "No add-ons yet"}
            hint={search ? "Try a different search." : "Create your first add-on — feature unlocks, capacity packs or services."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Add-on</th>
                  <th className="th">Type</th>
                  <th className="th">Grants</th>
                  <th className="th">Price</th>
                  <th className="th">Plans</th>
                  <th className="th text-center">Holders</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => {
                  const meta = CATEGORY_META[a.category] ?? CATEGORY_META.feature;
                  return (
                    <tr key={a.id} className={cn("hover:bg-plaster/40 transition", !a.active && "opacity-60")}>
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-pine/5 border border-line">
                            <IconFor name={a.icon} className="h-4 w-4 text-brass" />
                          </span>
                          <div className="min-w-0">
                            <p className="text-[13px] font-semibold text-pine flex items-center gap-1.5">
                              {a.name}
                              {a.badge && <span className="badge border-brass/40 bg-brass/10 text-brass text-[9px]">{a.badge}</span>}
                            </p>
                            <p className="text-[11px] text-muted-ink font-mono">{a.key}</p>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <span className={cn("badge", meta.badgeCls)}>{meta.label}</span>
                        {a.oneOff && <span className="text-[10px] text-muted-ink ml-1.5">one-off</span>}
                      </td>
                      <td className="td max-w-[220px]"><p className="text-[12px] text-ink truncate">{describeGrants(JSON.stringify(a.grants))}</p></td>
                      <td className="td font-semibold whitespace-nowrap">{inr(a.price)}{a.oneOff ? "" : <span className="text-[10px] text-muted-ink font-normal">/mo</span>}</td>
                      <td className="td">
                        {a.planCodes.length === 0
                          ? <span className="text-[12px] text-muted-ink">All plans</span>
                          : <span className="text-[12px] capitalize">{a.planCodes.join(", ")}</span>}
                      </td>
                      <td className="td text-center">
                        <span className="font-semibold">{a.purchaseCount}</span>
                        {a.totalQty > a.purchaseCount && <span className="text-[10px] text-muted-ink ml-1">({a.totalQty} qty)</span>}
                      </td>
                      <td className="td"><StatusBadge status={a.active ? "active" : "cancelled"} /></td>
                      <td className="td text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <button className="btn-ghost h-8 px-2 text-[12px]" onClick={() => openEdit(a)}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </button>
                          <button
                            className="btn-ghost h-8 px-2 text-danger"
                            aria-label={`Delete ${a.name}`}
                            disabled={busy}
                            onClick={() => setConfirmDelete(a)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                          <Switch checked={a.active} onCheckedChange={() => void toggleActive(a)} disabled={busy} />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* editor dialog */}
      <Dialog open={editorOpen} onOpenChange={(o) => !o && setEditorOpen(false)}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit add-on — ${editing.name}` : "New add-on"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Price and grant changes apply to every active holder immediately."
                : "Define what this add-on grants and who can buy it. Tenants see it instantly on Billing → Add-ons."}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Name *</Label>
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Restaurant POS" />
              </div>
              <div className="space-y-1.5">
                <Label>Key {!editing && <span className="text-muted-ink">(auto from name if blank)</span>}</Label>
                <Input
                  value={draft.key}
                  disabled={!!editing}
                  onChange={(e) => setDraft({ ...draft, key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })}
                  placeholder="pos_pack"
                  className="font-mono"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea rows={2} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What the tenant gets, one or two lines." />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Type</Label>
                <Select value={draft.category} onValueChange={(v) => setDraft({ ...draft, category: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="feature">Feature unlock</SelectItem>
                    <SelectItem value="capacity">Capacity pack</SelectItem>
                    <SelectItem value="service">Service</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Price (₹{draft.oneOff ? " one-off" : " / month"})</Label>
                <Input type="number" min={0} value={draft.price} onChange={(e) => setDraft({ ...draft, price: Math.max(0, Number(e.target.value) || 0) })} />
              </div>
              <div className="space-y-1.5">
                <Label>Highlight badge</Label>
                <Select value={draft.badge || "none"} onValueChange={(v) => setDraft({ ...draft, badge: v === "none" ? "" : v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ADDON_BADGES.map((b) => (
                      <SelectItem key={b || "none"} value={b || "none"}>{b || "No badge"}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Icon</Label>
                <Select value={draft.icon} onValueChange={(v) => setDraft({ ...draft, icon: v })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent className="max-h-64">
                    {ADDON_ICON_KEYS.map((k) => (
                      <SelectItem key={k} value={k}>
                        <span className="flex items-center gap-2"><IconFor name={k} className="h-4 w-4" /> {k}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Sort order</Label>
                <Input type="number" value={draft.sortOrder} onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) || 0 })} />
              </div>
              <div className="space-y-1.5">
                <Label>One-off charge</Label>
                <div className="flex h-9 items-center gap-2 rounded-md border border-line px-3">
                  <Switch checked={draft.oneOff} onCheckedChange={(c) => setDraft({ ...draft, oneOff: c })} />
                  <span className="text-[12px] text-muted-ink">{draft.oneOff ? "Single invoice" : "Recurring monthly"}</span>
                </div>
              </div>
            </div>

            {/* plan applicability */}
            <div className="space-y-1.5">
              <Label>Available on plans</Label>
              <div className="flex flex-wrap gap-1.5">
                {(plans ?? []).map((p) => {
                  const on = draft.planCodes.length === 0 || draft.planCodes.includes(p.code);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={cn(
                        "rounded-full border px-3 py-1 text-[12px] font-medium transition",
                        on ? "border-pine/40 bg-pine/5 text-pine" : "border-line-strong bg-plaster text-muted-ink"
                      )}
                      onClick={() => {
                        setDraft((d) => {
                          const set = new Set(d.planCodes);
                          if (set.size === 0) {
                            // switching from "all plans" — start from every active plan except this one
                            (plans ?? []).filter((x) => x.code !== p.code).forEach((x) => set.add(x.code));
                          } else if (set.has(p.code)) set.delete(p.code);
                          else set.add(p.code);
                          return { ...d, planCodes: [...set] };
                        });
                      }}
                    >
                      {p.name}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted-ink">Leave all on = available on every plan.</p>
            </div>

            {/* grants editor */}
            <div className="space-y-2">
              <Label>What it grants</Label>
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {FEATURES.filter((f) => f.type !== "enum" || f.key === "support").map((f) => (
                  <GrantRow
                    key={f.key}
                    def={f}
                    value={draft.grants[f.key]}
                    onChange={(v) =>
                      setDraft((d) => {
                        const next = { ...d.grants };
                        if (v === undefined) delete next[f.key];
                        else next[f.key] = v;
                        return { ...d, grants: next };
                      })
                    }
                  />
                ))}
              </div>
              <p className="text-[11px] text-muted-ink">
                Preview: <span className="text-ink font-medium">{describeGrants(stringifyGrants(draft.grants)) || "nothing yet"}</span>
              </p>
            </div>
          </div>

          <DialogFooter className="gap-2">
            <button className="btn-ghost" onClick={() => setEditorOpen(false)}>Cancel</button>
            <button className="btn-brass" disabled={busy} onClick={() => void save()}>
              {editing ? "Save changes" : "Create add-on"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              {confirmDelete && confirmDelete.purchaseCount > 0
                ? `${confirmDelete.purchaseCount} tenant${confirmDelete.purchaseCount === 1 ? "" : "s"} currently hold this add-on. It will be DEACTIVATED (kept for billing history) instead of deleted.`
                : "No purchases yet — it will be deleted permanently."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <button className="btn-ghost" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button className="btn-danger" disabled={busy} onClick={() => confirmDelete && void doDelete(confirmDelete)}>
              {confirmDelete && confirmDelete.purchaseCount > 0 ? "Deactivate" : "Delete"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
