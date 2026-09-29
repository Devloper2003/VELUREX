"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, AlertTriangle, Ban, Building2, CalendarClock, Check, ChevronLeft, ChevronRight,
  Copy, CreditCard, Eye, Gauge, HeartPulse, History, Info, KeyRound, LifeBuoy, Loader2, Lock,
  MapPin, MessageCircle, MoreVertical, Play, Plug, Plus, RefreshCw, RotateCcw, Save,
  Search, ShieldCheck, Trash2, Unplug, Users, Webhook,
} from "lucide-react";
import {
  useOwnerApi, inr, fmtDate, fmtDateTime, relativeDays, StatusBadge, HealthDot,
  EmptyState, Loading, ErrorState, cap, pct, usePolling,
} from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import { useOwner } from "@/lib/owner-store";
import { startImpersonation } from "@/components/owner/impersonate-client";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ─── types (API contracts) ──────────────────────────────────────────────── */

interface PlanOpt { id: string; code: string; name: string; monthlyPrice: number; active: boolean }

interface BizAdmin { id: string; name: string; email: string; active: boolean }

interface BizListItem {
  id: string; name: string; type: string; category: string; city: string; state: string;
  phone: string; email: string; status: string; healthScore: number; notes: string;
  createdAt: string;
  plan: { id: string; code: string; name: string; monthlyPrice: number } | null;
  subscription: { id: string; cycle: string; status: string; renewalAt: string | null; trialEndsAt: string | null; autoRenew: boolean } | null;
  admins: BizAdmin[]; rooms: number; staffCount: number;
}

interface ListResp { businesses: BizListItem[]; total: number; page: number; pageSize: number; pages: number }

interface DetailBusiness {
  id: string; name: string; address: string; city: string; state: string; phone: string;
  email: string; gstin: string; type: string; category: string; status: string;
  trialEndsAt: string | null; healthScore: number; notes: string; deletedAt: string | null; createdAt: string;
}

interface BizDetail {
  business: DetailBusiness;
  plan: { code: string; name: string; monthlyPrice: number } | null;
  subscription: { cycle: string; status: string; renewalAt: string | null; trialEndsAt: string | null; autoRenew: boolean; pendingPlanId: string | null } | null;
  entitlements: {
    features: Record<string, boolean | number | string>;
    limits: Record<string, number>;
    addons: { addonKey: string; label: string; qty: number; price: number; oneOff: boolean }[];
    overrides: { featureKey: string; enabled: boolean | null; limitValue: number | null; note: string }[];
    writable: boolean;
    warning: string | null;
  };
  usage: { rooms: number; staff: number; bookings: number; whatsappMsgs: number };
  staff: { id: string; name: string; email: string; role: string; active: boolean; lastLoginAt: string | null }[];
  checklist: { roomsAdded: boolean; staffCreated: boolean; otaConnected: boolean; firstBooking: boolean; credentialsSent: boolean; whatsappConnected: boolean };
  whatsapp: {
    displayPhone: string; phoneNumberId: string; wabaId: string;
    connected: boolean; status: string; lastError: string;
    connectedAt: string | null; lastCheckedAt: string | null;
  } | null;
  invoices: { id: string; number: string; status: string; totalAmount: number; dueDate: string | null; paidAt: string | null; createdAt: string }[];
  auditTrail: { id: string; action: string; details: string; actorName: string; createdAt: string }[];
  usageHistory: { date: string; roomsUsed: number; staffUsed: number; bookings: number; whatsappMsgs: number }[];
}

/* Owner-side per-tenant WhatsApp provisioning API (GET/PUT …/whatsapp). */
interface WaConfig {
  displayPhone: string; phoneNumberId: string; wabaId: string;
  status: string; lastError: string | null; lastCheckedAt: string | null;
  connectedAt: string | null; tokenMasked: string | null; verifyToken: string | null;
}
interface WaResp { config: WaConfig | null; webhookUrl: string }
type WaActionKind = "save" | "test" | "disconnect";

const STATUS_OPTIONS = ["active", "trial", "overdue", "suspended", "cancelled", "deleted"] as const;
const PROPERTY_TYPES = ["Hotel", "Resort", "Homestay", "Serviced Apartments", "Boutique Hotel"];
const LIMIT_LABELS: Record<string, string> = {
  rooms: "Rooms", staff: "Staff", properties: "Properties", ota_channels: "OTA channels", whatsapp_msgs: "WhatsApp msgs/mo",
};

/** Adapter: build a row-shaped item from the detail payload so row dialogs work from the drawer too. */
function toRowItem(d: BizDetail): BizListItem {
  return {
    id: d.business.id,
    name: d.business.name,
    type: d.business.type,
    category: d.business.category,
    city: d.business.city,
    state: d.business.state,
    phone: d.business.phone,
    email: d.business.email,
    status: d.business.status,
    healthScore: d.business.healthScore,
    notes: d.business.notes,
    createdAt: d.business.createdAt,
    plan: null,
    subscription: null,
    admins: [],
    rooms: d.usage.rooms,
    staffCount: d.usage.staff,
  };
}

