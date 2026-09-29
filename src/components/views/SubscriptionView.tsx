"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Check, X, Zap, BedDouble, Users, Network, MessageCircle, ChefHat, MoonStar,
  TrendingUp, FileSpreadsheet, CreditCard, ReceiptIndianRupee, LifeBuoy, AlertTriangle,
} from "lucide-react";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { Loading, EmptyState, ErrorState, StatusBadge, cap, pct, fmtDate, inr } from "@/components/owner/shared";
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

interface SubscriptionData {
  plan: { id: string; code: string; name: string; monthlyPrice: number } | null;
  subscription: { cycle: string; status: string; renewalAt: string | null; trialEndsAt: string | null; autoRenew: boolean; pendingPlanId: string | null } | null;
  features: Record<string, boolean | number | string>;
  limits: Record<string, number>;
  addons: { addonKey: string; label: string; qty: number; price: number }[];
  warning: string | null;
  writable: boolean;
  usage: Record<string, { used: number; cap: number }>;
  plans: { id: string; code: string; name: string; description: string; monthlyPrice: number; features: Record<string, unknown> }[];
  invoices: { id: string; number: string; type: string; status: string; totalAmount: number; taxAmount: number; dueDate: string | null; paidAt: string | null; createdAt: string; items: { description: string; amount: number }[] }[];
  paymentMethods: { razorpay: boolean; note: string };
}

const FEATURE_META: { key: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "pos", label: "Restaurant POS", icon: ChefHat },
  { key: "night_audit", label: "Night Audit", icon: MoonStar },
  { key: "whatsapp_automation", label: "WhatsApp Automation", icon: MessageCircle },
  { key: "dynamic_pricing", label: "Dynamic Pricing", icon: TrendingUp },
  { key: "advanced_reports", label: "Advanced Reports", icon: FileSpreadsheet },
  { key: "excel_export", label: "Excel Export", icon: FileSpreadsheet },
];

const ADDON_CATALOG: { key: string; label: string; price: number }[] = [
  { key: "rooms_pack", label: "Extra Rooms Pack (+10 rooms)", price: 999 },
  { key: "staff_pack", label: "Extra Staff Pack (+5 seats)", price: 499 },
  { key: "whatsapp_pack", label: "WhatsApp Pack (+100 msgs/mo)", price: 499 },
  { key: "ota_pack", label: "Extra OTA Channel", price: 799 },
];

const USAGE_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  rooms: { label: "Rooms", icon: BedDouble },
  staff: { label: "Staff seats", icon: Users },
  ota_channels: { label: "OTA channels", icon: Network },
  whatsapp_msgs: { label: "WhatsApp msgs (this month)", icon: MessageCircle },
};

