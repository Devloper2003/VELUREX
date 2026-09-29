"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck, Building2, Check, ChevronLeft, ChevronRight, Copy, Eye, EyeOff,
  Info, KeyRound, Loader2, MailCheck, MapPin, Save, ShieldCheck, Sparkles,
  UserRound, Users, Wallet,
} from "lucide-react";
import { useOwnerApi, inr } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import { useOwner } from "@/lib/owner-store";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/* ─── types (API contracts) ──────────────────────────────────────────────── */

interface PlanOpt {
  id: string; code: string; name: string; description: string;
  monthlyPrice: number; active: boolean; subscribers?: number;
  features?: Record<string, unknown>;
}

interface CreateResp {
  business: { id: string; name: string };
  admin: { id: string; email: string };
  subscription: { id: string; status: string };
  tempPassword?: string;
  credentialsSent: boolean;
  credentialsChannel: string;
}

type Cycle = "monthly" | "quarterly" | "yearly";
const CYCLES: Cycle[] = ["monthly", "quarterly", "yearly"];
const CYCLE_LABEL: Record<Cycle, string> = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const CYCLE_MONTHS: Record<Cycle, number> = { monthly: 1, quarterly: 3, yearly: 12 };

const PROPERTY_TYPES = ["Hotel", "Resort", "Homestay", "Serviced Apartments", "Boutique Hotel"];

const EMPTY_FORM = {
  name: "", propertyType: "Hotel", category: "", address: "", city: "", state: "",
  phone: "", email: "", gstin: "",
  adminName: "", adminEmail: "", adminPhone: "",
  planId: "", cycle: "monthly" as Cycle, trialDays: "", couponCode: "",
  setupFee: "", sendCredentials: true,
};

const STEPS = [
  { key: "business", label: "Business details", icon: Building2 },
  { key: "admin", label: "Admin account", icon: UserRound },
  { key: "plan", label: "Plan & billing", icon: Sparkles },
] as const;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Compact "key limits" chips derived from the plan's features JSON (mirrors LIMIT_LABELS semantics). */
function planLimitChips(p: PlanOpt): string[] {
  const f = p.features ?? {};
  const chips: string[] = [];
  const lim = (v: unknown, unit: string) => {
    if (typeof v !== "number") return;
    chips.push(`${v === -1 ? "∞" : v} ${unit}`);
  };
  lim(f.rooms, "rooms");
  lim(f.staff, "staff");
  lim(f.properties, "properties");
  lim(f.whatsapp_msgs, "WA msgs/mo");
  return chips.slice(0, 4);
}