/** Section header — icon chip + title/sub on the left, right-aligned actions. */
function SectionHead({
  icon: Icon, title, sub, actions,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className="icon-chip icon-chip-pine shrink-0"><Icon className="h-4 w-4" /></span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold text-pine leading-tight">{title}</p>
          {sub && <p className="text-[11.5px] text-muted-ink leading-tight mt-0.5">{sub}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

export default function BusinessesView() {
  const api = useOwnerApi();
  const { toast } = useToast();
  const setView = useOwner((s) => s.setView);

  /* list state */
  const [rows, setRows] = useState<BizListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  /* filters */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [planFilter, setPlanFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [plans, setPlans] = useState<PlanOpt[]>([]);

  /* row action state */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [suspendTarget, setSuspendTarget] = useState<BizListItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BizListItem | null>(null);
  const [planChange, setPlanChange] = useState<{ biz: BizListItem; planId: string; cycle: string } | null>(null);
  const [trialExt, setTrialExt] = useState<{ biz: BizListItem; days: string } | null>(null);

  /* detail drawer */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BizDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [profile, setProfile] = useState({ name: "", type: "Hotel", category: "", city: "", state: "", phone: "", email: "", gstin: "" });
  const [notesDraft, setNotesDraft] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingNotes, setSavingNotes] = useState(false);

  /* WhatsApp tab (owner-side provisioning API) */
  const [wa, setWa] = useState<WaResp | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waErr, setWaErr] = useState<string | null>(null);
  const [waForm, setWaForm] = useState({ displayPhone: "", phoneNumberId: "", wabaId: "", accessToken: "", verifyToken: "" });
  const [waBusy, setWaBusy] = useState<WaActionKind | "">("");
  const [waConfirmDisconnect, setWaConfirmDisconnect] = useState(false);

  const pageSize = 10;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) qs.set("search", search);
      if (planFilter !== "all") qs.set("plan", planFilter);
      if (statusFilter !== "all") qs.set("status", statusFilter);
      const d = await api<ListResp>(`/api/owner/businesses?${qs.toString()}`);
      setRows(d.businesses ?? []);
      setTotal(d.total ?? 0);
      setPages(Math.max(1, d.pages ?? 1));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [api, search, planFilter, statusFilter, page]);

  const loadPlans = useCallback(async () => {
    try {
      const d = await api<{ plans: PlanOpt[] }>("/api/owner/plans");
      setPlans(d.plans ?? []);
    } catch { /* filter dropdown stays empty */ }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadPlans(); }, [loadPlans]);
  usePolling(() => { void load(); }, 30000);

  /* debounce search */
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => { setPage(1); }, [search, planFilter, statusFilter]);

  /* ── WhatsApp config (defensive: endpoint may 404 while shipping) ──── */

  const applyWaResp = (d: WaResp) => {
    setWa(d);
    setWaForm((f) => ({
      displayPhone: d.config?.displayPhone ?? f.displayPhone,
      phoneNumberId: d.config?.phoneNumberId ?? f.phoneNumberId,
      wabaId: d.config?.wabaId ?? f.wabaId,
      accessToken: "",
      verifyToken: d.config?.verifyToken ?? f.verifyToken,
    }));
  };

  const loadWhatsApp = useCallback(async (id: string) => {
    setWaLoading(true);
    setWaErr(null);
    try {
      const d = await api<WaResp>(`/api/owner/businesses/${id}/whatsapp`);
      setWa(d);
      setWaForm({
        displayPhone: d.config?.displayPhone ?? "",
        phoneNumberId: d.config?.phoneNumberId ?? "",
        wabaId: d.config?.wabaId ?? "",
        accessToken: "",
        verifyToken: d.config?.verifyToken ?? "",
      });
    } catch (e) {
      setWa(null);
      setWaErr(String((e as Error).message));
    } finally {
      setWaLoading(false);
    }
  }, [api]);

  const waAction = async (action: WaActionKind) => {
    if (!detailId) return;
    setWaBusy(action);
    try {
      const body: Record<string, unknown> = {
        displayPhone: waForm.displayPhone.trim(),
        phoneNumberId: waForm.phoneNumberId.trim(),
        wabaId: waForm.wabaId.trim(),
        action,
      };
      if (action !== "disconnect") {
        if (waForm.verifyToken.trim()) body.verifyToken = waForm.verifyToken.trim();
        if (waForm.accessToken.trim()) body.accessToken = waForm.accessToken.trim();
      }
      const d = await api<WaResp>(`/api/owner/businesses/${detailId}/whatsapp`, { method: "PUT", body: JSON.stringify(body) });
      applyWaResp(d);
      if (action === "save") {
        toast({ title: "WhatsApp settings saved", description: d.config?.status ? `Status: ${d.config.status}` : undefined });
      } else if (action === "test") {
        if (d.config?.status === "connected") {
          toast({ title: "Connection test passed", description: "Meta verified these credentials." });
        } else {
          toast({ title: "Connection test failed", description: d.config?.lastError ?? "Unexpected response", variant: "destructive" });
        }
      } else {
        toast({ title: "WhatsApp disconnected", description: "Saved credentials were cleared for this tenant." });
      }
    } catch (e) {
      toast({ title: `WhatsApp ${action} failed`, description: String((e as Error).message), variant: "destructive" });
    } finally {
      setWaBusy("");
      setWaConfirmDisconnect(false);
    }
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${label} is on your clipboard.` });
    } catch {
      toast({ title: "Copy failed", description: `Select the ${label.toLowerCase()} and copy manually.`, variant: "destructive" });
    }
  };

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailErr(null);
    try {
      const d = await api<BizDetail>(`/api/owner/businesses/${id}`);
      setDetail(d);
      setDetailId(id);
      setProfile({
        name: d.business.name ?? "", type: d.business.type || "Hotel", category: d.business.category ?? "",
        city: d.business.city ?? "", state: d.business.state ?? "", phone: d.business.phone ?? "",
        email: d.business.email ?? "", gstin: d.business.gstin ?? "",
      });
      setNotesDraft(d.business.notes ?? "");
      void loadWhatsApp(id);
    } catch (e) {
      setDetailErr(String((e as Error).message));
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, [api, loadWhatsApp]);

  const openDetail = (b: BizListItem) => {
    setDetail(null);
    void loadDetail(b.id);
  };

  const closeDetail = (open: boolean) => {
    if (!open) {
      setDetailId(null);
      setWa(null);
      setWaErr(null);
    }
  };

  /** Generic PATCH action wrapper with toasts + list refresh. */
  const runAction = async (b: BizListItem, body: Record<string, unknown>, done: string) => {
    setBusyId(b.id);
    try {
      await api<{ ok: boolean }>(`/api/owner/businesses/${b.id}`, { method: "PATCH", body: JSON.stringify(body) });
      toast({ title: done, description: b.name });
      await load();
      if (detailId === b.id) await loadDetail(b.id);
    } catch (e) {
      toast({ title: "Action failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const impersonate = async (b: BizListItem) => {
    try {
      await startImpersonation(b.id, b.name);
      // The whole SPA swaps into the tenant workspace automatically (banner appears; owner session parked).
    } catch (e) {
      toast({ title: "Cannot impersonate", description: String((e as Error).message), variant: "destructive" });
    }
  };

  const submitPlanChange = async () => {
    if (!planChange) return;
    const { biz, planId, cycle } = planChange;
    setBusyId(biz.id);
    try {
      const r = await api<{ ok: boolean; invoiceNumber: string | null; upgrade: boolean }>(
        `/api/owner/businesses/${biz.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "change_plan", planId, cycle }) }
      );
      toast({
        title: r.upgrade ? "Plan upgraded" : "Plan changed",
        description: r.invoiceNumber ? `Prorated invoice ${r.invoiceNumber} created` : biz.name,
      });
      setPlanChange(null);
      await load();
      if (detailId === biz.id) await loadDetail(biz.id);
    } catch (e) {
      toast({ title: "Plan change failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const submitTrialExtension = async () => {
    if (!trialExt) return;
    const days = parseInt(trialExt.days, 10);
    if (!Number.isFinite(days) || days < 1) {
      toast({ title: "Enter a valid number of days", variant: "destructive" });
      return;
    }
    const biz = trialExt.biz;
    setBusyId(biz.id);
    try {
      const r = await api<{ ok: boolean; trialEndsAt: string }>(
        `/api/owner/businesses/${biz.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "extend_trial", days }) }
      );
      toast({ title: `Trial extended by ${days} days`, description: `Now ends ${fmtDate(r.trialEndsAt)}` });
      setTrialExt(null);
      await load();
      if (detailId === biz.id) await loadDetail(biz.id);
    } catch (e) {
      toast({ title: "Trial extension failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const saveProfile = async () => {
    if (!detail) return;
    setSavingProfile(true);
    try {
      await api<{ ok: boolean }>(`/api/owner/businesses/${detail.business.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "edit", ...profile }),
      });
      toast({ title: "Profile saved", description: profile.name });
      await load();
      await loadDetail(detail.business.id);
    } catch (e) {
      toast({ title: "Save failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setSavingProfile(false);
    }
  };

  const saveNotes = async () => {
    if (!detail) return;
    setSavingNotes(true);
    try {
      await api<{ ok: boolean }>(`/api/owner/businesses/${detail.business.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "notes", notes: notesDraft }),
      });
      toast({ title: "Notes saved" });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setSavingNotes(false);
    }
  };

  const featureList = useMemo(() => {
    if (!detail) return [];
    return Object.entries(detail.entitlements.features)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k, v]) => ({ key: k, on: v === true }));
  }, [detail]);

  const limitRows = useMemo(() => {
    if (!detail) return [];
    const usageByKey: Record<string, number> = {
      rooms: detail.usage.rooms, staff: detail.usage.staff, whatsapp_msgs: detail.usage.whatsappMsgs,
    };
    return Object.entries(detail.entitlements.limits).map(([k, v]) => ({
      key: k, label: LIMIT_LABELS[k] ?? k, cap: v as number, used: usageByKey[k] ?? null,
    }));
  }, [detail]);

  const maxHistoryBookings = useMemo(
    () => Math.max(1, ...(detail?.usageHistory ?? []).map((h) => h.bookings)),
    [detail]
  );

  const hasFilters = search !== "" || planFilter !== "all" || statusFilter !== "all";

  /* WhatsApp display helpers */
  const waConfig = wa?.config ?? null;
  const waStatusPill = !waConfig ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-plaster px-2.5 py-1 text-[11px] font-semibold text-muted-ink">
      <span className="h-1.5 w-1.5 rounded-full bg-line-strong" /> Not configured
    </span>
  ) : waConfig.status === "connected" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-ok/40 bg-ok/10 px-2.5 py-1 text-[11px] font-semibold text-ok">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" /> Connected
    </span>
  ) : waConfig.status === "error" ? (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-danger/40 bg-danger/10 px-2.5 py-1 text-[11px] font-semibold text-danger">
      <span className="h-1.5 w-1.5 rounded-full bg-danger" /> Error
    </span>
  ) : (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-warn/40 bg-warn/10 px-2.5 py-1 text-[11px] font-semibold text-warn capitalize">
      <span className="h-1.5 w-1.5 rounded-full bg-warn" /> {waConfig.status || "disconnected"}
    </span>
  );

  /* ─── render ─────────────────────────────────────────────────────────── */

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="panel p-3 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink pointer-events-none" />
          <input
            className="field pl-9"
            placeholder="Search businesses by name, city, email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search businesses"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={planFilter} onValueChange={setPlanFilter}>
            <SelectTrigger className="w-[170px] h-9" aria-label="Filter by plan">
              <SelectValue placeholder="All plans" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All plans</SelectItem>
              {plans.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}{p.active ? "" : " (inactive)"}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[160px] h-9" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <button className="btn-pine" onClick={() => setView("add-business")}>
            <Plus className="h-4 w-4" /> Add Business
          </button>
        </div>
      </div>

      {/* table */}
      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title flex items-center gap-2"><Building2 className="h-4 w-4 text-brass" /> Businesses</h2>
          <span className="text-xs text-muted-ink">{total} on platform</span>
        </div>
        {loading ? (
          <Loading label="Loading businesses…" />
        ) : err ? (
          <ErrorState message={err} onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          <>
            <EmptyState
              icon={Building2}
              title={hasFilters ? "No businesses match these filters" : "No businesses yet"}
              hint={hasFilters ? "Try clearing the search or switching the plan/status filters." : "Onboard your first property with Add Business — it takes under a minute."}
            />
            {!hasFilters && (
              <div className="flex justify-center pb-8 -mt-2">
                <button className="btn-pine" onClick={() => setView("add-business")}>
                  <Plus className="h-4 w-4" /> Onboard first business
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead>
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Plan</th>
                  <th className="th">Status</th>
                  <th className="th">Rooms</th>
                  <th className="th">Staff</th>
                  <th className="th">Admin</th>
                  <th className="th">Health</th>
                  <th className="th">Renewal</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((b) => (
                  <tr
                    key={b.id}
                    className="cursor-pointer hover:bg-plaster/40 transition"
                    onClick={() => openDetail(b)}
                    title="Open business details"
                  >
                    <td className="td">
                      <button className="text-left group" onClick={() => openDetail(b)} title="View details">
                        <span className="block text-sm font-medium text-pine group-hover:text-brass transition">{b.name}</span>
                        <span className="flex items-center gap-1 text-[11px] text-muted-ink mt-0.5">
                          <MapPin className="h-3 w-3" />{b.city || "—"}
                          <span className="mx-1 text-line-strong">·</span>{b.type || "—"}
                        </span>
                      </button>
                    </td>
                    <td className="td">
                      {b.plan ? (
                        <span className="badge border-brass/40 bg-brass-50 text-brass" title={inr(b.plan.monthlyPrice) + "/mo"}>
                          {b.plan.name}
                        </span>
                      ) : (
                        <span className="text-muted-ink">—</span>
                      )}
                    </td>
                    <td className="td"><StatusBadge status={b.status} /></td>
                    <td className="td tabular-nums">{b.rooms}</td>
                    <td className="td tabular-nums">{b.staffCount}</td>
                    <td className="td">
                      {b.admins.length === 0 ? (
                        <span className="text-muted-ink text-xs">No admin</span>
                      ) : (
                        <>
                          <span className="block text-[13px] text-ink">{b.admins[0].name}</span>
                          <span className="block text-[11px] text-muted-ink truncate max-w-[180px]">{b.admins[0].email}</span>
                          {b.admins.length > 1 && <span className="text-[11px] text-brass">+{b.admins.length - 1} more</span>}
                        </>
                      )}
                    </td>
                    <td className="td"><HealthDot score={b.healthScore} /></td>
                    <td className="td whitespace-nowrap text-muted-ink text-[13px]">
                      {b.subscription?.renewalAt ? relativeDays(b.subscription.renewalAt) : "—"}
                    </td>
                    <td className="td text-right" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="btn-ghost h-8 w-8 p-0" aria-label={`Actions for ${b.name}`} disabled={busyId === b.id}>
                            <MoreVertical className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => openDetail(b)}>
                            <Eye className="h-3.5 w-3.5 mr-2" /> View details
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void impersonate(b)}>
                            <KeyRound className="h-3.5 w-3.5 mr-2" /> Login as
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setPlanChange({ biz: b, planId: b.plan?.id ?? "", cycle: b.subscription?.cycle ?? "monthly" })}>
                            <CreditCard className="h-3.5 w-3.5 mr-2" /> Change plan
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setTrialExt({ biz: b, days: "7" })}>
                            <CalendarClock className="h-3.5 w-3.5 mr-2" /> Extend trial
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {b.status === "deleted" ? (
                            <DropdownMenuItem onClick={() => void runAction(b, { action: "restore" }, "Business restored")} className="text-ok focus:text-ok">
                              <RotateCcw className="h-3.5 w-3.5 mr-2" /> Restore
                            </DropdownMenuItem>
                          ) : b.status === "suspended" ? (
                            <DropdownMenuItem onClick={() => void runAction(b, { action: "activate" }, "Business activated")} className="text-ok focus:text-ok">
                              <Play className="h-3.5 w-3.5 mr-2" /> Activate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => setSuspendTarget(b)} className="text-warn focus:text-warn">
                              <Ban className="h-3.5 w-3.5 mr-2" /> Suspend
                            </DropdownMenuItem>
                          )}
                          {b.status !== "deleted" && (
                            <DropdownMenuItem onClick={() => setDeleteTarget(b)} className="text-danger focus:text-danger">
                              <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete (soft)
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* pagination footer */}
        {!loading && !err && rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line">
            <span className="text-xs text-muted-ink">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button className="btn-outline h-8" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="text-xs text-muted-ink tabular-nums">Page {page} / {pages}</span>
              <button className="btn-outline h-8" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── detail dialog — tabbed workspace ────────────────────────────── */}
      <Dialog open={detailId !== null} onOpenChange={closeDetail}>
        <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto scroll-slim bg-panel">
          {detailLoading && <Loading label="Loading business…" />}
          {detailErr && <ErrorState message={detailErr} onRetry={() => detailId && void loadDetail(detailId)} />}
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-xl text-pine flex flex-wrap items-center gap-2">
                  {detail.business.name}
                  <StatusBadge status={detail.business.status} />
                </DialogTitle>
                <DialogDescription>
                  {[detail.business.type, detail.business.category, detail.business.city].filter(Boolean).join(" · ")}
                  {" · "}Onboarded {fmtDate(detail.business.createdAt)}
                </DialogDescription>
              </DialogHeader>

              {detail.entitlements.warning && (
                <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-[13px] text-warn">
                  <LifeBuoy className="h-4 w-4 mt-0.5 shrink-0" />
                  <span>{detail.entitlements.warning}</span>
                </div>
              )}

              <Tabs defaultValue="overview">
                <TabsList className="flex-wrap h-auto">
                  <TabsTrigger value="overview">Overview</TabsTrigger>
                  <TabsTrigger value="subscription">Subscription</TabsTrigger>
                  <TabsTrigger value="users">Users</TabsTrigger>
                  <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
                  <TabsTrigger value="audit">Audit trail</TabsTrigger>
                </TabsList>

                {/* ═══ OVERVIEW — snapshot + editable info + notes ═══════ */}
                <TabsContent value="overview" className="space-y-4 pt-3">
                  {/* snapshot grid */}
                  <section>
                    <SectionHead icon={HeartPulse} title="Snapshot" sub="Key facts about this tenant, updated live." />
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-muted-ink">Status</p>
                        <p className="mt-1"><StatusBadge status={detail.business.status} /></p>
                      </div>
                      <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-muted-ink">Health</p>
                        <p className="mt-1.5"><HealthDot score={detail.business.healthScore} /></p>
                      </div>
                      <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-muted-ink">Onboarded</p>
                        <p className="text-[13px] font-medium text-pine mt-1">{fmtDate(detail.business.createdAt)}</p>
                      </div>
                      <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                        <p className="text-[11px] uppercase tracking-wider text-muted-ink">Trial ends</p>
                        <p className="text-[13px] font-medium text-pine mt-1">
                          {detail.business.trialEndsAt ? fmtDate(detail.business.trialEndsAt) : "—"}
                          {detail.business.trialEndsAt && (
                            <span className="block text-[11px] font-normal text-muted-ink">{relativeDays(detail.business.trialEndsAt)}</span>
                          )}
                        </p>
                      </div>
                    </div>
                  </section>

                  <div className="border-t border-line/70" aria-hidden />

                  {/* editable business info */}
                  <section>
                    <SectionHead
                      icon={Building2}
                      title="Business information"
                      sub="Contact, location and legal identity shown across the platform."
                      actions={
                        <button className="btn-pine h-8" onClick={() => void saveProfile()} disabled={savingProfile || !profile.name.trim()}>
                          {savingProfile ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          {savingProfile ? "Saving…" : "Save"}
                        </button>
                      }
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="sm:col-span-2">
                        <Label className="field-label" htmlFor="d-name">Business name *</Label>
                        <Input id="d-name" className="field" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
                      </div>
                      <div>
                        <Label className="field-label">Property type</Label>
                        <Select value={profile.type} onValueChange={(v) => setProfile({ ...profile, type: v })}>
                          <SelectTrigger className="h-9" aria-label="Property type"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {PROPERTY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                      <div>
                        <Label className="field-label" htmlFor="d-category">Category</Label>
                        <Input id="d-category" className="field" value={profile.category} onChange={(e) => setProfile({ ...profile, category: e.target.value })} placeholder="Luxury Hotel" />
                      </div>
                      <div className="sm:col-span-2">
                        <Label className="field-label">Address (from onboarding)</Label>
                        <p className="text-[13px] text-ink rounded-md border border-line bg-plaster/40 px-3 h-9 flex items-center truncate">
                          {detail.business.address || <span className="text-muted-ink">— not provided at onboarding —</span>}
                        </p>
                      </div>
                      <div>
                        <Label className="field-label" htmlFor="d-city">City</Label>
                        <Input id="d-city" className="field" value={profile.city} onChange={(e) => setProfile({ ...profile, city: e.target.value })} />
                      </div>
                      <div>
                        <Label className="field-label" htmlFor="d-state">State</Label>
                        <Input id="d-state" className="field" value={profile.state} onChange={(e) => setProfile({ ...profile, state: e.target.value })} />
                      </div>
                      <div>
                        <Label className="field-label" htmlFor="d-phone">Phone</Label>
                        <Input id="d-phone" className="field" value={profile.phone} onChange={(e) => setProfile({ ...profile, phone: e.target.value })} />
                      </div>
                      <div>
                        <Label className="field-label" htmlFor="d-email">Email</Label>
                        <Input id="d-email" className="field" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
                      </div>
                      <div className="sm:col-span-2">
                        <Label className="field-label" htmlFor="d-gstin">GSTIN</Label>
                        <Input id="d-gstin" className="field uppercase" value={profile.gstin} onChange={(e) => setProfile({ ...profile, gstin: e.target.value })} placeholder="27ABCDE1234F1Z5" />
                      </div>
                    </div>
                  </section>

                  <div className="border-t border-line/70" aria-hidden />

                  {/* internal notes */}
                  <section>
                    <SectionHead
                      icon={Lock}
                      title="Internal notes"
                      sub="Visible to platform staff only — never shown to the tenant."
                      actions={
                        <button className="btn-outline h-8" onClick={() => void saveNotes()} disabled={savingNotes}>
                          {savingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                          {savingNotes ? "Saving…" : "Save notes"}
                        </button>
                      }
                    />
                    <Textarea
                      className="min-h-[120px]"
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                      placeholder="Founder deals, credit notes, escalation history…"
                    />
                  </section>
                </TabsContent>

                {/* ═══ SUBSCRIPTION — plan, limits, features, invoices ═══ */}
                <TabsContent value="subscription" className="space-y-4 pt-3">
                  {/* current plan card */}
                  <section className="rounded-lg border border-line bg-plaster/50 p-4 flex flex-col sm:flex-row sm:items-center gap-4">
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] uppercase tracking-wider text-muted-ink">Current plan</p>
                      <p className="font-display text-lg font-semibold text-pine">
                        {detail.plan?.name ?? "—"}
                        <span className="text-brass text-sm font-medium ml-2">{detail.plan ? `${inr(detail.plan.monthlyPrice)}/mo` : ""}</span>
                      </p>
                      <p className="text-xs text-muted-ink mt-1">
                        {detail.subscription ? (
                          <>
                            <span className="capitalize">{detail.subscription.cycle}</span> cycle · Status <span className="capitalize">{detail.subscription.status}</span>
                            {detail.subscription.renewalAt && <> · Renews {fmtDate(detail.subscription.renewalAt)} ({relativeDays(detail.subscription.renewalAt)})</>}
                            {detail.subscription.trialEndsAt && <> · Trial ends {fmtDate(detail.subscription.trialEndsAt)}</>}
                            {detail.subscription.pendingPlanId && <> · Pending plan change scheduled</>}
                          </>
                        ) : "No subscription"}
                      </p>
                      <p className="text-[11px] text-muted-ink mt-1 flex items-center gap-1">
                        <ShieldCheck className="h-3 w-3" />
                        {detail.subscription?.autoRenew
                          ? "Auto-renew is ON — invoices are raised automatically at renewal."
                          : "Auto-renew is OFF — renewals must be confirmed manually."}
                      </p>
                    </div>
                    <div className="flex sm:flex-col gap-2 shrink-0">
                      <button
                        className="btn-outline"
                        onClick={() => {
                          const biz = toRowItem(detail);
                          const current = plans.find((p) => p.code === detail.plan?.code);
                          setPlanChange({ biz, planId: current?.id ?? "", cycle: detail.subscription?.cycle ?? "monthly" });
                        }}
                      >
                        <CreditCard className="h-4 w-4" /> Change plan
                      </button>
                      <button className="btn-outline" onClick={() => setTrialExt({ biz: toRowItem(detail), days: "7" })}>
                        <CalendarClock className="h-4 w-4" /> Extend trial
                      </button>
                    </div>
                  </section>

                  {/* limits with usage bars */}
                  <section>
                    <SectionHead icon={Gauge} title="Limits & usage" sub="Live consumption against the plan entitlements." />
                    <div className="space-y-2.5">
                      {limitRows.map((l) => (
                        <div key={l.key}>
                          <div className="flex items-center justify-between text-[13px] mb-1">
                            <span className="text-ink">{l.label}</span>
                            <span className="text-muted-ink tabular-nums">
                              {l.used !== null ? `${l.used} / ${cap(l.cap)}` : `cap ${cap(l.cap)}`}
                            </span>
                          </div>
                          {l.used !== null && (
                            <Progress value={pct(l.used, l.cap)} className="h-1.5" aria-label={`${l.label} usage`} />
                          )}
                        </div>
                      ))}
                    </div>
                  </section>

                  {/* feature flags */}
                  {featureList.length > 0 && (
                    <section className="border-t border-line/70 pt-4">
                      <SectionHead icon={Check} title="Features" sub="Included in this plan." />
                      <div className="flex flex-wrap gap-1.5">
                        {featureList.map((f) => (
                          <span key={f.key} className={`badge ${f.on ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"}`}>
                            {f.key.replace(/_/g, " ")} · {f.on ? "on" : "off"}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* add-ons */}
                  <section className="border-t border-line/70 pt-4">
                    <SectionHead icon={Plus} title="Add-ons" />
                    {detail.entitlements.addons.length === 0 ? (
                      <p className="text-[13px] text-muted-ink">No add-ons on this subscription.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {detail.entitlements.addons.map((a) => (
                          <div key={a.addonKey} className="flex items-center justify-between text-[13px] border-b border-line/60 pb-1.5">
                            <span className="text-ink">{a.label}{a.qty > 1 ? ` ×${a.qty}` : ""}</span>
                            <span className="text-muted-ink">{inr(a.price)}{a.oneOff ? " one-off" : "/mo"}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* overrides */}
                  {detail.entitlements.overrides.length > 0 && (
                    <section className="border-t border-line/70 pt-4">
                      <SectionHead icon={CreditCard} title="Entitlement overrides" sub="Manual adjustments applied on top of the plan." />
                      <div className="space-y-1.5">
                        {detail.entitlements.overrides.map((o) => (
                          <div key={o.featureKey} className="rounded-md border border-brass/30 bg-brass-50 px-3 py-2 text-[13px]">
                            <span className="font-medium text-pine">{o.featureKey.replace(/_/g, " ")}</span>
                            {o.enabled !== null && <span className="text-brass ml-2">{o.enabled ? "forced on" : "forced off"}</span>}
                            {o.limitValue !== null && <span className="text-brass ml-2">limit → {o.limitValue}</span>}
                            {o.note && <span className="block text-[11px] text-muted-ink mt-0.5">{o.note}</span>}
                          </div>
                        ))}
                      </div>
                    </section>
                  )}

                  {/* usage history */}
                  <section className="border-t border-line/70 pt-4">
                    <SectionHead icon={Activity} title={`Daily usage — last ${detail.usageHistory.length} days`} />
                    {detail.usageHistory.length === 0 ? (
                      <p className="text-[13px] text-muted-ink">No usage snapshots recorded yet.</p>
                    ) : (
                      <div className="space-y-1.5 max-h-72 overflow-y-auto scroll-slim pr-1">
                        {detail.usageHistory.map((h) => (
                          <div key={h.date} className="flex items-center gap-2 text-[12px]">
                            <span className="w-20 shrink-0 text-muted-ink tabular-nums">{fmtDate(h.date)}</span>
                            <div className="flex-1 h-2.5 rounded-sm bg-plaster overflow-hidden" title={`${h.bookings} bookings · ${h.roomsUsed} rooms · ${h.staffUsed} staff · ${h.whatsappMsgs} WhatsApp`}>
                              <div className="h-full bg-pine-700/80 rounded-sm" style={{ width: `${Math.round((h.bookings / maxHistoryBookings) * 100)}%` }} />
                            </div>
                            <span className="w-10 text-right tabular-nums text-ink">{h.bookings}</span>
                            <span className="w-24 text-right text-muted-ink hidden sm:block tabular-nums">{h.roomsUsed} rm · {h.staffUsed} st</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* invoices */}
                  {detail.invoices.length > 0 && (
                    <section className="border-t border-line/70 pt-4">
                      <SectionHead icon={CreditCard} title="Recent invoices" sub="Billing history for this subscription." />
                      <div className="overflow-x-auto max-h-72 overflow-y-auto scroll-slim">
                        <table className="w-full min-w-[420px]">
                          <thead className="sticky top-0 z-10">
                            <tr><th className="th">Invoice</th><th className="th">Status</th><th className="th">Total</th><th className="th">Due</th></tr>
                          </thead>
                          <tbody>
                            {detail.invoices.map((inv) => (
                              <tr key={inv.id} className="transition-colors hover:bg-plaster/40">
                                <td className="td font-medium text-pine">{inv.number}</td>
                                <td className="td"><StatusBadge status={inv.status} /></td>
                                <td className="td tabular-nums">{inr(inv.totalAmount)}</td>
                                <td className="td text-muted-ink whitespace-nowrap">{fmtDate(inv.dueDate)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}
                </TabsContent>

                {/* ═══ USERS — staff accounts of this business ═══════════ */}
                <TabsContent value="users" className="pt-3">
                  <SectionHead icon={Users} title="Users" sub={`${detail.staff.length} staff account${detail.staff.length === 1 ? "" : "s"} in this workspace.`} />
                  {detail.staff.length === 0 ? (
                    <EmptyState icon={Users} title="No staff accounts yet" hint="Staff created for this business will appear here." />
                  ) : (
                    <div className="overflow-x-auto max-h-96 overflow-y-auto scroll-slim rounded-md border border-line">
                      <table className="w-full min-w-[560px]">
                        <thead className="sticky top-0 z-10">
                          <tr><th className="th">Name</th><th className="th">Email</th><th className="th">Role</th><th className="th">Status</th><th className="th">Last login</th></tr>
                        </thead>
                        <tbody>
                          {detail.staff.map((s) => (
                            <tr key={s.id} className="transition-colors hover:bg-plaster/40">
                              <td className="td font-medium text-pine">{s.name}</td>
                              <td className="td text-muted-ink">{s.email}</td>
                              <td className="td"><span className="badge border-line-strong bg-plaster text-muted-ink capitalize">{s.role.replace(/_/g, " ")}</span></td>
                              <td className="td"><StatusBadge status={s.active ? "active" : "suspended"} /></td>
                              <td className="td whitespace-nowrap text-muted-ink">{s.lastLoginAt ? fmtDateTime(s.lastLoginAt) : "never"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </TabsContent>

                {/* ═══ WHATSAPP — per-tenant Cloud API provisioning ══════ */}
                <TabsContent value="whatsapp" className="space-y-4 pt-3">
                  {waLoading && <Loading label="Checking WhatsApp configuration…" />}

                  {!waLoading && waErr && (
                    <div className="rounded-lg border border-warn/40 bg-warn/10 px-4 py-3.5 flex items-start gap-2.5">
                      <AlertTriangle className="h-4 w-4 mt-0.5 text-warn shrink-0" />
                      <div className="text-[13px]">
                        <p className="font-semibold text-warn">WhatsApp provisioning isn&apos;t available yet</p>
                        <p className="text-warn/90 mt-0.5 break-words">{waErr}</p>
                        <p className="text-[12px] text-muted-ink mt-1.5">
                          The tenant can still connect its own WhatsApp Cloud API from <span className="font-medium text-pine-700">Settings → WhatsApp API</span> in its workspace.
                        </p>
                      </div>
                    </div>
                  )}

                  {!waLoading && !waErr && wa && (
                    <>
                      {/* status card */}
                      <section className="rounded-lg border border-line bg-plaster/40 p-4">
                        <SectionHead
                          icon={MessageCircle}
                          title="Connection status"
                          sub="The tenant's own WhatsApp Cloud API — booking confirmations & guest chats."
                          actions={waStatusPill}
                        />
                        {waConfig ? (
                          <>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                              <div className="rounded-md border border-line bg-panel px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wider text-muted-ink">Display number</p>
                                <p className="text-[13px] font-medium text-pine mt-0.5">{waConfig.displayPhone || "—"}</p>
                              </div>
                              <div className="rounded-md border border-line bg-panel px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wider text-muted-ink">Phone Number ID</p>
                                <p className="text-[13px] font-medium text-pine mt-0.5 truncate" title={waConfig.phoneNumberId}>{waConfig.phoneNumberId || "—"}</p>
                              </div>
                              <div className="rounded-md border border-line bg-panel px-3 py-2.5">
                                <p className="text-[11px] uppercase tracking-wider text-muted-ink">WABA ID</p>
                                <p className="text-[13px] font-medium text-pine mt-0.5 truncate" title={waConfig.wabaId}>{waConfig.wabaId || "—"}</p>
                              </div>
                            </div>
                            {(waConfig.connectedAt || waConfig.lastCheckedAt) && (
                              <p className="text-[12px] text-muted-ink mt-3">
                                {waConfig.connectedAt ? <>Connected {fmtDateTime(waConfig.connectedAt)}</> : null}
                                {waConfig.connectedAt && waConfig.lastCheckedAt ? " · " : ""}
                                {waConfig.lastCheckedAt ? <>last checked {fmtDateTime(waConfig.lastCheckedAt)}</> : null}
                              </p>
                            )}
                            {waConfig.status === "error" && waConfig.lastError && (
                              <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger mt-3">
                                Last test failed: {waConfig.lastError}
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-md border border-dashed border-line-strong bg-panel/60 px-4 py-4">
                            <span className="icon-chip shrink-0"><Plug className="h-4 w-4" /></span>
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-semibold text-pine">Configure WhatsApp API for this tenant</p>
                              <p className="text-[12px] text-muted-ink mt-0.5">Save the tenant&apos;s Meta credentials below, then run a test to verify them.</p>
                            </div>
                            <button
                              className="btn-outline shrink-0"
                              onClick={() => document.getElementById("wa-phone-number-id")?.focus()}
                            >
                              <Plus className="h-4 w-4" /> Configure now
                            </button>
                          </div>
                        )}
                      </section>

                      {/* credential form */}
                      <section className="rounded-lg border border-line p-4">
                        <SectionHead
                          icon={KeyRound}
                          title="Connection details"
                          sub={waConfig?.tokenMasked
                            ? `Saved token ${waConfig.tokenMasked} — leave the field blank to keep it.`
                            : "Meta Cloud API credentials for this tenant's number."}
                        />
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <Label className="field-label" htmlFor="wa-display-phone">Display phone</Label>
                            <Input id="wa-display-phone" className="field" value={waForm.displayPhone} onChange={(e) => setWaForm({ ...waForm, displayPhone: e.target.value })} placeholder="+91 98200 00000" />
                          </div>
                          <div>
                            <Label className="field-label" htmlFor="wa-phone-number-id">Phone Number ID</Label>
                            <Input id="wa-phone-number-id" className="field" value={waForm.phoneNumberId} onChange={(e) => setWaForm({ ...waForm, phoneNumberId: e.target.value })} placeholder="123456789012345" />
                          </div>
                          <div>
                            <Label className="field-label" htmlFor="wa-waba-id">WABA ID</Label>
                            <Input id="wa-waba-id" className="field" value={waForm.wabaId} onChange={(e) => setWaForm({ ...waForm, wabaId: e.target.value })} placeholder="987654321098765" />
                          </div>
                          <div>
                            <Label className="field-label" htmlFor="wa-token">Access token</Label>
                            <Input
                              id="wa-token"
                              className="field"
                              type="password"
                              autoComplete="new-password"
                              value={waForm.accessToken}
                              onChange={(e) => setWaForm({ ...waForm, accessToken: e.target.value })}
                              placeholder={waConfig?.tokenMasked ? `saved ${waConfig.tokenMasked} — leave blank to keep` : "EAAG… permanent system-user token"}
                            />
                            <p className="text-[11px] text-muted-ink mt-1 flex items-center gap-1">
                              <Lock className="h-3 w-3" /> Encrypted at rest (AES-256-GCM); never displayed in full.
                            </p>
                          </div>
                          <div className="sm:col-span-2">
                            <Label className="field-label" htmlFor="wa-verify-token">Webhook verify token</Label>
                            <div className="flex items-center gap-2">
                              <Input id="wa-verify-token" className="field font-mono text-[13px]" value={waForm.verifyToken} onChange={(e) => setWaForm({ ...waForm, verifyToken: e.target.value })} placeholder="vx_…" />
                              <button className="btn-ghost h-9 shrink-0" onClick={() => void copyText(waForm.verifyToken, "Verify token")} disabled={!waForm.verifyToken}>
                                <Copy className="h-3.5 w-3.5" /> Copy
                              </button>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-line/70">
                          <button className="btn-pine" onClick={() => void waAction("save")} disabled={waBusy !== ""}>
                            {waBusy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Save
                          </button>
                          <button className="btn-outline" onClick={() => void waAction("test")} disabled={waBusy !== ""}>
                            {waBusy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                            Test connection
                          </button>
                          {waConfig && (
                            <button className="btn-danger ml-auto" onClick={() => setWaConfirmDisconnect(true)} disabled={waBusy !== ""}>
                              {waBusy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                              Disconnect
                            </button>
                          )}
                        </div>
                      </section>

                      {/* webhook pairing */}
                      <section className="rounded-lg border border-brass/30 bg-brass-50/60 px-4 py-3.5">
                        <SectionHead
                          icon={Webhook}
                          title="Webhook pairing"
                          sub="Paste both values in Meta → WhatsApp → Configuration → Webhook, then subscribe to the messages field."
                        />
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] uppercase tracking-wider text-muted-ink w-24 shrink-0">Callback URL</span>
                            <code className="flex-1 min-w-[200px] rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] font-mono text-pine break-all select-all">
                              {wa?.webhookUrl || "/api/whatsapp/webhook"}
                            </code>
                            <button className="btn-ghost h-8 shrink-0" onClick={() => void copyText(wa?.webhookUrl || "/api/whatsapp/webhook", "Callback URL")}>
                              <Copy className="h-3.5 w-3.5" /> Copy
                            </button>
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] uppercase tracking-wider text-muted-ink w-24 shrink-0">Verify token</span>
                            <code className="flex-1 min-w-[200px] rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12px] font-mono text-pine break-all select-all">
                              {waForm.verifyToken || "—"}
                            </code>
                            <button className="btn-ghost h-8 shrink-0" onClick={() => void copyText(waForm.verifyToken, "Verify token")} disabled={!waForm.verifyToken}>
                              <Copy className="h-3.5 w-3.5" /> Copy
                            </button>
                          </div>
                        </div>
                        <p className="text-[11.5px] text-muted-ink mt-2.5 flex items-start gap-1.5">
                          <Info className="h-3.5 w-3.5 mt-px shrink-0" />
                          Meta calls the callback URL with this verify token during setup; after pairing, inbound guest messages flow into the tenant workspace.
                        </p>
                      </section>
                    </>
                  )}
                </TabsContent>

                {/* ═══ AUDIT TRAIL ═══════════════════════════════════════ */}
                <TabsContent value="audit" className="pt-3">
                  <SectionHead icon={History} title="Audit trail" sub="Every platform action taken on this business." />
                  {detail.auditTrail.length === 0 ? (
                    <EmptyState icon={Activity} title="No activity yet" hint="Platform actions on this business will appear here." />
                  ) : (
                    <div className="space-y-2.5 max-h-96 overflow-y-auto scroll-slim pr-1">
                      {detail.auditTrail.map((a) => (
                        <div key={a.id} className="flex items-start gap-2.5 border-b border-line/60 pb-2.5">
                          <span className="badge border-brass/40 bg-brass-50 text-brass shrink-0 mt-0.5">{a.action.replace(/_/g, " ").toLowerCase()}</span>
                          <div className="min-w-0">
                            <p className="text-[13px] text-ink">{a.details}</p>
                            <p className="text-[11px] text-muted-ink">{a.actorName} · {fmtDateTime(a.createdAt)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </TabsContent>
              </Tabs>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── whatsapp disconnect confirm ─────────────────────────────────── */}
      <AlertDialog open={waConfirmDisconnect} onOpenChange={setWaConfirmDisconnect}>
        <AlertDialogContent className="bg-panel">
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect WhatsApp for {detail?.business.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              The saved access token is deleted and the connection status resets. Phone Number ID / WABA ID are kept
              so the tenant can reconnect quickly. Inbound webhooks for this tenant stop processing. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => void waAction("disconnect")}
            >
              <Unplug className="h-4 w-4 mr-1.5" /> Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── suspend confirm ─────────────────────────────────────────────── */}
      <AlertDialog open={suspendTarget !== null} onOpenChange={(o) => { if (!o) setSuspendTarget(null); }}>
        <AlertDialogContent className="bg-panel">
          <AlertDialogHeader>
            <AlertDialogTitle>Suspend {suspendTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Login will be blocked for all staff and the workspace becomes read-only. All data is retained
              and the business can be re-activated at any time. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-warn text-white hover:bg-warn/90"
              onClick={() => { if (suspendTarget) void runAction(suspendTarget, { action: "suspend" }, "Business suspended"); setSuspendTarget(null); }}
            >
              Suspend business
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── soft delete confirm ─────────────────────────────────────────── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent className="bg-panel">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This is a <strong>soft delete</strong>: login is blocked immediately and all data is retained
              for 60 days before any purge. Nothing is hard-deleted — the business can be restored from this
              list at any time within the window. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => { if (deleteTarget) void runAction(deleteTarget, { action: "soft_delete" }, "Business soft-deleted — data retained 60 days"); setDeleteTarget(null); }}
            >
              <Trash2 className="h-4 w-4 mr-1.5" /> Soft delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── change plan dialog ──────────────────────────────────────────── */}
      <Dialog open={planChange !== null} onOpenChange={(o) => { if (!o) setPlanChange(null); }}>
        <DialogContent className="max-w-md bg-panel">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">Change plan — {planChange?.biz.name}</DialogTitle>
            <DialogDescription>Upgrades are charged prorated for the remaining cycle; a pending invoice is created.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="field-label">Plan</Label>
              <Select
                value={planChange?.planId ?? ""}
                onValueChange={(v) => setPlanChange((pc) => (pc ? { ...pc, planId: v } : pc))}
              >
                <SelectTrigger className="h-9"><SelectValue placeholder="Choose plan" /></SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} — {inr(p.monthlyPrice)}/mo</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="field-label">Billing cycle</Label>
              <Select
                value={planChange?.cycle ?? "monthly"}
                onValueChange={(v) => setPlanChange((pc) => (pc ? { ...pc, cycle: v } : pc))}
              >
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                  <SelectItem value="yearly">Yearly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setPlanChange(null)}>Cancel</button>
            <button className="btn-pine" onClick={() => void submitPlanChange()} disabled={busyId !== null || !planChange?.planId}>
              {busyId ? "Applying…" : "Apply change"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── extend trial dialog ─────────────────────────────────────────── */}
      <Dialog open={trialExt !== null} onOpenChange={(o) => { if (!o) setTrialExt(null); }}>
        <DialogContent className="max-w-sm bg-panel">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">Extend trial — {trialExt?.biz.name}</DialogTitle>
            <DialogDescription>Adds days on top of the current trial end date and flips the status back to trial.</DialogDescription>
          </DialogHeader>
          <div>
            <Label className="field-label">Days to extend</Label>
            <Input
              className="field"
              type="number"
              min={1}
              value={trialExt?.days ?? "7"}
              onChange={(e) => setTrialExt((t) => (t ? { ...t, days: e.target.value } : t))}
            />
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setTrialExt(null)}>Cancel</button>
            <button className="btn-brass" onClick={() => void submitTrialExtension()} disabled={busyId !== null}>
              <CalendarClock className="h-4 w-4" /> Extend
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