export default function SubscriptionView() {
  const { token, user } = useSession();
  const { toast } = useToast();
  const [data, setData] = useState<SubscriptionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [upgradePlan, setUpgradePlan] = useState<SubscriptionData["plans"][number] | null>(null);
  const [cycle, setCycle] = useState("monthly");
  const [ticketOpen, setTicketOpen] = useState(false);
  const [ticketSubject, setTicketSubject] = useState("");
  const [ticketBody, setTicketBody] = useState("");
  const [ticketPriority, setTicketPriority] = useState("normal");

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch("/api/subscription", { headers: { Authorization: `Bearer ${token}` } });
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
      const res = await fetch("/api/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
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
  const higherPlans = data.plans.filter((p) => p.monthlyPrice > data.plan!.monthlyPrice);
  const lowerPlans = data.plans.filter((p) => p.monthlyPrice < data.plan!.monthlyPrice);

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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Current plan */}
        <div className="panel lg:col-span-2">
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
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button className="btn-outline h-9" onClick={() => setTicketOpen(true)}>
                  <LifeBuoy className="h-4 w-4" /> Raise ticket
                </button>
                {higherPlans.length > 0 && (
                  <button
                    className="btn-brass h-9"
                    onClick={() => setUpgradePlan(higherPlans[0])}
                  >
                    <Zap className="h-4 w-4" /> Upgrade plan
                  </button>
                )}
              </div>
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
                      <span className={`text-[12px] font-semibold ${near ? "text-warn" : "text-pine"}`}>
                        {u.used} / {cap(u.cap)}
                      </span>
                    </div>
                    <Progress value={p} className="h-1.5 mt-2" />
                  </div>
                );
              })}
            </div>

            {/* Feature flags */}
            <div className="mt-5">
              <p className="field-label">Included modules</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {FEATURE_META.map((f) => {
                  const on = data.features[f.key] === true;
                  return (
                    <div
                      key={f.key}
                      className={`flex items-center gap-2 rounded-md border px-3 py-2 text-[13px] ${on ? "border-ok/30 bg-ok/5 text-ink" : "border-line bg-plaster/40 text-muted-ink"}`}
                    >
                      <f.icon className={`h-4 w-4 ${on ? "text-ok" : "text-line-strong"}`} />
                      <span className="flex-1 truncate">{f.label}</span>
                      {on ? <Check className="h-3.5 w-3.5 text-ok" /> : <X className="h-3.5 w-3.5 text-line-strong" />}
                    </div>
                  );
                })}
              </div>
              {data.addons.length > 0 && (
                <p className="text-[11px] text-muted-ink mt-2">
                  Add-ons active: {data.addons.map((a) => a.label).join(" · ")}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Add-ons */}
        <div className="panel self-start">
          <div className="panel-header">
            <p className="panel-title">Add-ons</p>
          </div>
          <div className="p-4 space-y-2.5">
            <p className="text-xs text-muted-ink">Top up capacity without changing plans. Billed immediately.</p>
            {ADDON_CATALOG.map((a) => (
              <div key={a.key} className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink truncate">{a.label}</p>
                  <p className="text-[11px] text-muted-ink">{inr(a.price)} + GST</p>
                </div>
                <button
                  className="btn-outline h-8 shrink-0"
                  disabled={busy}
                  onClick={() => act({ action: "buy_addon", addonKey: a.key }, "Add-on activated")}
                >
                  Buy
                </button>
              </div>
            ))}
          </div>
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

      {/* Upgrade / downgrade cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...higherPlans, ...lowerPlans].map((p) => {
          const higher = p.monthlyPrice > data.plan!.monthlyPrice;
          return (
            <div key={p.id} className={`panel p-4 ${higher ? "ring-1 ring-brass/30" : "opacity-90"}`}>
              <div className="flex items-center justify-between">
                <h3 className="font-display font-semibold text-pine">{p.name}</h3>
                {higher ? (
                  <span className="badge border-brass/40 bg-brass/10 text-brass">Upgrade</span>
                ) : (
                  <span className="badge border-line-strong bg-plaster text-muted-ink">Downgrade</span>
                )}
              </div>
              <p className="text-2xl font-semibold text-pine mt-1">
                {inr(p.monthlyPrice)}<span className="text-xs text-muted-ink font-normal">/mo</span>
              </p>
              <p className="text-xs text-muted-ink mt-1 line-clamp-2">{p.description}</p>
              <ul className="mt-3 space-y-1 text-[12px] text-ink">
                <li className="flex items-center gap-1.5"><BedDouble className="h-3.5 w-3.5 text-brass" /> {Number(p.features.rooms) === -1 ? "Unlimited" : String(p.features.rooms)} rooms</li>
                <li className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5 text-brass" /> {Number(p.features.staff) === -1 ? "Unlimited" : String(p.features.staff)} staff seats</li>
                <li className="flex items-center gap-1.5"><Network className="h-3.5 w-3.5 text-brass" /> {Number(p.features.ota_channels) === -1 ? "Unlimited" : String(p.features.ota_channels)} OTA channels</li>
                {p.features.pos === true && <li className="flex items-center gap-1.5 text-ok"><Check className="h-3.5 w-3.5" /> Restaurant POS</li>}
                {p.features.night_audit === true && <li className="flex items-center gap-1.5 text-ok"><Check className="h-3.5 w-3.5" /> Night Audit</li>}
                {p.features.whatsapp_automation === true && <li className="flex items-center gap-1.5 text-ok"><Check className="h-3.5 w-3.5" /> WhatsApp automation</li>}
              </ul>
              {higher ? (
                <button className="btn-pine w-full mt-4" onClick={() => { setUpgradePlan(p); setCycle("monthly"); }}>
                  <Zap className="h-4 w-4" /> Upgrade now
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
