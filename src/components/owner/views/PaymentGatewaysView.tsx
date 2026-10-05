"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CreditCard, Landmark, Pencil, Plus, Smartphone, Trash2, Wallet, Webhook,
} from "lucide-react";
import { EmptyState, ErrorState, Loading, StatusBadge, useOwnerApi, usePolling } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/* ─── types ──────────────────────────────────────────────────────────────── */

interface GatewayRow {
  id: string;
  propertyId: string;
  provider: string;
  label: string;
  mode: string;
  enabled: boolean;
  isDefault: boolean;
  merchantId: string;
  hasSecret: boolean;
  notes: string;
  addedBy: string;
  createdAt: string;
  updatedAt: string;
  property: { id: string; name: string; city: string; state: string; subscriptionStatus: string };
}

interface PropertyLite {
  id: string;
  name: string;
  city: string;
  state: string;
  subscriptionStatus: string;
}

interface GatewaysData {
  gateways: GatewayRow[];
  properties: PropertyLite[];
  summary: { total: number; enabled: number; live: number; tenantsConfigured: number };
}

const PROVIDERS = [
  { key: "razorpay", label: "Razorpay", hint: "Cards · UPI · Netbanking · Wallets" },
  { key: "cashfree", label: "Cashfree", hint: "Cards · UPI · EMI · Payouts" },
  { key: "payu", label: "PayU", hint: "Cards · UPI · Vault" },
  { key: "paytm", label: "Paytm", hint: "Paytm Wallet · UPI · Cards" },
  { key: "phonepe", label: "PhonePe", hint: "UPI-first" },
  { key: "stripe", label: "Stripe", hint: "International cards" },
  { key: "upi_qr", label: "UPI QR (manual)", hint: "Static QR / VPA — staff verify manually" },
  { key: "bank_transfer", label: "Bank transfer", hint: "NEFT / RTGS / IMPS — manual confirm" },
  { key: "custom", label: "Custom", hint: "Any provider — describe in notes" },
];

const PROVIDER_LABEL: Record<string, string> = Object.fromEntries(PROVIDERS.map((p) => [p.key, p.label]));

function providerLabel(p: string): string {
  return PROVIDER_LABEL[p] ?? p.replace(/_/g, " ");
}

function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  if (provider === "upi_qr") return <Smartphone className={className} />;
  if (provider === "bank_transfer") return <Landmark className={className} />;
  if (provider === "custom") return <Webhook className={className} />;
  return <CreditCard className={className} />;
}

function providerBadge(p: string): string {
  switch (p) {
    case "razorpay": return "border-warn/40 bg-warn/10 text-warn";
    case "cashfree": return "border-ok/40 bg-ok/10 text-ok";
    case "payu": return "border-pine-700/30 bg-pine-100 text-pine-700";
    case "paytm": return "border-brass/40 bg-brass-50 text-brass";
    case "phonepe": return "border-danger/30 bg-danger/10 text-danger";
    case "stripe": return "border-line-strong bg-plaster text-ink";
    default: return "border-line-strong bg-plaster text-muted-ink";
  }
}

interface Draft {
  propertyId: string;
  provider: string;
  label: string;
  mode: string;
  enabled: boolean;
  isDefault: boolean;
  merchantId: string;
  secret: string;
  notes: string;
}

function draftFrom(g?: GatewayRow | null): Draft {
  return {
    propertyId: g?.propertyId ?? "",
    provider: g?.provider ?? "razorpay",
    label: g?.label ?? "",
    mode: g?.mode ?? "test",
    enabled: g?.enabled ?? true,
    isDefault: g?.isDefault ?? false,
    merchantId: g?.merchantId ?? "",
    secret: "", // never pre-filled — empty means "keep existing" on PATCH
    notes: g?.notes ?? "",
  };
}

/* ─── main view ──────────────────────────────────────────────────────────── */

