"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle, BedDouble, Check, ChevronDown, CreditCard, LifeBuoy, ReceiptIndianRupee,
  Sparkles, Users, X, Zap,
} from "lucide-react";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Loading, EmptyState, ErrorState, StatusBadge, pct, fmtDate, inr } from "@/components/owner/shared";
import { IconFor } from "@/components/feature-icons";
import { Progress } from "@/components/ui/progress";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FEATURE_MAP, describeGrants } from "@/lib/feature-catalog";
import { cn } from "@/lib/utils";

/* ─── types ──────────────────────────────────────────────────────────────── */

interface PlanCard {
  id: string;
  code: string;
  name: string;
  description: string;
  tagline?: string | null;
  badge?: string | null;
  monthlyPrice: number;
  features: Record<string, unknown>;
}

interface CatalogItem {
  key: string;
  name: string;
  description: string;
  category: string; // feature | capacity | service
  price: number;
  oneOff: boolean;
  grants: string;
  planCodes: string[];
  badge: string;
  icon: string;
  owned: boolean;
}

interface SubscriptionData {
  plan: { id: string; code: string; name: string; monthlyPrice: number } | null;
  subscription: { cycle: string; status: string; renewalAt: string | null; trialEndsAt: string | null; autoRenew: boolean; pendingPlanId: string | null } | null;
  features: Record<string, boolean | number | string>;
  limits: Record<string, number>;
  addons: { addonKey: string; label: string; qty: number; price: number }[];
  warning: string | null;
  writable: boolean;
  usage: Record<string, { used: number; cap: number }>;
  plans: PlanCard[];
  catalog: CatalogItem[];
  ownedAddons: { addonKey: string; label: string; qty: number; price: number; oneOff: boolean }[];
  invoices: { id: string; number: string; type: string; status: string; totalAmount: number; taxAmount: number; dueDate: string | null; paidAt: string | null; createdAt: string; items: { description: string; amount: number }[] }[];
  paymentMethods: { razorpay: boolean; note: string };
}

const USAGE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  rooms: { label: "Rooms", icon: BedDouble },
  staff: { label: "Staff seats", icon: Users },
  ota_channels: { label: "OTA channels", icon: (p) => <IconFor name="network" {...p} /> },
  whatsapp_msgs: { label: "WhatsApp msgs (this month)", icon: (p) => <IconFor name="message-circle" {...p} /> },
};

/** Rows for the full comparison table, in display order. */
const COMPARE_KEYS = [
  "rooms", "staff", "properties", "ota_channels", "whatsapp_msgs",
  "pos", "night_audit", "whatsapp_automation", "dynamic_pricing", "advanced_reports",
  "excel_export", "api_access", "white_label", "multi_property",
  "support", "backup",
];

const CATEGORY_TITLES: Record<string, { title: string; blurb: string }> = {
  feature: { title: "Feature unlocks", blurb: "Turn on premium modules without changing plans" },
  capacity: { title: "Capacity packs", blurb: "Raise your limits — stack as you grow" },
  service: { title: "Services", blurb: "One-off help from the Velurex team" },
};

