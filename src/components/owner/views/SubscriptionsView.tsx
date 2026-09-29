"use client";

import { useCallback, useEffect, useState } from "react";
import {
  CalendarClock, CreditCard, MoreHorizontal, Package, Pause, Pencil, Play, Plus,
  RefreshCw, Search, Settings2, SlidersHorizontal, Trash2, XCircle, Zap,
} from "lucide-react";
import { EmptyState, ErrorState, Loading, StatusBadge, fmtDate, inr, relativeDays, useOwnerApi } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

/* ─── types ──────────────────────────────────────────────────────────────── */

interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  monthlyPrice: number;
  features: Record<string, unknown>;
  sortOrder: number;
  active: boolean;
  subscribers: number;
}

interface SubscriptionRow {
  id: string;
  property: { id: string; name: string; city: string | null };
  plan: { id: string; code: string; name: string; monthlyPrice: number };
  cycle: string;
  status: string;
  startedAt: string | null;
  renewalAt: string | null;
  trialEndsAt: string | null;
  autoRenew: boolean;
  pendingPlanId: string | null;
  usage: { rooms: number; staff: number };
  pending: { total: number; numbers: string[] } | null;
}

interface Addon {
  id: string;
  addonKey: string;
  label: string;
  qty: number;
  price: number;
  oneOff: boolean;
}

interface OverrideRow {
  id: string;
  featureKey: string;
  enabled: boolean | null;
  limitValue: number | null;
  note: string;
}

interface SubDetail {
  subscription: {
    id: string;
    cycle: string;
    status: string;
    autoRenew: boolean;
    pendingPlanId: string | null;
    renewalAt: string | null;
  };
  plan: { id: string; code: string; name: string; monthlyPrice: number };
  property: { id: string; name: string };
  addons: Addon[];
  overrides: OverrideRow[];
}

/* ─── constants ──────────────────────────────────────────────────────────── */

const STATUS_OPTIONS = ["all", "trial", "active", "overdue", "suspended", "paused", "cancelled"] as const;

const CYCLE_OPTIONS: { value: string; label: string }[] = [
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly (−5%)" },
  { value: "yearly", label: "Yearly (−10%)" },
];

const ADDON_OPTIONS: { key: string; label: string }[] = [
  { key: "rooms_pack", label: "Extra Rooms Pack (+10 rooms)" },
  { key: "staff_pack", label: "Extra Staff Pack (+5 seats)" },
  { key: "whatsapp_pack", label: "WhatsApp Pack (+100 msgs/mo)" },
  { key: "ota_pack", label: "Extra OTA Channel" },
  { key: "setup_fee", label: "One-time Setup Fee" },
];

const OVERRIDE_SUGGESTIONS = ["pos", "night_audit", "whatsapp_automation", "dynamic_pricing", "rooms", "staff"];

/** Starter feature template for brand-new plans (the editor always iterates the record). */
function newPlanFeatures(): Record<string, unknown> {
  return {
    rooms: 20, staff: 5, properties: 1, ota_channels: 2, whatsapp_msgs: 0,
    pos: false, night_audit: false, whatsapp_automation: false, dynamic_pricing: false,
    advanced_reports: false, excel_export: false, api_access: false, white_label: false,
    multi_property: false, support: "email", backup: "weekly",
  };
}

/* ─── local components ───────────────────────────────────────────────────── */