export default function AddBusinessView() {
  const api = useOwnerApi();
  const { toast } = useToast();
  const setView = useOwner((s) => s.setView);

  const [step, setStep] = useState(0);
  const [plans, setPlans] = useState<PlanOpt[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [cycleDiscounts, setCycleDiscounts] = useState<{ quarterly: number; yearly: number } | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [submitting, setSubmitting] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<CreateResp | null>(null);
  const [showTempPassword, setShowTempPassword] = useState(false);

  /* ── data loading ──────────────────────────────────────────────────── */

  const loadPlans = useCallback(async () => {
    setPlansLoading(true);
    try {
      const d = await api<{ plans: PlanOpt[] }>("/api/owner/plans");
      const active = (d.plans ?? []).filter((p) => p.active);
      setPlans(active);
      setForm((f) => (f.planId === "" && active.length > 0 ? { ...f, planId: active[0].id } : f));
    } catch (e) {
      toast({ title: "Could not load plans", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setPlansLoading(false);
    }
  }, [api, toast]);

  /* Cycle discounts come from Platform Settings (billing group) — same source
     the backend's cyclePrice() uses, so displayed prices match real invoices.
     Falls back to the backend defaults (5% quarterly / 10% yearly). */
  const loadDiscounts = useCallback(async () => {
    try {
      const d = await api<{ groups: { group: string; settings: { key: string; configured: boolean; preview: string }[] }[] }>("/api/owner/settings");
      const billing = d.groups?.find((g) => g.group === "billing");
      const read = (key: string, fallback: number) => {
        const row = billing?.settings?.find((s) => s.key === key);
        const n = row?.configured ? Number(row.preview) : NaN;
        return Number.isFinite(n) && n >= 0 && n <= 90 ? n : fallback;
      };
      setCycleDiscounts({ quarterly: read("quarterly_discount_percent", 5), yearly: read("yearly_discount_percent", 10) });
    } catch {
      setCycleDiscounts({ quarterly: 5, yearly: 10 });
    }
  }, [api]);

  useEffect(() => { void loadPlans(); void loadDiscounts(); }, [loadPlans, loadDiscounts]);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  /* ── pricing helpers (mirror lib/platform cyclePrice) ──────────────── */

  const discounts = cycleDiscounts ?? { quarterly: 5, yearly: 10 };
  const priceForCycle = useCallback((monthly: number, cycle: Cycle) => {
    if (cycle === "yearly") return Math.round(monthly * 12 * (1 - discounts.yearly / 100));
    if (cycle === "quarterly") return Math.round(monthly * 3 * (1 - discounts.quarterly / 100));
    return monthly;
  }, [discounts]);
  const discountFor = (cycle: Cycle) => (cycle === "yearly" ? discounts.yearly : cycle === "quarterly" ? discounts.quarterly : 0);

  const selectedPlan = plans.find((p) => p.id === form.planId) ?? null;

  /* ── per-step validation ───────────────────────────────────────────── */

  const stepError = useCallback((s: number): string | null => {
    if (s === 0) {
      if (!form.name.trim()) return "Business name is required.";
      if (form.email.trim() && !EMAIL_RE.test(form.email.trim())) return "The business email address is not valid.";
      return null;
    }
    if (s === 1) {
      if (!form.adminName.trim()) return "Admin name is required.";
      if (!EMAIL_RE.test(form.adminEmail.trim())) return "A valid admin email is required.";
      return null;
    }
    if (s === 2) {
      if (!form.planId) return "Choose a plan for this business.";
      if (form.trialDays.trim() !== "" && (!/^\d+$/.test(form.trialDays.trim()) || Number(form.trialDays) < 0))
        return "Trial days must be a whole number (0 or more).";
      if (form.setupFee.trim() !== "" && (!/^\d+(\.\d{1,2})?$/.test(form.setupFee.trim()) || Number(form.setupFee) < 0))
        return "Setup fee must be a positive amount.";
      return null;
    }
    return null;
  }, [form]);

  const goToStep = (target: number) => {
    setFormErr(null);
    setStep(target);
  };

  const continueStep = () => {
    const err = stepError(step);
    if (err) return setFormErr(err);
    setFormErr(null);
    setStep((s) => Math.min(STEPS.length - 1, s + 1));
  };

  /* ── submit (same endpoint & response handling as before) ──────────── */

  const submit = async () => {
    const err = stepError(0) ?? stepError(1) ?? stepError(2);
    if (err) return setFormErr(err);

    setSubmitting(true);
    setFormErr(null);
    try {
      const body = {
        name: form.name.trim(),
        address: form.address.trim() || undefined,
        city: form.city.trim() || undefined,
        state: form.state.trim() || undefined,
        phone: form.phone.trim() || undefined,
        email: form.email.trim() || undefined,
        propertyType: form.propertyType,
        category: form.category.trim() || undefined,
        gstin: form.gstin.trim() || undefined,
        adminName: form.adminName.trim(),
        adminEmail: form.adminEmail.trim().toLowerCase(),
        adminPhone: form.adminPhone.trim() || undefined,
        planId: form.planId,
        cycle: form.cycle,
        trialDays: form.trialDays.trim() === "" ? null : Number(form.trialDays),
        couponCode: form.couponCode.trim() || undefined,
        setupFee: form.setupFee.trim() === "" ? undefined : Number(form.setupFee),
        sendCredentials: form.sendCredentials,
      };
      const r = await api<CreateResp>("/api/owner/businesses", { method: "POST", body: JSON.stringify(body) });
      setSuccess(r);
      setShowTempPassword(false);
      toast({ title: "Business onboarded", description: `${r.business.name} · admin ${r.admin.email}` });
    } catch (e) {
      const msg = String((e as Error).message);
      setFormErr(msg);
      toast({ title: "Could not create business", description: msg, variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  const resetForm = () => {
    setForm({ ...EMPTY_FORM, planId: plans[0]?.id ?? "" });
    setFormErr(null);
    setSuccess(null);
    setStep(0);
    setShowTempPassword(false);
  };

  const copyText = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied", description: `${label} is on your clipboard.` });
    } catch {
      toast({ title: "Copy failed", description: `Select the ${label.toLowerCase()} and copy manually.`, variant: "destructive" });
    }
  };

  const stepDone = (i: number) => i < step || (success !== null && i <= step);
  const stepInvalid = stepError(step);

  /* ═══ SUCCESS — credential handoff card ═════════════════════════════ */

  if (success) {
    const pwd = success.tempPassword ?? "";
    return (
      <div className="max-w-2xl mx-auto">
        <div className="panel p-6 sm:p-8">
          {/* head */}
          <div className="text-center">
            <span className="h-12 w-12 rounded-full bg-ok/10 border border-ok/30 flex items-center justify-center mx-auto mb-3">
              <Check className="h-6 w-6 text-ok" />
            </span>
            <h2 className="font-display text-xl font-semibold text-pine">Business onboarded</h2>
            <p className="text-sm text-muted-ink mt-1">The workspace is live. Share the admin credentials below.</p>
          </div>

          {/* handoff card */}
          <div className="mt-6 rounded-lg border border-line bg-plaster/40 overflow-hidden">
            <div className="px-4 py-2.5 border-b border-line flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-brass shrink-0" />
              <p className="text-[13px] font-semibold text-pine">Admin credential handoff</p>
              <span className="badge border-warn/40 bg-warn/10 text-warn ml-auto">
                <ShieldCheck className="h-3 w-3" /> shown only once
              </span>
            </div>

            <div className="p-4 space-y-3">
              {/* business */}
              <div className="flex items-center gap-2.5">
                <span className="icon-chip icon-chip-pine shrink-0"><Building2 className="h-4 w-4" /></span>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Business</p>
                  <p className="text-sm font-semibold text-pine truncate">{success.business.name}</p>
                </div>
              </div>

              {/* admin email */}
              <div className="flex items-center gap-2.5">
                <span className="icon-chip icon-chip-pine shrink-0"><UserRound className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Admin login (email)</p>
                  <p className="text-sm font-medium text-ink truncate">{success.admin.email}</p>
                </div>
                <button className="btn-ghost h-8" onClick={() => void copyText(success.admin.email, "Admin email")}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              </div>

              {/* temp password */}
              <div className="flex items-center gap-2.5">
                <span className="icon-chip shrink-0"><KeyRound className="h-4 w-4" /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] uppercase tracking-wider text-muted-ink">Temporary password</p>
                  {pwd ? (
                    showTempPassword ? (
                      <p className="font-mono text-[15px] font-semibold text-pine bg-panel border border-line rounded-md px-2.5 py-1 mt-0.5 select-all tracking-wide">{pwd}</p>
                    ) : (
                      <p className="font-mono text-[15px] font-semibold text-muted-ink bg-panel border border-line rounded-md px-2.5 py-1 mt-0.5 tracking-widest">••••••••••••</p>
                    )
                  ) : (
                    <p className="text-sm text-muted-ink mt-0.5">Not returned by the server.</p>
                  )}
                </div>
                {pwd && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      className="btn-ghost h-8 w-8 p-0"
                      aria-label={showTempPassword ? "Hide temporary password" : "Show temporary password"}
                      onClick={() => setShowTempPassword((v) => !v)}
                    >
                      {showTempPassword ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </button>
                    <button className="btn-ghost h-8" onClick={() => void copyText(pwd, "Temporary password")}>
                      <Copy className="h-3.5 w-3.5" /> Copy
                    </button>
                  </div>
                )}
              </div>

              {/* subscription + delivery */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 border-t border-line/70">
                <span className="inline-flex items-center gap-1.5 text-[13px] text-ink">
                  <BadgeCheck className="h-4 w-4 text-brass shrink-0" /> Subscription:
                  <span className="badge border-ok/40 bg-ok/10 text-ok capitalize">{success.subscription.status}</span>
                </span>
                {success.credentialsSent ? (
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-ok">
                    <MailCheck className="h-4 w-4 shrink-0" /> Credentials also sent via {success.credentialsChannel}.
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 text-[13px] text-warn">
                    <Info className="h-4 w-4 shrink-0" /> Email delivery pending — share the password manually.
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* warnings */}
          <div className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3.5 py-3 text-[13px] text-warn space-y-1">
            <p className="font-semibold flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" /> This password is displayed only once — store it now.</p>
            <p className="text-warn/90">The admin is forced to set a permanent password on first login; this temporary one stops working after that.</p>
          </div>

          {/* actions */}
          <div className="flex flex-col sm:flex-row gap-2 justify-center mt-6">
            <button className="btn-pine h-10" onClick={() => setView("businesses")}>
              <Eye className="h-4 w-4" /> View business
            </button>
            <button className="btn-outline h-10" onClick={resetForm}>
              <Building2 className="h-4 w-4" /> Add another business
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ═══ WIZARD ════════════════════════════════════════════════════════ */

  return (
    <div className="max-w-3xl mx-auto pb-2">
      {/* stepper header */}
      <div className="panel px-4 py-4 sm:px-6">
        <ol className="flex items-start">
          {STEPS.map((s, i) => {
            const active = i === step;
            const done = stepDone(i);
            return (
              <li key={s.key} className={`flex items-start ${i < STEPS.length - 1 ? "flex-1" : ""}`}>
                <button
                  type="button"
                  disabled={i > step}
                  onClick={() => i < step && goToStep(i)}
                  className={`flex flex-col items-center gap-1.5 group ${i < step ? "cursor-pointer" : "cursor-default"} min-w-[72px]`}
                  aria-current={active ? "step" : undefined}
                >
                  <span
                    className={`h-9 w-9 rounded-full border flex items-center justify-center text-sm font-semibold transition
                      ${active ? "border-brass bg-brass text-white shadow-[0_0_0_4px] shadow-brass/15"
                        : done ? "border-ok bg-ok/10 text-ok"
                        : "border-line-strong bg-panel text-muted-ink"}`}
                  >
                    {done ? <Check className="h-4 w-4" /> : i + 1}
                  </span>
                  <span className={`text-[11px] font-medium leading-tight text-center ${active ? "text-pine" : done ? "text-ok" : "text-muted-ink"}`}>
                    {s.label}
                  </span>
                </button>
                {i < STEPS.length - 1 && (
                  <span aria-hidden className={`hidden sm:block flex-1 h-px mt-[18px] mx-2 ${stepDone(i + 1) || i + 1 <= step ? "bg-brass/50" : "bg-line"}`} />
                )}
                {i < STEPS.length - 1 && <span aria-hidden className="sm:hidden w-4" />}
              </li>
            );
          })}
        </ol>
      </div>

      {/* ── STEP 1 · business details ─────────────────────────────────── */}
      {step === 0 && (
        <div className="mt-4 space-y-4">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title flex items-center gap-2"><Building2 className="h-4 w-4 text-brass" /> Identity</h2>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <Label className="field-label" htmlFor="biz-name">Business name <span className="text-danger">*</span></Label>
                <Input id="biz-name" className="field" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="The Royal Grand Hotel" />
              </div>
              <div>
                <Label className="field-label">Property type</Label>
                <Select value={form.propertyType} onValueChange={(v) => set("propertyType", v)}>
                  <SelectTrigger className="h-9" aria-label="Property type"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PROPERTY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="field-label" htmlFor="biz-category">Category</Label>
                <Input id="biz-category" className="field" value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="Luxury Hotel" />
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title flex items-center gap-2"><MapPin className="h-4 w-4 text-brass" /> Location &amp; contact</h2>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <Label className="field-label" htmlFor="biz-address">Address</Label>
                <Input id="biz-address" className="field" value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="12 Marine Drive" />
              </div>
              <div>
                <Label className="field-label" htmlFor="biz-city">City</Label>
                <Input id="biz-city" className="field" value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="Mumbai" />
              </div>
              <div>
                <Label className="field-label" htmlFor="biz-state">State</Label>
                <Input id="biz-state" className="field" value={form.state} onChange={(e) => set("state", e.target.value)} placeholder="Maharashtra" />
              </div>
              <div>
                <Label className="field-label" htmlFor="biz-phone">Phone</Label>
                <Input id="biz-phone" className="field" value={form.phone} onChange={(e) => set("phone", e.target.value)} placeholder="+91 98200 00000" />
              </div>
              <div>
                <Label className="field-label" htmlFor="biz-email">Email</Label>
                <Input id="biz-email" className="field" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} placeholder="hello@royalgrand.in" />
              </div>
              <div className="sm:col-span-2">
                <Label className="field-label" htmlFor="biz-gstin">GSTIN</Label>
                <Input id="biz-gstin" className="field uppercase" value={form.gstin} onChange={(e) => set("gstin", e.target.value)} placeholder="27ABCDE1234F1Z5" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 2 · admin account ────────────────────────────────────── */}
      {step === 1 && (
        <div className="mt-4 space-y-4">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title flex items-center gap-2"><UserRound className="h-4 w-4 text-brass" /> Admin account</h2>
            </div>
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="field-label" htmlFor="admin-name">Admin name <span className="text-danger">*</span></Label>
                <Input id="admin-name" className="field" value={form.adminName} onChange={(e) => set("adminName", e.target.value)} placeholder="Rohan Mehta" />
              </div>
              <div>
                <Label className="field-label" htmlFor="admin-email">Admin email <span className="text-danger">*</span></Label>
                <Input id="admin-email" className="field" type="email" value={form.adminEmail} onChange={(e) => set("adminEmail", e.target.value)} placeholder="admin@royalgrand.in" />
                <p className="text-[11px] text-muted-ink mt-1">This email is the admin&apos;s login username.</p>
              </div>
              <div>
                <Label className="field-label" htmlFor="admin-phone">Admin phone</Label>
                <Input id="admin-phone" className="field" value={form.adminPhone} onChange={(e) => set("adminPhone", e.target.value)} placeholder="+91 90000 00000" />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-brass/30 bg-brass-50/60 px-4 py-3.5 flex items-start gap-3">
            <span className="icon-chip shrink-0"><Info className="h-4 w-4" /></span>
            <div className="text-[13px] leading-relaxed">
              <p className="font-semibold text-pine">No password needed — it&apos;s generated for you</p>
              <p className="text-muted-ink mt-0.5">
                A temporary password (<span className="font-mono text-[12px] text-pine">Vlx@XXXXXXXX</span>) is generated automatically.
                You&apos;ll see it once after creation — the admin sets a permanent password on first login.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── STEP 3 · plan & billing ───────────────────────────────────── */}
      {step === 2 && (
        <div className="mt-4 space-y-4">
          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title flex items-center gap-2"><Sparkles className="h-4 w-4 text-brass" /> Plan</h2>
            </div>
            <div className="p-4">
              {plansLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-ink py-2">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading plans…
                </div>
              ) : plans.length === 0 ? (
                <p className="text-sm text-danger">No active plans found — create one under Subscriptions first.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  {plans.map((p) => {
                    const selected = form.planId === p.id;
                    const chips = planLimitChips(p);
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => set("planId", p.id)}
                        aria-pressed={selected}
                        className={`relative text-left rounded-lg border p-4 transition ${
                          selected ? "border-brass bg-brass-50 ring-2 ring-brass/30" : "border-line bg-panel hover:border-line-strong"
                        }`}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-display text-[15px] font-semibold text-pine">{p.name}</span>
                          <span className={`h-4 w-4 rounded-full border flex items-center justify-center ${selected ? "border-brass bg-brass" : "border-line-strong bg-panel"}`}>
                            {selected && <Check className="h-2.5 w-2.5 text-white" />}
                          </span>
                        </div>
                        <p className="text-brass text-lg font-semibold mt-1">
                          {inr(p.monthlyPrice)}<span className="text-muted-ink text-xs font-normal">/mo</span>
                        </p>
                        {p.description && <p className="text-[11.5px] text-muted-ink mt-1 line-clamp-2 leading-snug">{p.description}</p>}
                        {chips.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2.5">
                            {chips.map((c) => (
                              <span key={c} className="badge border-line-strong bg-plaster text-muted-ink text-[10px]">{c}</span>
                            ))}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2 className="panel-title flex items-center gap-2"><Wallet className="h-4 w-4 text-brass" /> Billing</h2>
            </div>
            <div className="p-4 space-y-4">
              {/* cycle toggle */}
              <div>
                <Label className="field-label">Billing cycle</Label>
                <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Billing cycle">
                  {CYCLES.map((c) => {
                    const selected = form.cycle === c;
                    const disc = discountFor(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => set("cycle", c)}
                        className={`relative rounded-md border px-2 py-2.5 text-center transition ${
                          selected ? "border-brass bg-brass-50 ring-2 ring-brass/30" : "border-line bg-panel hover:border-line-strong"
                        }`}
                      >
                        <span className={`block text-[13px] font-semibold ${selected ? "text-pine" : "text-ink"}`}>{CYCLE_LABEL[c]}</span>
                        {selectedPlan && (
                          <span className="block text-[11px] text-muted-ink mt-0.5 tabular-nums">
                            {inr(priceForCycle(selectedPlan.monthlyPrice, c))}
                            {CYCLE_MONTHS[c] > 1 && <span className="text-muted-ink/70"> · {CYCLE_MONTHS[c]} mo</span>}
                          </span>
                        )}
                        {disc > 0 && (
                          <span className={`absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tracking-wide ${
                            selected ? "bg-brass text-white" : "bg-ok/15 text-ok border border-ok/30"
                          }`}>
                            save {disc}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {selectedPlan && form.cycle !== "monthly" && (
                  <p className="text-[11px] text-muted-ink mt-1.5">
                    {inr(priceForCycle(selectedPlan.monthlyPrice, form.cycle))} billed {form.cycle} — includes the {discountFor(form.cycle)}% cycle discount.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="field-label" htmlFor="trial-days">Trial days</Label>
                  <Input id="trial-days" className="field" type="number" min={0} value={form.trialDays} onChange={(e) => set("trialDays", e.target.value)} placeholder="default 14" />
                </div>
                <div>
                  <Label className="field-label" htmlFor="setup-fee">One-time setup fee (₹)</Label>
                  <Input id="setup-fee" className="field" type="number" min={0} value={form.setupFee} onChange={(e) => set("setupFee", e.target.value)} placeholder="0" />
                </div>
                <div className="sm:col-span-2">
                  <Label className="field-label" htmlFor="coupon">Coupon code</Label>
                  <Input id="coupon" className="field uppercase" value={form.couponCode} onChange={(e) => set("couponCode", e.target.value)} placeholder="LAUNCH20" />
                </div>
              </div>

              <div className="flex items-center justify-between rounded-md border border-line bg-plaster/40 px-3.5 py-3">
                <div className="pr-3">
                  <p className="text-[13px] font-medium text-pine">Send login credentials to the admin</p>
                  <p className="text-[11px] text-muted-ink mt-0.5">Email / WhatsApp with the temporary password, when a provider is configured.</p>
                </div>
                <Switch checked={form.sendCredentials} onCheckedChange={(v) => set("sendCredentials", v)} aria-label="Send credentials" />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* inline error */}
      {formErr && (
        <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger flex items-start gap-2" role="alert">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{formErr}</span>
        </div>
      )}

      {/* sticky action bar */}
      <div className="sticky bottom-0 z-20 mt-4">
        <div className="rounded-lg border border-line bg-panel/95 backdrop-blur px-4 py-3 shadow-[0_-4px_16px_rgba(15,38,34,0.06)] flex flex-col sm:flex-row sm:items-center gap-3">
          <p className="text-xs text-muted-ink sm:flex-1 hidden sm:block">
            Step {step + 1} of {STEPS.length} · <span className={stepInvalid ? "text-danger" : ""}>{stepInvalid ?? "All good — ready to continue"}</span>
          </p>
          <div className="flex items-center gap-2">
            <button className="btn-outline flex-1 sm:flex-none" onClick={() => goToStep(Math.max(0, step - 1))} disabled={step === 0 || submitting}>
              <ChevronLeft className="h-4 w-4" /> Back
            </button>
            {step < STEPS.length - 1 ? (
              <button className="btn-pine flex-1 sm:flex-none" onClick={continueStep}>
                Continue <ChevronRight className="h-4 w-4" />
              </button>
            ) : (
              <button className="btn-pine flex-1 sm:flex-none h-9" onClick={() => void submit()} disabled={submitting}>
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Creating business…</>
                ) : (
                  <><Building2 className="h-4 w-4" /> Create business</>
                )}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* reassurance strip */}
      <p className="text-[11px] text-muted-ink text-center mt-3 flex items-center justify-center gap-1.5">
        <Users className="h-3 w-3" /> You can edit every detail later from the Businesses tab.
        <Save className="h-3 w-3 ml-1" /> Nothing is charged until the first invoice runs.
      </p>
    </div>
  );
}
