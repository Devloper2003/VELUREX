"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BadgeCheck, Check, Copy, CreditCard, ExternalLink, Info, KeyRound, Link2,
  Loader2, Pencil, Plus, PlugZap, RefreshCw, Trash2, Wallet, X,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * Settings → Payments — the tenant links THEIR OWN payment gateway.
 * Guest payments (POS settle, folio, booking widget, payment links) are then
 * charged through this account and settle into the tenant's bank account.
 */

interface GatewayRow {
  id: string;
  provider: string;
  providerLabel: string;
  label: string;
  mode: "test" | "live";
  enabled: boolean;
  isDefault: boolean;
  merchantId: string;
  merchantHint: string;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  online: boolean;
  notes: string;
  addedBy: string;
  updatedAt: string;
}

interface ProviderMeta {
  key: string;
  label: string;
  desc: string;
  online: boolean;
  idLabel: string;
  secretLabel: string;
  consoleHint: string;
}

const emptyForm = {
  provider: "razorpay",
  label: "",
  mode: "test" as "test" | "live",
  merchantId: "",
  keySecret: "",
  webhookSecret: "",
  notes: "",
  enabled: true,
  isDefault: false,
};

export default function PaymentGatewaysSettings({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<GatewayRow[]>([]);
  const [providers, setProviders] = useState<ProviderMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<GatewayRow | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, { ok: boolean; message: string }>>({});
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ gateways: GatewayRow[]; providers: ProviderMeta[] }>("/api/settings/payment-gateways");
      setRows(d.gateways);
      setProviders(d.providers);
    } catch (e) {
      toast({ title: "Could not load payment gateways", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const meta = (key: string) => providers.find((p) => p.key === key);

  const openAdd = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setDialogOpen(true);
  };

  const openEdit = (g: GatewayRow) => {
    setEditing(g);
    setForm({
      provider: g.provider,
      label: g.label,
      mode: g.mode,
      merchantId: g.merchantId,
      keySecret: "", // keep stored secret unless a new one is typed
      webhookSecret: "",
      notes: g.notes,
      enabled: g.enabled,
      isDefault: g.isDefault,
    });
    setDialogOpen(true);
  };

  const save = async () => {
    const m = meta(form.provider);
    if (m?.online && !form.merchantId.trim() && !editing) {
      toast({ title: `${m.idLabel} is required`, variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/settings/payment-gateways/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify(form),
        });
        toast({ title: "Gateway updated", description: form.label || m?.label || form.provider });
      } else {
        await api("/api/settings/payment-gateways", { method: "POST", body: JSON.stringify(form) });
        toast({
          title: "Gateway linked",
          description: `${form.label || m?.label || form.provider} (${form.mode}) — guest payments now route through your account.`,
        });
      }
      setDialogOpen(false);
      load();
    } catch (e) {
      toast({ title: editing ? "Could not update gateway" : "Could not link gateway", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const test = async (g: GatewayRow) => {
    setTestingId(g.id);
    try {
      const r = await api<{ ok: boolean; message: string }>(`/api/settings/payment-gateways/${g.id}/test`, { method: "POST" });
      setTestResult((prev) => ({ ...prev, [g.id]: r }));
      if (r.ok) toast({ title: "Connection OK", description: r.message });
      else toast({ title: "Connection failed", description: r.message, variant: "destructive" });
    } catch (e) {
      toast({ title: "Test failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setTestingId(null);
    }
  };

  const toggleEnabled = async (g: GatewayRow, enabled: boolean) => {
    if (!isAdmin) return;
    setRows((prev) => prev.map((r) => (r.id === g.id ? { ...r, enabled } : r)));
    try {
      await api(`/api/settings/payment-gateways/${g.id}`, { method: "PATCH", body: JSON.stringify({ enabled }) });
      toast({ title: enabled ? "Gateway enabled" : "Gateway paused" });
    } catch (e) {
      setRows((prev) => prev.map((r) => (r.id === g.id ? { ...r, enabled: !enabled } : r)));
      toast({ title: "Could not update gateway", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };

  const remove = async (g: GatewayRow) => {
    if (!confirm(`Unlink ${g.label || g.providerLabel}? Guest payments will no longer be able to use it.`)) return;
    setDeletingId(g.id);
    try {
      await api(`/api/settings/payment-gateways/${g.id}`, { method: "DELETE" });
      toast({ title: "Gateway unlinked", description: g.label || g.providerLabel });
      load();
    } catch (e) {
      toast({ title: "Could not unlink", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDeletingId(null);
    }
  };

  const copyWebhook = async (g: GatewayRow) => {
    const url = `${window.location.origin}/api/payments/webhook/${g.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: "Webhook URL copied", description: "Paste it in your gateway dashboard" });
    } catch {
      toast({ title: "Copy failed", description: url, variant: "destructive" });
    }
  };

  const onlineCount = rows.filter((r) => r.online && r.enabled).length;
  const liveCount = rows.filter((r) => r.mode === "live" && r.enabled).length;

  return (
    <div className="space-y-4">
      {/* ── How it works ── */}
      <div className="panel p-4">
        <div className="flex flex-col sm:flex-row items-start gap-3">
          <div className="rounded-lg bg-pine-700/10 p-2 shrink-0">
            <Info className="h-4 w-4 text-pine-700" />
          </div>
          <div className="min-w-0">
            <p className="text-[13.5px] font-semibold text-pine">Link your own gateway — money settles into YOUR account</p>
            <p className="text-[12.5px] text-muted-ink mt-1 leading-relaxed">
              Connect your Razorpay / Stripe (or any) account once. After that, every guest payment — POS settle, folio
              payment, the booking widget on your website and shareable payment links — is charged through{" "}
              <b>your</b> gateway and settles directly into <b>your</b> bank account. Keys are encrypted at rest and
              never shown again after saving.
            </p>
            <div className="flex flex-wrap gap-1.5 mt-2.5">
              <span className="badge border-line-strong bg-plaster text-[10.5px]">
                <Wallet className="h-3 w-3" /> {rows.length} linked
              </span>
              <span className={cn("badge text-[10.5px]", onlineCount ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink")}>
                <PlugZap className="h-3 w-3" /> {onlineCount} online active
              </span>
              <span className={cn("badge text-[10.5px]", liveCount ? "border-brass/40 bg-brass-50 text-brass" : "border-line-strong bg-plaster text-muted-ink")}>
                <BadgeCheck className="h-3 w-3" /> {liveCount} live mode
              </span>
            </div>
          </div>
          {isAdmin && (
            <button className="btn-pine h-9 shrink-0 w-full sm:w-auto sm:ml-auto" onClick={openAdd}>
              <Plus className="h-4 w-4" /> Link gateway
            </button>
          )}
        </div>
      </div>

      {/* ── Gateway list ── */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-brass" />
            <p className="panel-title">Linked gateways</p>
          </div>
          <button className="btn-outline h-8" onClick={load} disabled={loading}>
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
          </button>
        </div>

        {loading ? (
          <div className="p-5 space-y-3">
            <div className="skeleton h-16 rounded-lg" />
            <div className="skeleton h-16 rounded-lg" />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center">
            <div className="mx-auto w-fit rounded-full bg-plaster-deep p-3">
              <CreditCard className="h-6 w-6 text-muted-ink" />
            </div>
            <p className="mt-3 text-[13.5px] font-semibold text-pine">No gateway linked yet</p>
            <p className="mx-auto mt-1 max-w-md text-[12.5px] text-muted-ink">
              {isAdmin
                ? "Link Razorpay, Stripe or another provider to start collecting guest payments into your own account."
                : "Ask your hotel admin to link a payment gateway here."}
            </p>
            {isAdmin && (
              <button className="btn-pine h-9 mt-4" onClick={openAdd}>
                <Plus className="h-4 w-4" /> Link your first gateway
              </button>
            )}
          </div>
        ) : (
          <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-3 min-w-0">
            {rows.map((g) => {
              const m = meta(g.provider);
              const tr = testResult[g.id];
              return (
                <div
                  key={g.id}
                  className={cn(
                    "rounded-xl border p-3.5 space-y-2.5 transition",
                    g.enabled ? "border-line-strong bg-panel" : "border-line bg-plaster/40 opacity-75"
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="rounded-lg bg-pine-700/10 p-2 shrink-0">
                      <CreditCard className="h-4 w-4 text-pine-700" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13.5px] font-semibold text-pine truncate">
                        {g.label || g.providerLabel}
                        {g.isDefault && (
                          <span className="badge border-brass/40 bg-brass-50 text-brass ml-1.5 px-1.5 py-0 text-[10px] align-middle">
                            default
                          </span>
                        )}
                      </p>
                      <p className="text-[11.5px] text-muted-ink truncate">
                        {g.providerLabel} · {m?.online ? "online collection" : "manual / offline method"}
                      </p>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span
                        className={cn(
                          "badge px-1.5 py-0 text-[10px]",
                          g.mode === "live" ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"
                        )}
                      >
                        {g.mode}
                      </span>
                      {isAdmin && (
                        <Switch checked={g.enabled} onCheckedChange={(v) => toggleEnabled(g, v)} aria-label="Toggle gateway" />
                      )}
                    </div>
                  </div>

                  <div className="rounded-lg bg-plaster-deep/50 border border-line px-2.5 py-2 space-y-1 min-w-0">
                    <p className="flex items-center gap-1.5 text-[11.5px] text-muted-ink min-w-0">
                      <KeyRound className="h-3 w-3 shrink-0" />
                      <span className="font-mono truncate min-w-0">{g.merchantHint || "—"}</span>
                      <span className={cn("ml-auto shrink-0", g.hasSecret ? "text-ok" : "text-warn")}>
                        {g.hasSecret ? "secret saved" : "no secret"}
                      </span>
                    </p>
                    {m?.online && (
                      <p className="flex items-center gap-1.5 text-[11px] text-muted-ink min-w-0">
                        <Link2 className="h-3 w-3 shrink-0" />
                        <span className="font-mono truncate min-w-0" title={`${typeof window !== "undefined" ? window.location.origin : ""}/api/payments/webhook/${g.id}`}>
                          …/api/payments/webhook/{g.id.slice(-6)}
                        </span>
                        <button
                          type="button"
                          className="ml-auto shrink-0 inline-flex items-center gap-1 hover:text-pine"
                          onClick={() => copyWebhook(g)}
                          title="Copy webhook URL"
                        >
                          <Copy className="h-3 w-3" /> Copy
                        </button>
                      </p>
                    )}
                  </div>

                  {tr && (
                    <p className={cn("flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11.5px]", tr.ok ? "bg-ok/10 text-ok" : "bg-danger/10 text-danger")}>
                      {tr.ok ? <Check className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <X className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                      {tr.message}
                    </p>
                  )}

                  {isAdmin && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button className="btn-outline h-7 px-2.5 text-[11.5px]" onClick={() => test(g)} disabled={testingId === g.id}>
                        {testingId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlugZap className="h-3 w-3" />}
                        Test connection
                      </button>
                      <button className="btn-ghost h-7 px-2.5 text-[11.5px]" onClick={() => openEdit(g)}>
                        <Pencil className="h-3 w-3" /> Edit
                      </button>
                      {!g.isDefault && (
                        <button
                          className="btn-ghost h-7 px-2.5 text-[11.5px] text-danger hover:bg-danger/10 ml-auto"
                          onClick={() => remove(g)}
                          disabled={deletingId === g.id}
                        >
                          {deletingId === g.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />} Unlink
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Link / edit dialog ── */}
      <Dialog open={dialogOpen} onOpenChange={(o) => !saving && setDialogOpen(o)}>
        <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-4 w-4 text-brass" />
              {editing ? "Edit gateway" : "Link your payment gateway"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Update the credentials or switch test/live mode. Leave secret fields empty to keep the saved ones."
                : "Use YOUR account keys — every guest payment will be charged here and settle into your bank account."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-1">
            <div>
              <label className="field-label">Provider</label>
              <Select
                value={form.provider}
                onValueChange={(v) => setForm((f) => ({ ...f, provider: v }))}
                disabled={Boolean(editing)}
              >
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.key} value={p.key}>
                      {p.label} — {p.online ? "online collection" : "manual"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {meta(form.provider) && (
                <p className="mt-1.5 text-[11.5px] text-muted-ink">{meta(form.provider)!.desc}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Display name (optional)</label>
                <Input
                  value={form.label}
                  onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                  placeholder={meta(form.provider)?.label ?? "e.g. Front-desk Razorpay"}
                  maxLength={80}
                />
              </div>
              <div>
                <label className="field-label">Mode</label>
                <div className="inline-flex w-full rounded-lg border border-line-strong bg-plaster-deep/50 p-1">
                  {(["test", "live"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, mode: m }))}
                      className={cn(
                        "h-7 flex-1 rounded-md text-[12px] font-medium transition capitalize",
                        form.mode === m ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {meta(form.provider)?.online && (
              <>
                <div>
                  <label className="field-label">
                    {meta(form.provider)?.idLabel} <span className="text-danger">*</span>
                  </label>
                  <Input
                    value={form.merchantId}
                    onChange={(e) => setForm((f) => ({ ...f, merchantId: e.target.value }))}
                    placeholder={form.provider === "razorpay" ? "rzp_test_xxxxxxxxxx" : form.provider === "stripe" ? "pk_live_…" : "your merchant id"}
                    className="font-mono text-[12.5px]"
                    autoComplete="off"
                  />
                </div>
                <div>
                  <label className="field-label">
                    {meta(form.provider)?.secretLabel}{" "}
                    {editing?.hasSecret && <span className="text-[10.5px] text-muted-ink">(saved — leave blank to keep)</span>}
                  </label>
                  <Input
                    type="password"
                    value={form.keySecret}
                    onChange={(e) => setForm((f) => ({ ...f, keySecret: e.target.value }))}
                    placeholder={form.provider === "razorpay" ? "••••••••••••" : "your secret key"}
                    className="font-mono text-[12.5px]"
                    autoComplete="new-password"
                  />
                </div>
                <div>
                  <label className="field-label">
                    Webhook secret{" "}
                    {editing?.hasWebhookSecret && <span className="text-[10.5px] text-muted-ink">(saved — leave blank to keep)</span>}
                  </label>
                  <Input
                    type="password"
                    value={form.webhookSecret}
                    onChange={(e) => setForm((f) => ({ ...f, webhookSecret: e.target.value }))}
                    placeholder="optional — from your gateway dashboard"
                    className="font-mono text-[12.5px]"
                    autoComplete="new-password"
                  />
                  <p className="mt-1 text-[11px] text-muted-ink">
                    Used to verify gateway webhooks so payments taken on hosted pages update the folio automatically.
                  </p>
                </div>
              </>
            )}

            {meta(form.provider)?.online && (
              <div className="rounded-lg border border-line bg-plaster-deep/40 px-3 py-2.5 text-[11.5px] text-muted-ink flex items-start gap-2">
                <ExternalLink className="h-3.5 w-3.5 mt-0.5 shrink-0 text-brass" />
                <span>
                  Find these in <b className="text-pine">{meta(form.provider)?.consoleHint}</b>. Use test keys first —
                  switch to live only after a successful test charge.
                </span>
              </div>
            )}

            <div>
              <label className="field-label">Private notes (optional)</label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. account belongs to proprietor — do not change keys without owner approval"
                maxLength={500}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line px-3 py-2.5">
              <label className="flex items-center gap-2 text-[12.5px] text-pine">
                <Switch
                  checked={form.enabled}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                  aria-label="Enabled"
                />
                Enabled
              </label>
              <label className="flex items-center gap-2 text-[12.5px] text-pine">
                <Switch
                  checked={form.isDefault}
                  onCheckedChange={(v) => setForm((f) => ({ ...f, isDefault: v }))}
                  aria-label="Default"
                />
                Make default
              </label>
            </div>
          </div>

          <DialogFooter>
            <button type="button" className="btn-ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="btn-pine" onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {editing ? "Save changes" : "Link gateway"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