function FeatureEditor({
  features,
  onChange,
}: {
  features: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const entries = Object.entries(features);
  return (
    <div className="space-y-2">
      {entries.map(([key, value]) => {
        const set = (v: unknown) => onChange({ ...features, [key]: v });
        return (
          <div key={key} className="flex items-center justify-between gap-3 rounded-md border border-line px-3 py-2">
            <div className="min-w-0">
              <p className="text-[13px] font-medium capitalize text-pine">{key.replace(/_/g, " ")}</p>
              {typeof value === "number" && <p className="text-[11px] text-muted-ink">-1 = unlimited</p>}
            </div>
            {typeof value === "boolean" ? (
              <Switch checked={value} onCheckedChange={set} />
            ) : typeof value === "number" ? (
              <Input
                type="number"
                className="field h-8 w-24 text-right"
                value={String(value)}
                onChange={(e) => set(Math.trunc(Number(e.target.value) || 0))}
              />
            ) : (
              <Input
                className="field h-8 w-36"
                value={typeof value === "string" ? value : JSON.stringify(value)}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </div>
        );
      })}
      {entries.length === 0 && <p className="py-3 text-center text-xs text-muted-ink">No features defined for this plan.</p>}
    </div>
  );
}

/* ─── view ───────────────────────────────────────────────────────────────── */

export default function SubscriptionsView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  // list + filters
  const [rows, setRows] = useState<SubscriptionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  // plans
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [plansError, setPlansError] = useState<string | null>(null);
  const [showPlans, setShowPlans] = useState(false);

  // edit plan dialog
  const [editPlan, setEditPlan] = useState<Plan | null>(null);
  const [planDraft, setPlanDraft] = useState<{ monthlyPrice: string; description: string; features: Record<string, unknown> } | null>(null);
  const [planBusy, setPlanBusy] = useState(false);

  // new plan dialog
  const [newPlanOpen, setNewPlanOpen] = useState(false);
  const [np, setNp] = useState({ code: "", name: "", monthlyPrice: "4999", description: "", features: newPlanFeatures() });
  const [npBusy, setNpBusy] = useState(false);

  // change plan dialog
  const [changeSub, setChangeSub] = useState<SubscriptionRow | null>(null);
  const [cpPlanId, setCpPlanId] = useState("");
  const [cpCycle, setCpCycle] = useState("monthly");
  const [cpBusy, setCpBusy] = useState(false);
  const [cpResult, setCpResult] = useState<{ warnings: string[]; effectiveAt: string | null; planName: string } | null>(null);

  // extend dialog
  const [extendSub, setExtendSub] = useState<SubscriptionRow | null>(null);
  const [extendDays, setExtendDays] = useState("7");
  const [extendBusy, setExtendBusy] = useState(false);

  // detail dialog (add-ons / overrides)
  const [detailSub, setDetailSub] = useState<SubscriptionRow | null>(null);
  const [dialogMode, setDialogMode] = useState<"addons" | "overrides">("addons");
  const [detail, setDetail] = useState<SubDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [addonKey, setAddonKey] = useState("rooms_pack");
  const [addonQty, setAddonQty] = useState("1");
  const [ovKey, setOvKey] = useState("");
  const [ovEnabled, setOvEnabled] = useState("inherit");
  const [ovLimit, setOvLimit] = useState("");
  const [ovNote, setOvNote] = useState("");

  // cancel confirm
  const [cancelSub, setCancelSub] = useState<SubscriptionRow | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);

  /* ── data ── */

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (status !== "all") q.set("status", status);
      if (search) q.set("search", search);
      const qs = q.toString();
      const d = await api<{ subscriptions: SubscriptionRow[] }>(`/api/owner/subscriptions${qs ? `?${qs}` : ""}`);
      setRows(d.subscriptions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load subscriptions");
    }
  }, [api, status, search]);

  const loadPlans = useCallback(async () => {
    try {
      const d = await api<{ plans: Plan[] }>("/api/owner/plans");
      setPlans(d.plans ?? []);
      setPlansError(null);
    } catch (e) {
      setPlansError(e instanceof Error ? e.message : "Failed to load plans");
    }
  }, [api]);

  // Initial subscription load — promise chain (not a setState-containing fn handed to useEffect directly).
  useEffect(() => {
    let alive = true;
    const q = new URLSearchParams();
    if (status !== "all") q.set("status", status);
    if (search) q.set("search", search);
    const qs = q.toString();
    api<{ subscriptions: SubscriptionRow[] }>(`/api/owner/subscriptions${qs ? `?${qs}` : ""}`)
      .then((d) => {
        if (alive) {
          setRows(d.subscriptions ?? []);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "Failed to load subscriptions");
      });
    return () => {
      alive = false;
    };
  }, [api, status, search]);

  // Plans load (plan badges, change-plan select, manage-plans section).
  useEffect(() => {
    let alive = true;
    api<{ plans: Plan[] }>("/api/owner/plans")
      .then((d) => {
        if (alive) {
          setPlans(d.plans ?? []);
          setPlansError(null);
        }
      })
      .catch((e: unknown) => {
        if (alive) setPlansError(e instanceof Error ? e.message : "Failed to load plans");
      });
    return () => {
      alive = false;
    };
  }, [api]);
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  /* ── helpers ── */

  async function patchSub<T extends Record<string, unknown>>(id: string, body: Record<string, unknown>): Promise<T> {
    return api<T>(`/api/owner/subscriptions/${id}`, { method: "PATCH", body: JSON.stringify(body) });
  }

  function toastError(e: unknown, title: string) {
    toast({ title, description: e instanceof Error ? e.message : "Please try again.", variant: "destructive" });
  }

  /* ── row actions ── */

  async function toggleAuto(sub: SubscriptionRow) {
    try {
      const res = await patchSub<{ autoRenew?: boolean }>(sub.id, { action: "toggle_auto_renew" });
      setRows((prev) => (prev ?? []).map((r) => (r.id === sub.id ? { ...r, autoRenew: res.autoRenew ?? !r.autoRenew } : r)));
      toast({ title: res.autoRenew ? "Auto-renew enabled" : "Auto-renew disabled", description: `${sub.property.name} — ${res.autoRenew ? "renews automatically." : "manual renewal required."}` });
    } catch (e) {
      toastError(e, "Could not update auto-renew");
    }
  }

  async function togglePause(sub: SubscriptionRow) {
    const resuming = sub.status === "paused";
    try {
      await patchSub(sub.id, { action: resuming ? "resume" : "pause" });
      toast({
        title: resuming ? "Subscription resumed" : "Subscription paused",
        description: `${sub.property.name} — workspace ${resuming ? "unblocked" : "blocked"}, data retained.`,
      });
      load();
    } catch (e) {
      toastError(e, resuming ? "Resume failed" : "Pause failed");
    }
  }

  async function applyPending(sub: SubscriptionRow) {
    try {
      const pendingName = plans?.find((p) => p.id === sub.pendingPlanId)?.name ?? "the pending plan";
      await patchSub(sub.id, { action: "apply_pending_plan" });
      toast({ title: "Scheduled change applied", description: `${sub.property.name} is now on ${pendingName}, effective immediately.` });
      load();
    } catch (e) {
      toastError(e, "Could not apply scheduled plan");
    }
  }

  async function submitChangePlan() {
    if (!changeSub) return;
    const plan = plans?.find((p) => p.id === cpPlanId);
    if (!plan) return;
    const isDowngrade = plan.monthlyPrice < changeSub.plan.monthlyPrice;
    setCpBusy(true);
    try {
      const res = await patchSub<{ invoiceNumber?: string | null; warnings?: string[]; effectiveAt?: string | null }>(changeSub.id, {
        action: isDowngrade ? "downgrade" : "upgrade",
        planId: plan.id,
        ...(isDowngrade ? {} : { cycle: cpCycle }),
      });
      if (isDowngrade) {
        setCpResult({ warnings: res.warnings ?? [], effectiveAt: res.effectiveAt ?? null, planName: plan.name });
        toast({
          title: "Downgrade scheduled",
          description: `${plan.name} takes effect ${res.effectiveAt ? fmtDate(res.effectiveAt) : "at next renewal"} — review the warnings.`,
        });
        load();
      } else {
        toast({
          title: "Plan upgraded",
          description: `Prorated invoice ${res.invoiceNumber ?? "issued"} — ${plan.name} (${cpCycle}) active immediately.`,
        });
        setChangeSub(null);
        load();
      }
    } catch (e) {
      toastError(e, "Plan change failed");
    } finally {
      setCpBusy(false);
    }
  }

  async function submitExtend() {
    if (!extendSub) return;
    setExtendBusy(true);
    try {
      const res = await patchSub<{ renewalAt?: string }>(extendSub.id, {
        action: "extend",
        days: Math.max(1, parseInt(extendDays, 10) || 7),
      });
      toast({ title: "Renewal extended", description: `${extendSub.property.name} — new renewal date ${res.renewalAt ? fmtDate(res.renewalAt) : "updated"}.` });
      setExtendSub(null);
      load();
    } catch (e) {
      toastError(e, "Extend failed");
    } finally {
      setExtendBusy(false);
    }
  }

  async function submitCancel() {
    if (!cancelSub) return;
    setCancelBusy(true);
    try {
      await patchSub(cancelSub.id, { action: "cancel" });
      toast({ title: "Subscription cancelled", description: `${cancelSub.property.name} — workspace locks now, data retained for 60 days.` });
      setCancelSub(null);
      load();
    } catch (e) {
      toastError(e, "Cancel failed");
    } finally {
      setCancelBusy(false);
    }
  }

  /* ── detail dialog (add-ons / overrides) ── */

  async function openDetail(sub: SubscriptionRow, mode: "addons" | "overrides") {
    setDetailSub(sub);
    setDialogMode(mode);
    setDetail(null);
    setAddonKey("rooms_pack");
    setAddonQty("1");
    setOvKey("");
    setOvEnabled("inherit");
    setOvLimit("");
    setOvNote("");
    setDetailLoading(true);
    try {
      const d = await api<SubDetail>(`/api/owner/subscriptions/${sub.id}`);
      setDetail(d);
    } catch (e) {
      toastError(e, "Could not load subscription details");
      setDetailSub(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function refetchDetail(id: string) {
    const d = await api<SubDetail>(`/api/owner/subscriptions/${id}`);
    setDetail(d);
    load();
  }

  async function submitAddon() {
    if (!detailSub) return;
    setDetailBusy(true);
    try {
      const res = await patchSub<{ invoiceNumber?: string | null }>(detailSub.id, {
        action: "add_addon",
        addonKey,
        qty: Math.max(1, parseInt(addonQty, 10) || 1),
      });
      toast({
        title: "Add-on added",
        description: res.invoiceNumber ? `Setup fee invoiced as ${res.invoiceNumber}.` : "Pack applied to the subscription.",
      });
      await refetchDetail(detailSub.id);
    } catch (e) {
      toastError(e, "Add-on failed");
    } finally {
      setDetailBusy(false);
    }
  }

  async function removeAddon(addonId: string) {
    if (!detailSub) return;
    setDetailBusy(true);
    try {
      await patchSub(detailSub.id, { action: "remove_addon", addonId });
      toast({ title: "Add-on removed", description: "It will no longer renew or count towards entitlements." });
      await refetchDetail(detailSub.id);
    } catch (e) {
      toastError(e, "Remove failed");
    } finally {
      setDetailBusy(false);
    }
  }

  async function submitOverride() {
    if (!detailSub) return;
    const key = ovKey.trim();
    if (!key) {
      toast({ title: "Feature key required", description: "Pick a feature like pos, rooms or night_audit.", variant: "destructive" });
      return;
    }
    setDetailBusy(true);
    try {
      await patchSub(detailSub.id, {
        action: "set_override",
        featureKey: key,
        enabled: ovEnabled === "inherit" ? null : ovEnabled === "true",
        limitValue: ovLimit.trim() === "" ? null : Math.trunc(Number(ovLimit)),
        note: ovNote.trim(),
      });
      toast({ title: "Override saved", description: `${key} now overrides the plan for ${detailSub.property.name}.` });
      setOvKey("");
      setOvEnabled("inherit");
      setOvLimit("");
      setOvNote("");
      await refetchDetail(detailSub.id);
    } catch (e) {
      toastError(e, "Override failed");
    } finally {
      setDetailBusy(false);
    }
  }

  async function removeOverride(featureKey: string) {
    if (!detailSub) return;
    setDetailBusy(true);
    try {
      await patchSub(detailSub.id, { action: "remove_override", featureKey });
      toast({ title: "Override removed", description: `${featureKey} falls back to the plan default.` });
      await refetchDetail(detailSub.id);
    } catch (e) {
      toastError(e, "Remove failed");
    } finally {
      setDetailBusy(false);
    }
  }

  /* ── plan dialogs ── */

  function openEditPlan(p: Plan) {
    setEditPlan(p);
    setPlanDraft({
      monthlyPrice: String(p.monthlyPrice ?? 0),
      description: p.description ?? "",
      features: { ...(p.features ?? {}) },
    });
  }

  async function savePlan() {
    if (!editPlan || !planDraft) return;
    setPlanBusy(true);
    try {
      await api(`/api/owner/plans/${editPlan.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          monthlyPrice: Math.max(0, Number(planDraft.monthlyPrice) || 0),
          description: planDraft.description,
          features: planDraft.features,
        }),
      });
      toast({ title: "Plan saved", description: `${editPlan.name} updated — entitlements refreshed for every subscriber.` });
      setEditPlan(null);
      setPlanDraft(null);
      void loadPlans();
      load();
    } catch (e) {
      toastError(e, "Save failed");
    } finally {
      setPlanBusy(false);
    }
  }

  async function createPlan() {
    setNpBusy(true);
    try {
      await api("/api/owner/plans", {
        method: "POST",
        body: JSON.stringify({
          code: np.code.trim().toLowerCase(),
          name: np.name.trim(),
          description: np.description,
          monthlyPrice: Math.max(0, Number(np.monthlyPrice) || 0),
          features: np.features,
        }),
      });
      toast({ title: "Plan created", description: `${np.name} is live on the pricing table.` });
      setNewPlanOpen(false);
      setNp({ code: "", name: "", monthlyPrice: "4999", description: "", features: newPlanFeatures() });
      void loadPlans();
    } catch (e) {
      toastError(e, "Create failed");
    } finally {
      setNpBusy(false);
    }
  }

  /* ── derived ── */

  const cpSelected = plans?.find((p) => p.id === cpPlanId) ?? null;
  const cpIsDowngrade = cpSelected != null && changeSub != null && cpSelected.monthlyPrice < changeSub.plan.monthlyPrice;

  function openChangePlan(sub: SubscriptionRow) {
    setChangeSub(sub);
    setCpResult(null);
    setCpCycle(sub.cycle);
    const others = (plans ?? [])
      .filter((p) => p.id !== sub.plan.id && p.active)
      .sort((a, b) => a.monthlyPrice - b.monthlyPrice);
    setCpPlanId(others[0]?.id ?? "");
  }

  /* ── render ── */

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel p-3 flex flex-col sm:flex-row gap-2 sm:items-center">
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-full sm:w-[160px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s === "all" ? "All statuses" : s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-ink" />
          <Input
            className="field pl-8"
            placeholder="Search businesses by name…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <button className={showPlans ? "btn-pine" : "btn-outline"} onClick={() => setShowPlans((v) => !v)}>
          <Settings2 className="h-4 w-4" />
          {showPlans ? "Hide plans" : "Manage plans"}
        </button>
      </div>

      {/* Plans section */}
      {showPlans && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="panel-title">Plans & pricing</h2>
              <p className="text-[11px] text-muted-ink">Price and feature edits apply to every subscriber instantly.</p>
            </div>
            <button className="btn-brass" onClick={() => setNewPlanOpen(true)}>
              <Plus className="h-4 w-4" /> New plan
            </button>
          </div>
          {plansError && (
            <div className="panel">
              <ErrorState message={plansError} onRetry={() => void loadPlans()} />
            </div>
          )}
          {!plans && !plansError && (
            <div className="panel">
              <Loading label="Loading plans…" />
            </div>
          )}
          {plans && (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {plans.map((p) => (
                <div key={p.id} className="panel flex flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-display font-semibold text-pine">{p.name}</p>
                      <p className="text-[11px] uppercase tracking-wider text-muted-ink">{p.code}</p>
                    </div>
                    <span className={`badge ${p.active ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"}`}>
                      {p.active ? "live" : "hidden"}
                    </span>
                  </div>
                  <p className="kpi-value mt-2">
                    {inr(p.monthlyPrice)}
                    <span className="font-sans text-xs font-normal text-muted-ink">/mo</span>
                  </p>
                  <p className="mt-1 text-xs text-muted-ink">
                    {p.subscribers} subscriber{p.subscribers === 1 ? "" : "s"}
                  </p>
                  {p.description && <p className="mt-2 line-clamp-2 text-xs text-muted-ink">{p.description}</p>}
                  <div className="mt-3 border-t border-line pt-3">
                    <button className="btn-outline w-full" onClick={() => openEditPlan(p)}>
                      <Pencil className="h-3.5 w-3.5" /> Edit plan
                    </button>
                  </div>
                </div>
              ))}
              {plans.length === 0 && (
                <div className="panel sm:col-span-2 xl:col-span-3">
                  <EmptyState icon={Package} title="No plans yet" hint="Create your first plan to start selling subscriptions." />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Subscriptions table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><CreditCard className="h-4 w-4 text-brass" /> Subscriptions{rows ? ` · ${rows.length}` : ""}</p>
          <button className="btn-ghost h-8" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        {error && (
          <div className="p-3">
            <ErrorState message={error} onRetry={() => void load()} />
          </div>
        )}
        {!error && rows === null && <Loading label="Loading subscriptions…" />}
        {rows && rows.length === 0 && (
          <EmptyState
            icon={CreditCard}
            title={search !== "" || status !== "all" ? "No matching subscriptions" : "No subscriptions yet"}
            hint={
              search !== "" || status !== "all"
                ? "Try a different status filter or clear the search."
                : "Onboard a business to see its subscription here."
            }
          />
        )}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px]">
              <thead>
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Plan</th>
                  <th className="th">Cycle</th>
                  <th className="th">Status</th>
                  <th className="th">Usage</th>
                  <th className="th">Renewal</th>
                  <th className="th">Pending dues</th>
                  <th className="th">Auto-renew</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((sub) => {
                  const isTrial = sub.status === "trial";
                  const dateVal = isTrial ? sub.trialEndsAt : sub.renewalAt;
                  const pendingPlanName = plans?.find((p) => p.id === sub.pendingPlanId)?.name;
                  return (
                    <tr key={sub.id} className="hover:bg-plaster/40 transition">
                      <td className="td">
                        <p className="font-medium text-pine">{sub.property?.name ?? "—"}</p>
                        {sub.property?.city && <p className="text-[11px] text-muted-ink">{sub.property.city}</p>}
                      </td>
                      <td className="td">
                        <span className="badge border-pine/25 bg-pine/5 text-pine">{sub.plan?.name ?? "—"}</span>
                        {sub.pendingPlanId && (
                          <p className="mt-1 text-[11px] text-brass">
                            → {pendingPlanName ?? "plan change"} scheduled
                          </p>
                        )}
                      </td>
                      <td className="td capitalize text-[13px]">{sub.cycle ?? "—"}</td>
                      <td className="td">
                        <StatusBadge status={sub.status ?? "paused"} />
                      </td>
                      <td className="td text-[13px] text-muted-ink">
                        {sub.usage?.rooms ?? 0} rooms · {sub.usage?.staff ?? 0} staff
                      </td>
                      <td className="td">
                        <p className="text-[13px]">{fmtDate(dateVal)}</p>
                        <p className="text-[11px] text-muted-ink">
                          {isTrial ? "trial ends " : ""}
                          {relativeDays(dateVal)}
                        </p>
                      </td>
                      <td className="td">
                        {sub.pending && sub.pending.total > 0 ? (
                          <>
                            <p className="text-[13px] font-medium text-warn">{inr(sub.pending.total)}</p>
                            <p className="text-[11px] text-muted-ink">
                              {sub.pending.numbers.slice(0, 2).join(", ")}
                              {sub.pending.numbers.length > 2 ? ` +${sub.pending.numbers.length - 2}` : ""}
                            </p>
                          </>
                        ) : (
                          <span className="text-sm text-muted-ink">—</span>
                        )}
                      </td>
                      <td className="td">
                        <Switch
                          checked={sub.autoRenew}
                          disabled={sub.status === "cancelled"}
                          onCheckedChange={() => void toggleAuto(sub)}
                        />
                      </td>
                      <td className="td text-right">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="btn-ghost h-8 w-8 p-0" aria-label={`Actions for ${sub.property?.name ?? "subscription"}`}>
                              <MoreHorizontal className="h-4 w-4" />
                            </button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem onSelect={() => openChangePlan(sub)}>
                              <CreditCard className="h-4 w-4 text-muted-ink" /> Change plan
                            </DropdownMenuItem>
                            {sub.pendingPlanId && (
                              <DropdownMenuItem onSelect={() => void applyPending(sub)}>
                                <Zap className="h-4 w-4 text-brass" /> Apply scheduled change now
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onSelect={() => void togglePause(sub)}>
                              {sub.status === "paused" ? (
                                <Play className="h-4 w-4 text-muted-ink" />
                              ) : (
                                <Pause className="h-4 w-4 text-muted-ink" />
                              )}
                              {sub.status === "paused" ? "Resume" : "Pause"}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => { setExtendSub(sub); setExtendDays("7"); }}>
                              <CalendarClock className="h-4 w-4 text-muted-ink" /> Extend renewal
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void openDetail(sub, "addons")}>
                              <Package className="h-4 w-4 text-muted-ink" /> Add-ons
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => void openDetail(sub, "overrides")}>
                              <SlidersHorizontal className="h-4 w-4 text-muted-ink" /> Feature overrides
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            {sub.status !== "cancelled" && (
                              <DropdownMenuItem
                                className="text-danger focus:bg-danger/10 focus:text-danger"
                                onSelect={() => setCancelSub(sub)}
                              >
                                <XCircle className="h-4 w-4" /> Cancel subscription
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Edit plan dialog */}
      <Dialog
        open={editPlan !== null && planDraft !== null}
        onOpenChange={(o) => {
          if (!o) {
            setEditPlan(null);
            setPlanDraft(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit plan — {editPlan?.name}</DialogTitle>
            <DialogDescription>Changes apply to all {editPlan?.subscribers ?? 0} subscriber(s) and clear entitlement caches.</DialogDescription>
          </DialogHeader>
          {planDraft && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="field-label">Monthly price (₹)</Label>
                  <Input
                    type="number"
                    className="field"
                    value={planDraft.monthlyPrice}
                    onChange={(e) => setPlanDraft({ ...planDraft, monthlyPrice: e.target.value })}
                  />
                </div>
                <div>
                  <Label className="field-label">Code</Label>
                  <Input className="field" value={editPlan?.code ?? ""} disabled />
                </div>
              </div>
              <div>
                <Label className="field-label">Description</Label>
                <Textarea
                  rows={2}
                  value={planDraft.description}
                  onChange={(e) => setPlanDraft({ ...planDraft, description: e.target.value })}
                />
              </div>
              <div>
                <Label className="field-label">Features</Label>
                <div className="max-h-72 overflow-y-auto scroll-slim rounded-md border border-line p-2">
                  <FeatureEditor features={planDraft.features} onChange={(features) => setPlanDraft({ ...planDraft, features })} />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <button
              className="btn-ghost"
              onClick={() => {
                setEditPlan(null);
                setPlanDraft(null);
              }}
            >
              Cancel
            </button>
            <button className="btn-pine" disabled={planBusy} onClick={() => void savePlan()}>
              {planBusy ? "Saving…" : "Save plan"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New plan dialog */}
      <Dialog open={newPlanOpen} onOpenChange={setNewPlanOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>New plan</DialogTitle>
            <DialogDescription>Define pricing and the entitlement template — editable any time after launch.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="field-label">Code (lowercase)</Label>
                <Input className="field" placeholder="premium" value={np.code} onChange={(e) => setNp({ ...np, code: e.target.value })} />
              </div>
              <div>
                <Label className="field-label">Name</Label>
                <Input className="field" placeholder="Premium" value={np.name} onChange={(e) => setNp({ ...np, name: e.target.value })} />
              </div>
            </div>
            <div>
              <Label className="field-label">Monthly price (₹)</Label>
              <Input
                type="number"
                className="field"
                value={np.monthlyPrice}
                onChange={(e) => setNp({ ...np, monthlyPrice: e.target.value })}
              />
            </div>
            <div>
              <Label className="field-label">Description</Label>
              <Textarea rows={2} value={np.description} onChange={(e) => setNp({ ...np, description: e.target.value })} />
            </div>
            <div>
              <Label className="field-label">Features</Label>
              <div className="max-h-64 overflow-y-auto scroll-slim rounded-md border border-line p-2">
                <FeatureEditor features={np.features} onChange={(features) => setNp({ ...np, features })} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <button className="btn-ghost" onClick={() => setNewPlanOpen(false)}>
              Cancel
            </button>
            <button className="btn-brass" disabled={npBusy || !np.code.trim() || !np.name.trim()} onClick={() => void createPlan()}>
              {npBusy ? "Creating…" : "Create plan"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change plan dialog */}
      <Dialog
        open={changeSub !== null}
        onOpenChange={(o) => {
          if (!o) {
            setChangeSub(null);
            setCpResult(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Change plan — {changeSub?.property.name}</DialogTitle>
            <DialogDescription>
              Currently on {changeSub?.plan.name} · {inr(changeSub?.plan.monthlyPrice ?? 0)}/mo ({changeSub?.cycle}).
            </DialogDescription>
          </DialogHeader>
          {cpResult ? (
            <div className="space-y-3">
              <div className="rounded-md border border-warn/40 bg-warn/10 p-3">
                <p className="text-[13px] font-medium text-warn">Downgrade to {cpResult.planName} scheduled</p>
                <p className="mt-0.5 text-xs text-muted-ink">
                  {cpResult.effectiveAt
                    ? `Takes effect ${fmtDate(cpResult.effectiveAt)} (${relativeDays(cpResult.effectiveAt)}).`
                    : "Takes effect at the next renewal."}
                </p>
              </div>
              {cpResult.warnings.length > 0 ? (
                <ul className="space-y-1.5 text-[13px] text-ink">
                  {cpResult.warnings.map((w) => (
                    <li key={w} className="flex gap-2">
                      <span className="mt-0.5 text-warn">•</span>
                      <span>{w}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted-ink">No usage conflicts detected — the change will apply cleanly.</p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <Label className="field-label">New plan</Label>
                <Select value={cpPlanId} onValueChange={setCpPlanId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={plans ? "Choose a plan" : "Loading plans…"} />
                  </SelectTrigger>
                  <SelectContent>
                    {(plans ?? [])
                      .filter((p) => p.id !== changeSub?.plan.id)
                      .map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name} — {inr(p.monthlyPrice)}/mo
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                {cpIsDowngrade && (
                  <p className="mt-1 text-[11px] text-warn">
                    Lower price → scheduled as a downgrade for next renewal (usage limits apply).
                  </p>
                )}
              </div>
              {!cpIsDowngrade && (
                <div>
                  <Label className="field-label">Billing cycle</Label>
                  <Select value={cpCycle} onValueChange={setCpCycle}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Cycle" />
                    </SelectTrigger>
                    <SelectContent>
                      {CYCLE_OPTIONS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="mt-1 text-[11px] text-muted-ink">Upgrades apply immediately with a prorated invoice.</p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            {cpResult ? (
              <button
                className="btn-pine"
                onClick={() => {
                  setChangeSub(null);
                  setCpResult(null);
                }}
              >
                Confirm & close
              </button>
            ) : (
              <>
                <button
                  className="btn-ghost"
                  onClick={() => {
                    setChangeSub(null);
                    setCpResult(null);
                  }}
                >
                  Cancel
                </button>
                <button className="btn-pine" disabled={!cpPlanId || cpBusy} onClick={() => void submitChangePlan()}>
                  {cpBusy ? "Working…" : cpIsDowngrade ? "Schedule downgrade" : "Upgrade now"}
                </button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Extend renewal dialog */}
      <Dialog open={extendSub !== null} onOpenChange={(o) => { if (!o) setExtendSub(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Extend renewal — {extendSub?.property.name}</DialogTitle>
            <DialogDescription>
              Current renewal {fmtDate(extendSub?.renewalAt ?? null)} ({relativeDays(extendSub?.renewalAt ?? null)}).
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label className="field-label">Days to extend</Label>
            <Input type="number" className="field" value={extendDays} onChange={(e) => setExtendDays(e.target.value)} />
          </div>
          <DialogFooter>
            <button className="btn-ghost" onClick={() => setExtendSub(null)}>
              Cancel
            </button>
            <button className="btn-pine" disabled={extendBusy} onClick={() => void submitExtend()}>
              {extendBusy ? "Extending…" : "Extend"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail dialog: add-ons / overrides */}
      <Dialog
        open={detailSub !== null}
        onOpenChange={(o) => {
          if (!o) setDetailSub(null);
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {dialogMode === "addons" ? "Add-ons" : "Feature overrides"} — {detailSub?.property.name}
            </DialogTitle>
            <DialogDescription>
              {dialogMode === "addons"
                ? "Recurring packs renew with the subscription; setup fees are invoiced immediately."
                : "Per-tenant entitlement overrides — they take precedence over the plan."}
            </DialogDescription>
          </DialogHeader>

          {detailLoading && <Loading label="Loading details…" />}

          {detail && dialogMode === "addons" && (
            <div className="space-y-3">
              <div className="max-h-56 space-y-2 overflow-y-auto scroll-slim pr-1">
                {(detail.addons ?? []).length > 0 ? (
                  detail.addons.map((a) => (
                    <div key={a.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium text-pine">{a.label}</p>
                        <p className="text-[11px] text-muted-ink">
                          {inr(a.price)}
                          {a.oneOff ? " · one-off" : " / mo"}
                          {a.qty > 1 ? ` · ×${a.qty}` : ""}
                        </p>
                      </div>
                      <button className="btn-ghost h-8 px-2 text-danger" disabled={detailBusy} onClick={() => void removeAddon(a.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                ) : (
                  <EmptyState icon={Package} title="No add-ons on this subscription yet" hint="Add a recurring pack below — it renews with the subscription." />
                )}
              </div>
              <div className="rounded-md border border-line bg-plaster/40 p-3 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Add an add-on</p>
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_88px_auto] gap-2">
                  <Select value={addonKey} onValueChange={setAddonKey}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ADDON_OPTIONS.map((o) => (
                        <SelectItem key={o.key} value={o.key}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    className="field"
                    min={1}
                    value={addonQty}
                    onChange={(e) => setAddonQty(e.target.value)}
                    aria-label="Quantity"
                  />
                  <button className="btn-brass" disabled={detailBusy} onClick={() => void submitAddon()}>
                    <Plus className="h-4 w-4" /> Add
                  </button>
                </div>
              </div>
            </div>
          )}

          {detail && dialogMode === "overrides" && (
            <div className="space-y-3">
              <div className="max-h-56 space-y-2 overflow-y-auto scroll-slim pr-1">
                {(detail.overrides ?? []).length > 0 ? (
                  detail.overrides.map((o) => (
                    <div key={o.id} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                      <div className="min-w-0">
                        <p className="truncate text-[13px] font-medium capitalize text-pine">{o.featureKey.replace(/_/g, " ")}</p>
                        <p className="text-[11px] text-muted-ink">
                          {o.enabled === null ? "inherits plan" : o.enabled ? "forced on" : "forced off"}
                          {o.limitValue !== null ? ` · limit ${o.limitValue}` : ""}
                          {o.note ? ` · ${o.note}` : ""}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span
                          className={`badge ${
                            o.enabled === null
                              ? "border-line-strong bg-plaster text-muted-ink"
                              : o.enabled
                                ? "border-ok/40 bg-ok/10 text-ok"
                                : "border-danger/40 bg-danger/10 text-danger"
                          }`}
                        >
                          {o.enabled === null ? "inherit" : o.enabled ? "on" : "off"}
                        </span>
                        <button className="btn-ghost h-8 px-2 text-danger" disabled={detailBusy} onClick={() => void removeOverride(o.featureKey)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                ) : (
                  <EmptyState icon={SlidersHorizontal} title="No overrides" hint="This tenant follows the plan exactly. Add one below to force a feature on or off." />
                )}
              </div>
              <div className="rounded-md border border-line bg-plaster/40 p-3 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Add an override</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <Label className="field-label">Feature key</Label>
                    <Input
                      className="field"
                      list="feature-key-suggestions"
                      placeholder="pos, rooms, night_audit…"
                      value={ovKey}
                      onChange={(e) => setOvKey(e.target.value)}
                    />
                    <datalist id="feature-key-suggestions">
                      {OVERRIDE_SUGGESTIONS.map((s) => (
                        <option key={s} value={s} />
                      ))}
                    </datalist>
                  </div>
                  <div>
                    <Label className="field-label">Enabled</Label>
                    <Select value={ovEnabled} onValueChange={setOvEnabled}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="inherit">Inherit plan</SelectItem>
                        <SelectItem value="true">Force on</SelectItem>
                        <SelectItem value="false">Force off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="field-label">Limit (optional)</Label>
                    <Input
                      type="number"
                      className="field"
                      placeholder="e.g. 40"
                      value={ovLimit}
                      onChange={(e) => setOvLimit(e.target.value)}
                    />
                  </div>
                  <div>
                    <Label className="field-label">Note (optional)</Label>
                    <Input className="field" placeholder="Why this override exists" value={ovNote} onChange={(e) => setOvNote(e.target.value)} />
                  </div>
                </div>
                <button className="btn-brass" disabled={detailBusy || !ovKey.trim()} onClick={() => void submitOverride()}>
                  <Plus className="h-4 w-4" /> Save override
                </button>
              </div>
            </div>
          )}

          <DialogFooter>
            <button className="btn-ghost" onClick={() => setDetailSub(null)}>
              Close
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel confirm */}
      <AlertDialog open={cancelSub !== null} onOpenChange={(o) => { if (!o) setCancelSub(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelSub?.property.name}&rsquo;s subscription?</AlertDialogTitle>
            <AlertDialogDescription>
              The workspace locks immediately and data is retained for 60 days. Pending invoices stay due. This action is
              written to the platform audit trail.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep subscription</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={(e) => {
                e.preventDefault();
                void submitCancel();
              }}
            >
              {cancelBusy ? "Cancelling…" : "Cancel subscription"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