export default function PaymentGatewaysView() {
  const api = useOwnerApi();
  const { toast } = useToast();
  const [data, setData] = useState<GatewaysData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayRow | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [confirmDelete, setConfirmDelete] = useState<GatewayRow | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    try {
      const d = await api<GatewaysData>("/api/owner/payment-gateways");
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load payment gateways");
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  usePolling(load, 60000);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return data?.gateways ?? [];
    return (data?.gateways ?? []).filter((g) =>
      `${g.property.name} ${g.provider} ${g.label} ${g.mode} ${g.merchantId}`.toLowerCase().includes(q)
    );
  }, [data, search]);

  const openCreate = () => {
    setEditing(null);
    setDraft(draftFrom(null));
    setEditorOpen(true);
  };

  const openEdit = (g: GatewayRow) => {
    setEditing(g);
    setDraft(draftFrom(g));
    setEditorOpen(true);
  };

  const save = async () => {
    if (!draft.propertyId) {
      toast({ title: "Pick a business", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const body = JSON.stringify(draft);
      if (editing) {
        await api(`/api/owner/payment-gateways/${editing.id}`, { method: "PATCH", body });
        toast({ title: "Gateway updated", description: `${providerLabel(draft.provider)} · ${draft.mode.toUpperCase()} — the tenant's payment screens update instantly.` });
      } else {
        await api("/api/owner/payment-gateways", { method: "POST", body });
        toast({ title: "Gateway assigned", description: `${providerLabel(draft.provider)} is now available to the tenant's POS and billing.` });
      }
      setEditorOpen(false);
      await load();
    } catch (e) {
      toast({ title: "Could not save gateway", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async (g: GatewayRow) => {
    setBusy(true);
    try {
      await api(`/api/owner/payment-gateways/${g.id}`, { method: "DELETE" });
      toast({ title: "Gateway removed", description: `${providerLabel(g.provider)} no longer appears on ${g.property.name}'s payment screens.` });
      setConfirmDelete(null);
      await load();
    } catch (e) {
      toast({ title: "Could not remove gateway", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const toggleEnabled = async (g: GatewayRow, enabled: boolean) => {
    setBusy(true);
    try {
      await api(`/api/owner/payment-gateways/${g.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      await load();
    } catch (e) {
      toast({ title: "Could not update", description: e instanceof Error ? e.message : "Failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!data) return <Loading label="Loading payment gateways…" />;

  const s = data.summary;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-semibold text-pine tracking-tight leading-tight">Payment Gateways</h1>
          <p className="text-[12.5px] text-muted-ink mt-0.5">
            Assign online payment providers to tenant businesses — they appear instantly on the tenant's POS settle and folio payment screens.
          </p>
        </div>
        <button type="button" className="btn-pine h-9" onClick={openCreate} disabled={data.properties.length === 0}>
          <Plus className="h-4 w-4" /> Assign gateway
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: "Assignments", value: s.total, icon: CreditCard, cls: "text-pine" },
          { label: "Enabled", value: s.enabled, icon: Wallet, cls: "text-ok" },
          { label: "Live mode", value: s.live, icon: Webhook, cls: "text-brass" },
          { label: "Tenants wired", value: s.tenantsConfigured, icon: Landmark, cls: "text-pine" },
        ].map((c) => (
          <div key={c.label} className="panel px-4 py-3 flex items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-pine-700/10">
              <c.icon className={cn("h-4.5 w-4.5", c.cls)} />
            </div>
            <div>
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-ink">{c.label}</p>
              <p className="font-display text-xl font-semibold text-pine leading-tight">{c.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search business, provider, merchant id…" />
      </div>

      {/* List */}
      {filtered.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title={data.gateways.length === 0 ? "No gateways assigned yet" : "No matches"}
          hint={
            data.gateways.length === 0
              ? data.properties.length === 0
                ? "Add a business first — then assign its payment gateway here."
                : "Assign Razorpay, Cashfree, PayU and more to any business. The tenant sees the gateway on their payment screens the moment you save."
              : "Try a different search."
          }
        />
      ) : (
        <div className="panel overflow-hidden">
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Provider</th>
                  <th className="th">Mode</th>
                  <th className="th">Merchant ID</th>
                  <th className="th">Default</th>
                  <th className="th">Enabled</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((g) => (
                  <tr key={g.id} className="hover:bg-plaster/40 transition-colors">
                    <td className="td">
                      <p className="font-medium text-pine truncate max-w-[220px]" title={g.property.name}>{g.property.name}</p>
                      <p className="text-[11px] text-muted-ink">{g.property.city}{g.property.state ? `, ${g.property.state}` : ""}</p>
                    </td>
                    <td className="td">
                      <span className={cn("badge", providerBadge(g.provider))}>
                        <ProviderIcon provider={g.provider} className="h-3.5 w-3.5" />
                        {g.label || providerLabel(g.provider)}
                      </span>
                    </td>
                    <td className="td">
                      <span className={cn("badge", g.mode === "live" ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn")}>
                        {g.mode.toUpperCase()}
                      </span>
                    </td>
                    <td className="td">
                      <span className="font-mono text-xs">{g.merchantId || "—"}</span>
                      {g.hasSecret && <span className="ml-1.5 text-[10px] font-semibold text-ok">SECRET ✓</span>}
                    </td>
                    <td className="td">{g.isDefault ? <span className="badge border-brass/40 bg-brass-50 text-brass">Default</span> : <span className="text-muted-ink text-xs">—</span>}</td>
                    <td className="td">
                      <Switch checked={g.enabled} onCheckedChange={(v) => toggleEnabled(g, v)} disabled={busy} aria-label={`Toggle ${g.provider} for ${g.property.name}`} />
                    </td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-1">
                        <button type="button" className="btn-ghost h-8 w-8 p-0" onClick={() => openEdit(g)} title="Edit gateway" aria-label={`Edit ${g.provider} for ${g.property.name}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" className="btn-ghost h-8 w-8 p-0 text-danger" onClick={() => setConfirmDelete(g)} title="Remove gateway" aria-label={`Remove ${g.provider} from ${g.property.name}`}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Editor dialog */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-brass" />
              {editing ? "Edit gateway" : "Assign gateway"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? `Update ${providerLabel(editing.provider)} for ${editing.property.name}. Leave the secret empty to keep the stored one.`
                : "The tenant sees this gateway on their POS settle and folio payment screens immediately."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div>
              <Label>Business</Label>
              <Select value={draft.propertyId} onValueChange={(v) => setDraft((d) => ({ ...d, propertyId: v }))} disabled={!!editing}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select business" /></SelectTrigger>
                <SelectContent>
                  {data.properties.map((p) => (
                    <SelectItem key={p.id} value={p.id}>{p.name} — {p.city}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Provider</Label>
              <Select value={draft.provider} onValueChange={(v) => setDraft((d) => ({ ...d, provider: v }))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label} <span className="text-muted-ink">· {p.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Display label (optional)</Label>
                <Input
                  value={draft.label}
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  placeholder={`e.g. ${providerLabel(draft.provider)}`}
                />
              </div>
              <div>
                <Label>Mode</Label>
                <Select value={draft.mode} onValueChange={(v) => setDraft((d) => ({ ...d, mode: v }))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="test">TEST — sandbox keys</SelectItem>
                    <SelectItem value="live">LIVE — real money</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div>
              <Label>Merchant / Key ID</Label>
              <Input
                value={draft.merchantId}
                onChange={(e) => setDraft((d) => ({ ...d, merchantId: e.target.value }))}
                placeholder="e.g. rzp_live_xxxx…, VPA, account number"
              />
            </div>

            <div>
              <Label>Key secret {editing && <span className="text-muted-ink">(leave empty to keep stored)</span>}</Label>
              <Input
                type="password"
                value={draft.secret}
                onChange={(e) => setDraft((d) => ({ ...d, secret: e.target.value }))}
                placeholder={editing && editing.hasSecret ? "•••••••• (stored)" : "secret / salt"}
                autoComplete="new-password"
              />
              <p className="text-[11px] text-muted-ink mt-1">Encrypted at rest (AES-256-GCM). Never returned by any API or shown to the tenant.</p>
            </div>

            <div className="flex items-center justify-between rounded-md border border-line bg-plaster/40 px-3 py-2.5">
              <div>
                <Label className="mb-0">Enabled</Label>
                <p className="text-[11px] text-muted-ink">Disabled gateways disappear from tenant screens.</p>
              </div>
              <Switch checked={draft.enabled} onCheckedChange={(v) => setDraft((d) => ({ ...d, enabled: v }))} />
            </div>

            <div className="flex items-center justify-between rounded-md border border-line bg-plaster/40 px-3 py-2.5">
              <div>
                <Label className="mb-0">Default for this business</Label>
                <p className="text-[11px] text-muted-ink">The pre-selected gateway when several are enabled.</p>
              </div>
              <Switch checked={draft.isDefault} onCheckedChange={(v) => setDraft((d) => ({ ...d, isDefault: v }))} />
            </div>

            <div>
              <Label>Internal notes</Label>
              <Textarea
                value={draft.notes}
                onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
                placeholder="Platform-side notes — settlement account, KYC status, contact…"
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setEditorOpen(false)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-pine" onClick={save} disabled={busy || !draft.propertyId}>
              {editing ? "Save changes" : "Assign gateway"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Remove gateway?</DialogTitle>
            <DialogDescription>
              {confirmDelete && (
                <>
                  {providerLabel(confirmDelete.provider)} will disappear from {confirmDelete.property.name}&apos;s payment screens. Payment history is untouched.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setConfirmDelete(null)} disabled={busy}>Cancel</button>
            <button type="button" className="btn-outline border-danger text-danger" onClick={() => confirmDelete && doDelete(confirmDelete)} disabled={busy}>
              <Trash2 className="h-4 w-4" /> Remove
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