export default function SubscriptionView() {
  const { token, user } = useSession();
  const { toast } = useToast();
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [upgradePlan, setUpgradePlan] = useState<PlanCard | null>(null);
  const [cycle, setCycle] = useState("monthly");
  const [showCompare, setShowCompare] = useState(false);
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketBody, setTicketBody] = useState("");
  const [ticketPriority, setTicketPriority] = useState("normal");

  const load = useCallback(async () => {
    try {
      // Auth: Bearer when the in-memory token exists, otherwise the HttpOnly
      // session cookie carries the session (survives refresh).
      const res = await fetch("/api/subscription", {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load");
      setData(json);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (body: Record<string, unknown>, successTitle: string) => {
    setBusy(true);
    try {
      const res = await fetch("/api/subscription/actions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Action failed");
      toast({ title: successTitle, description: json.invoiceNumber ? `Invoice ${json.invoiceNumber} generated (due in 7 days).` : json.note });
      setUpgradePlan(null);
      await load();
    } catch (e) {
      toast({ title: "Action failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const raiseTicket = async () => {
    if (!ticketSubject.trim() || !ticketBody.trim()) {
      toast({ title: "Subject and description are required", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/subscription/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ subject: ticketSubject, body: ticketBody, priority: ticketPriority }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error);
      toast({ title: "Ticket raised", description: json.message });
      setTicketOpen(false);
      setTicketSubject("");
      setTicketBody("");
    } catch (e) {
      toast({ title: "Could not raise ticket", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const sortedPlans = useMemo(
    () => (data?.plans ?? []).slice().sort((a, b) => a.monthlyPrice - b.monthlyPrice),
    [data]
  );
  const catalogByCategory = useMemo(() => {
    const map: Record<string, CatalogItem[]> = { feature: [], capacity: [], service: [] };
    for (const c of data?.catalog ?? []) {
      (map[c.category] ?? map.feature).push(c);
    }
    return map;
  }, [data]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Loading label="Loading your subscription…" />;
  if (!data.plan) {
    return (
      <div className="panel p-6">
        <EmptyState icon={CreditCard} title="No subscription found" hint="Ask the platform team to set up your plan." />
      </div>
    );
  }

  const isTrial = data.subscription?.status === "trial";
  const currentCode = data.plan.code;
  const pendingPlanName = data.subscription?.pendingPlanId
    ? data.plans.find((p) => p.id === data.subscription?.pendingPlanId)?.name
    : null;
  const applicableCatalog = (c: CatalogItem) =>
    c.planCodes.length === 0 || c.planCodes.includes(currentCode);

  return (
    <div className="space-y-4">
      {/* Warning banner */}
      {data.warning && (
        <div className="flex items-start gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3">
          <AlertTriangle className="h-5 w-5 text-warn shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">{data.warning}</p>
            {data.invoices.some((i) => i.status === "pending" || i.status === "overdue") && (
              <p className="text-xs text-muted-ink mt-1">Pay below from your invoice list to restore full access.</p>
            )}
          </div>
        </div>
      )}

      {/* Current plan */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Current plan</p>
          <StatusBadge status={data.subscription?.status ?? "active"} />
        </div>
        <div className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-baseline gap-2">
                <h2 className="font-display text-2xl font-semibold text-pine">{data.plan.name}</h2>
                <span className="text-2xl font-semibold text-brass">{inr(data.plan.monthlyPrice)}</span>
                <span className="text-xs text-muted-ink">/month</span>
              </div>
              <p className="text-xs text-muted-ink mt-1">
                Billed {data.subscription?.cycle ?? "monthly"}
                {data.subscription?.renewalAt ? ` · renews ${fmtDate(data.subscription.renewalAt)}` : ""}
                {data.subscription?.trialEndsAt && isTrial ? ` · trial ends ${fmtDate(data.subscription.trialEndsAt)}` : ""}
                {pendingPlanName ? ` · downgrade to ${pendingPlanName} scheduled` : ""}
              </p>
            </div>
            <button className="btn-outline h-9" onClick={() => setTicketOpen(true)}>
              <LifeBuoy className="h-4 w-4" /> Raise ticket
            </button>
          </div>

          {/* Usage bars */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-5">
            {Object.entries(data.usage).map(([key, u]) => {
              const meta = USAGE_META[key];
              if (!meta) return null;
              const p = pct(u.used, u.cap);
              const near = u.cap !== -1 && p >= 90;
              return (
                <div key={key} className="rounded-md border border-line bg-plaster/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                      <meta.icon className="h-4 w-4 text-muted-ink" /> {meta.label}
                    </span>
                    <span className={cn("text-[12px] font-semibold", near ? "text-warn" : "text-pine")}>
                      {u.used} / {u.cap === -1 ? "∞" : u.cap}
                    </span>
                  </div>
                  <Progress value={p} className="h-1.5 mt-2" />
                </div>
              );
            })}
          </div>

          {/* Active add-ons */}
          {data.ownedAddons.length > 0 && (
            <div className="mt-5">
              <p className="field-label">Active add-ons</p>
              <div className="flex flex-wrap gap-1.5">
                {data.ownedAddons.map((a) => (
                  <span key={a.addonKey} className="badge border-ok/40 bg-ok/10 text-ok">
                    {a.label}{a.qty > 1 ? ` ×${a.qty}` : ""}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Plans grid — all four tiers */}
      <div>
        <div className="flex items-center justify-between gap-2 px-1">
          <div>
            <h2 className="font-display text-lg font-semibold text-pine">Plans</h2>
            <p className="text-[11px] text-muted-ink">Upgrade anytime with prorated credit · downgrades apply at renewal</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-2">
          {sortedPlans.map((p) => {
            const isCurrent = p.code === currentCode;
            const higher = p.monthlyPrice > data.plan!.monthlyPrice;
            return (
              <div
                key={p.id}
                className={cn(
                  "relative panel flex flex-col p-4",
                  isCurrent && "ring-2 ring-brass/60",
                  p.badge === "Most Popular" && !isCurrent && "ring-1 ring-pine/20"
                )}
              >
                {p.badge && (
                  <span className={cn(
                    "absolute -top-2.5 left-3 badge text-[9px] px-2 py-0.5",
                    p.badge === "Most Popular" ? "border-pine/40 bg-pine text-[#EFE6D8]" : "border-brass/50 bg-brass/15 text-brass"
                  )}>
                    {p.badge}
                  </span>
                )}
                <div className="flex items-center justify-between">
                  <h3 className="font-display font-semibold text-pine">{p.name}</h3>
                  {isCurrent && <span className="badge border-ok/40 bg-ok/10 text-ok">Current</span>}
                </div>
                <p className="mt-1">
                  <span className="text-2xl font-semibold text-pine">{inr(p.monthlyPrice)}</span>
                  <span className="text-xs text-muted-ink">/mo</span>
                </p>
                {p.tagline ? (
                  <p className="text-[11px] text-muted-ink mt-0.5">{p.tagline}</p>
                ) : (
                  <p className="text-[11px] text-muted-ink mt-0.5 line-clamp-2">{p.description}</p>
                )}

                <ul className="mt-3 space-y-1.5 text-[12px] text-ink flex-1">
                  <li className="flex items-center gap-1.5">
                    <BedDouble className="h-3.5 w-3.5 text-brass" />
                    {Number(p.features.rooms) === -1 ? "Unlimited" : String(p.features.rooms ?? "—")} rooms
                  </li>
                  <li className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 text-brass" />
                    {Number(p.features.staff) === -1 ? "Unlimited" : String(p.features.staff ?? "—")} staff seats
                  </li>
                  <li className="flex items-center gap-1.5">
                    <IconFor name="network" className="h-3.5 w-3.5 text-brass" />
                    {Number(p.features.ota_channels) === -1 ? "Unlimited" : String(p.features.ota_channels ?? "—")} OTA channels
                  </li>
                  <li className="flex items-center gap-1.5">
                    <IconFor name="message-circle" className="h-3.5 w-3.5 text-brass" />
                    {Number(p.features.whatsapp_msgs) === 0
                      ? "No WhatsApp msgs"
                      : Number(p.features.whatsapp_msgs) === -1 ? "Unlimited WhatsApp" : `${p.features.whatsapp_msgs} msgs/mo`}
                  </li>
                  {(["pos", "night_audit", "whatsapp_automation", "dynamic_pricing", "api_access", "white_label"] as const).map((k) => {
                    if (p.features[k] !== true) return null;
                    const def = FEATURE_MAP[k];
                    return (
                      <li key={k} className="flex items-center gap-1.5">
                        <IconFor name={def?.icon ?? "sparkles"} className={cn("h-3.5 w-3.5", def?.premium ? "text-brass" : "text-ok")} />
                        <span className={def?.premium ? "font-medium" : ""}>{def?.label ?? k}</span>
                        {def?.premium && <Sparkles className="h-3 w-3 text-brass" />}
                      </li>
                    );
                  })}
                </ul>

                {isCurrent ? (
                  <button className="btn-outline w-full mt-4 cursor-default" disabled>
                    <Check className="h-4 w-4" /> Your plan
                  </button>
                ) : higher ? (
                  <button
                    className="btn-brass w-full mt-4"
                    onClick={() => { setUpgradePlan(p); setCycle("monthly"); }}
                  >
                    <Zap className="h-4 w-4" /> Upgrade
                  </button>
                ) : (
                  <button
                    className="btn-outline w-full mt-4"
                    disabled={busy}
                    onClick={() => act({ action: "request_downgrade", planId: p.id }, "Downgrade scheduled")}
                  >
                    Schedule downgrade
                  </button>
                )}
              </div>
            );
          })}
        </div>

        {/* full comparison */}
        <div className="panel mt-3">
          <button
            className="w-full flex items-center justify-between px-4 py-3"
            onClick={() => setShowCompare((v) => !v)}
            aria-expanded={showCompare}
          >
            <span className="text-[13px] font-semibold text-pine">Compare all features</span>
            <ChevronDown className={cn("h-4 w-4 text-muted-ink transition-transform", showCompare && "rotate-180")} />
          </button>
          {showCompare && (
            <div className="overflow-x-auto border-t border-line">
              <table className="w-full min-w-[640px]">
                <thead>
                  <tr>
                    <th className="th text-left">Feature</th>
                    {sortedPlans.map((p) => (
                      <th key={p.id} className="th text-center">
                        {p.name}
                        {p.code === currentCode && <span className="text-[9px] text-brass ml-1">•</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COMPARE_KEYS.map((key) => {
                    const def = FEATURE_MAP[key];
                    if (!def) return null;
                    return (
                      <tr key={key} className="hover:bg-plaster/40 transition">
                        <td className="td">
                          <span className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                            <IconFor name={def.icon} className={cn("h-3.5 w-3.5", def.premium ? "text-brass" : "text-muted-ink")} />
                            {def.label}
                            {def.premium && <Sparkles className="h-3 w-3 text-brass" />}
                          </span>
                        </td>
                        {sortedPlans.map((p) => {
                          const v = p.features[key];
                          const on = v === true || (typeof v === "number" && v !== 0);
                          return (
                            <td key={p.id} className="td text-center text-[12px]">
                              {v === true ? (
                                <Check className="h-4 w-4 text-ok inline" />
                              ) : v === false || v === undefined || v === null || v === 0 ? (
                                <X className="h-4 w-4 text-line-strong inline" />
                              ) : (
                                <span className={on ? "text-ink font-medium" : "text-muted-ink"}>
                                  {typeof v === "number" && v === -1 ? "Unlimited" : String(v)}
                                </span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[11px] text-muted-ink border-t border-line">
                <Sparkles className="h-3 w-3 text-brass inline" /> Premium features — also available as add-ons on any plan.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Add-ons */}
      <div>
        <div className="px-1">
          <h2 className="font-display text-lg font-semibold text-pine">Add-ons</h2>
          <p className="text-[11px] text-muted-ink">Billed immediately · GST extra · removes at renewal on request</p>
        </div>
        <div className="space-y-4 mt-2">
          {(["feature", "capacity", "service"] as const).map((cat) => {
            const items = catalogByCategory[cat].filter(applicableCatalog);
            if (items.length === 0) return null;
            const meta = CATEGORY_TITLES[cat];
            return (
              <div key={cat} className="panel">
                <div className="panel-header">
                  <p className="panel-title">{meta.title}</p>
                  <p className="text-[11px] text-muted-ink hidden sm:block">{meta.blurb}</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
                  {items.map((c) => {
                    let included = false;
                    try {
                      const grants = JSON.parse(c.grants || "{}") as Record<string, unknown>;
                      const entries = Object.entries(grants);
                      included =
                        entries.length > 0 &&
                        entries.every(([k, v]) => (v === true ? data.features[k] === true : false));
                    } catch { included = false; }
                    const buyable = !c.owned || cat === "capacity";
                    return (
                      <div
                        key={c.key}
                        className={cn(
                          "rounded-lg border p-3.5 flex flex-col",
                          c.owned ? "border-ok/30 bg-ok/5" : "border-line bg-plaster/30"
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-line bg-[#EFE6D8]/40">
                            <IconFor name={c.icon} className="h-4 w-4 text-brass" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-pine flex items-center gap-1.5 flex-wrap">
                              {c.name}
                              {c.badge && <span className="badge border-brass/40 bg-brass/10 text-brass text-[9px]">{c.badge}</span>}
                              {c.owned && <span className="badge border-ok/40 bg-ok/10 text-ok text-[9px]">Active</span>}
                            </p>
                            <p className="text-[11px] text-muted-ink mt-0.5">{c.description}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between gap-2 mt-3 pt-2.5 border-t border-line/60">
                          <p className="text-[12px]">
                            <span className="font-semibold text-pine">{inr(c.price)}</span>
                            <span className="text-muted-ink">{c.oneOff ? " one-time" : " /mo"}</span>
                          </p>
                          {included ? (
                            <span className="badge border-ok/40 bg-ok/10 text-ok">In your plan</span>
                          ) : c.owned && !buyable ? (
                            <span className="badge border-line-strong bg-plaster text-muted-ink">Owned</span>
                          ) : (
                            <button
                              className="btn-outline h-8"
                              disabled={busy}
                              onClick={() => act({ action: "buy_addon", addonKey: c.key }, `${c.name} activated`)}
                            >
                              {c.owned ? "Add more" : "Buy"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          {(data.catalog ?? []).length === 0 && (
            <div className="panel">
              <EmptyState icon={Sparkles} title="No add-ons published yet" />
            </div>
          )}
        </div>
      </div>

      {/* Invoices */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Invoices</p>
          <p className="text-[11px] text-muted-ink">GST invoices · due in 7 days</p>
        </div>
        {data.invoices.length === 0 ? (
          <EmptyState icon={ReceiptIndianRupee} title="No invoices yet" />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr>
                  <th className="th">Invoice</th>
                  <th className="th">For</th>
                  <th className="th">Amount</th>
                  <th className="th">Status</th>
                  <th className="th">Date</th>
                  <th className="th text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-plaster/40 transition">
                    <td className="td font-medium text-pine">{inv.number}</td>
                    <td className="td max-w-[220px] truncate">{inv.items[0]?.description ?? "Subscription"}</td>
                    <td className="td font-semibold">{inr(inv.totalAmount)}</td>
                    <td className="td"><StatusBadge status={inv.status} /></td>
                    <td className="td text-muted-ink">{fmtDate(inv.createdAt)}</td>
                    <td className="td text-right">
                      {(inv.status === "pending" || inv.status === "overdue") && (
                        <button
                          className="btn-brass h-8"
                          disabled={busy}
                          onClick={() => act({ action: "pay_now", invoiceId: inv.id }, "Payment initiated")}
                        >
                          Pay now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="px-4 py-2.5 border-t border-line">
          <p className="text-[11px] text-muted-ink">{data.paymentMethods.note}</p>
        </div>
      </div>

      {/* Upgrade confirm dialog */}
      <Dialog open={!!upgradePlan} onOpenChange={(o) => !o && setUpgradePlan(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upgrade to {upgradePlan?.name}</DialogTitle>
            <DialogDescription>
              Takes effect immediately. You&apos;ll be credited for unused time on {data.plan.name} and a prorated invoice is generated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Billing cycle</Label>
              <Select value={cycle} onValueChange={setCycle}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly (5% off)</SelectItem>
                  <SelectItem value="yearly">Yearly (10% off)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setUpgradePlan(null)}>Cancel</button>
              <button
                className="btn-brass"
                disabled={busy}
                onClick={() => upgradePlan && act({ action: "upgrade", planId: upgradePlan.id, cycle }, `Upgraded to ${upgradePlan.name}`)}
              >
                Confirm upgrade
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Raise ticket dialog */}
      <Dialog open={ticketOpen} onOpenChange={setTicketOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Raise a support ticket</DialogTitle>
            <DialogDescription>
              {user?.propertyName} · our team usually responds within a few hours.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>Subject</Label>
              <Input value={ticketSubject} onChange={(e) => setTicketSubject(e.target.value)} placeholder="e.g. OTA prices not syncing" />
            </div>
            <div className="space-y-1.5">
              <Label>Priority</Label>
              <Select value={ticketPriority} onValueChange={setTicketPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="urgent">Urgent — something is broken</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Describe the issue</Label>
              <Textarea rows={4} value={ticketBody} onChange={(e) => setTicketBody(e.target.value)} placeholder="What happened? What did you expect?" />
            </div>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setTicketOpen(false)}>Cancel</button>
              <button className="btn-pine" disabled={busy} onClick={raiseTicket}>Send ticket</button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
