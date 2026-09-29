"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Settings2, Save, Loader2, Info, ShieldCheck, EyeOff, MessageCircle, BadgeCheck, PlugZap, Clock, Webhook } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useOwnerApi, fmtDateTime, EmptyState, Loading, ErrorState } from "@/components/owner/shared";
import TwoFactorCard from "@/components/auth/TwoFactorCard";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface SettingRow {
  key: string;
  configured: boolean;
  sensitive: boolean;
  preview: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface SettingsData {
  groups: { group: string; settings: SettingRow[] }[];
}

const GROUP_META: Record<string, { title: string; hint: string }> = {
  billing: { title: "Billing defaults", hint: "Trial, grace & suspension behaviour, discounts and GST for every new business." },
  integrations: { title: "Integrations", hint: "Payment gateway, WhatsApp and SMTP credentials used platform-wide." },
  templates: { title: "Templates", hint: "Message templates tenants and daily jobs send out." },
  legal: { title: "Legal", hint: "Links shown in invoices and the booking engine footer." },
};

const TEXTAREA_KEYS = new Set([
  "tmpl_welcome_email", "tmpl_welcome_whatsapp", "tmpl_booking_confirmation", "tmpl_pre_arrival",
]);

const NUMBER_KEYS = new Set([
  "default_trial_days", "grace_days", "suspend_retention_days",
  "yearly_discount_percent", "quarterly_discount_percent", "gst_rate",
]);

const KEY_LABELS: Record<string, string> = {
  default_trial_days: "Default trial (days)",
  grace_days: "Grace period (days)",
  suspend_retention_days: "Suspend retention (days)",
  yearly_discount_percent: "Yearly discount (%)",
  quarterly_discount_percent: "Quarterly discount (%)",
  gst_rate: "GST rate (%)",
  company_name: "Company name",
  company_gstin: "Company GSTIN",
  razorpay_key_id: "Razorpay key id",
  razorpay_key_secret: "Razorpay key secret",
  whatsapp_phone_id: "WhatsApp phone id",
  whatsapp_token: "WhatsApp token",
  smtp_host: "SMTP host",
  smtp_user: "SMTP user",
  smtp_pass: "SMTP password",
  tmpl_welcome_email: "Welcome email template",
  tmpl_welcome_whatsapp: "Welcome WhatsApp template",
  tmpl_booking_confirmation: "Booking confirmation template",
  tmpl_pre_arrival: "Pre-arrival template",
  terms_url: "Terms of service URL",
  privacy_url: "Privacy policy URL",
};

function keyLabel(key: string): string {
  return KEY_LABELS[key] ?? key.replace(/_/g, " ");
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function SettingsView() {
  const api = useOwnerApi();
  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<SettingsData>("/api/owner/settings");
      setData(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Encryption note */}
      <Alert className="border-line bg-panel">
        <ShieldCheck className="h-4 w-4 text-brass" />
        <AlertTitle className="text-pine text-sm">Secrets are encrypted, never displayed</AlertTitle>
        <AlertDescription className="text-muted-ink text-xs">
          Sensitive values (Razorpay keys, WhatsApp token, SMTP password) are AES-256-GCM encrypted at rest and masked forever — the console only ever shows the last 4 characters. Leave a sensitive field blank to keep the stored value.
        </AlertDescription>
      </Alert>

      {/* Security — personal account two-factor authentication (platform owner + team members) */}
      <TwoFactorCard />

      {/* Platform-wide WhatsApp Cloud API — dedicated card (writes the same encrypted store as the raw whatsapp_* keys in Integrations below) */}
      <WhatsAppPlatformCard />

      {loading ? (
        <Loading label="Loading settings…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data || data.groups.length === 0 ? (
        <EmptyState icon={Settings2} title="No setting groups" hint="Platform settings will appear here once defined." />
      ) : (
        data.groups.map((g) => (
          <SettingsGroupPanel key={g.group} group={g.group} settings={g.settings} onSaved={() => void load()} />
        ))
      )}
    </div>
  );
}

// ─── WhatsApp Cloud API (Platform) ─────────────────────────────────────────

interface WaPlatformState {
  configured: boolean;
  displayPhone: string;
  phoneNumberId: string;
  wabaId: string;
  tokenMasked: string;
  status: "connected" | "disconnected";
  lastCheckedAt: string | null;
  updatedAt: string | null;
}

function WhatsAppPlatformCard() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [state, setState] = useState<WaPlatformState | null>(null);
  const [loading, setLoading] = useState(true);
  const [displayPhone, setDisplayPhone] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<WaPlatformState>("/api/owner/whatsapp");
      setState(res);
      setDisplayPhone(res.displayPhone);
      setPhoneNumberId(res.phoneNumberId);
      setWabaId(res.wabaId);
      setAccessToken("");
      setTestResult(null);
    } catch (e) {
      toast({ title: "Could not load WhatsApp settings", description: errText(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [api, toast]);

  useEffect(() => { void load(); }, [load]);

  const dirty =
    !!state &&
    (displayPhone !== state.displayPhone ||
      phoneNumberId !== state.phoneNumberId ||
      wabaId !== state.wabaId ||
      accessToken.trim().length > 0);

  async function save() {
    if (!phoneNumberId.trim()) {
      toast({ title: "Phone Number ID is required", variant: "destructive" });
      return;
    }
    if (!accessToken.trim() && !state?.configured) {
      toast({ title: "Access token is required", description: "Paste a system-user token to configure the platform number.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await api("/api/owner/whatsapp", {
        method: "PUT",
        body: JSON.stringify({ displayPhone, phoneNumberId, wabaId, accessToken }),
      });
      toast({ title: "WhatsApp Cloud API saved", description: "Run Test connection to verify the credentials with Meta." });
      await load();
    } catch (e) {
      toast({ title: "Save failed", description: errText(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const res = await api<{ ok: boolean; message: string }>("/api/owner/whatsapp", {
        method: "POST",
        body: JSON.stringify({ action: "test" }),
      });
      setTestResult(res);
      toast(
        res.ok
          ? { title: "WhatsApp connected", description: res.message }
          : { title: "Connection test failed", description: res.message, variant: "destructive" }
      );
      await load();
    } catch (e) {
      toast({ title: "Connection test failed", description: errText(e), variant: "destructive" });
    } finally {
      setTesting(false);
    }
  }

  const statusBadge = !state?.configured
    ? { cls: "border-line-strong bg-plaster text-muted-ink", label: "Not configured" }
    : state.status === "connected"
      ? { cls: "border-ok/40 bg-ok/10 text-ok", label: "Connected" }
      : { cls: "border-warn/40 bg-warn/10 text-warn", label: "Test pending" };

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <p className="panel-title flex items-center gap-2">
            <MessageCircle className="h-4 w-4 text-brass" /> WhatsApp Cloud API (Platform)
          </p>
          <p className="text-xs text-muted-ink mt-0.5">
            Platform-wide WhatsApp number — hotels without their own connection send guest messages through it. Tenants can also connect their own number from their Settings.
          </p>
        </div>
        <span className={`badge text-[10px] py-0.5 ${statusBadge.cls}`}>{statusBadge.label}</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-ink">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <>
          <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
            <div>
              <Label htmlFor="wa-plat-display" className="field-label mb-1">Display number</Label>
              <Input id="wa-plat-display" value={displayPhone} placeholder="+91 98200 11223"
                onChange={(e) => setDisplayPhone(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wa-plat-waba" className="field-label mb-1">WhatsApp Business Account ID (WABA)</Label>
              <Input id="wa-plat-waba" value={wabaId} placeholder="e.g. 10245789635412"
                onChange={(e) => setWabaId(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="wa-plat-phone-id" className="field-label mb-1">Phone Number ID *</Label>
              <Input id="wa-plat-phone-id" value={phoneNumberId} placeholder="From Meta WhatsApp → API Setup"
                onChange={(e) => setPhoneNumberId(e.target.value)} />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <Label htmlFor="wa-plat-token" className="field-label mb-0">Access token {state?.configured ? "" : "*"}</Label>
                <span className="badge border-warn/40 bg-warn/10 text-warn text-[10px] py-0">
                  <EyeOff className="h-2.5 w-2.5" /> sensitive
                </span>
              </div>
              <Input
                id="wa-plat-token"
                type="password"
                autoComplete="new-password"
                value={accessToken}
                onChange={(e) => setAccessToken(e.target.value)}
                placeholder={
                  state?.configured
                    ? `configured ${state.tokenMasked || "••••"} — leave blank to keep`
                    : "EAAG… system-user token"
                }
              />
              <p className="text-[11px] text-muted-ink mt-1">AES-256-GCM encrypted at rest — only a masked hint is ever shown.</p>
            </div>
          </div>

          {testResult && (
            <div className="mx-4 mb-3">
              <Alert className={testResult.ok ? "border-ok/40 bg-ok/5" : "border-danger/30 bg-danger/5"}>
                {testResult.ok ? <BadgeCheck className="h-4 w-4 text-ok" /> : <PlugZap className="h-4 w-4 text-danger" />}
                <AlertTitle className={`text-sm ${testResult.ok ? "text-ok" : "text-danger"}`}>
                  {testResult.ok ? "Connection verified" : "Test failed"}
                </AlertTitle>
                <AlertDescription className="text-muted-ink text-xs">{testResult.message}</AlertDescription>
              </Alert>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 px-4 pb-4">
            <button className="btn-pine h-8" disabled={saving || testing || (!dirty && state?.configured)} onClick={() => void save()}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
            </button>
            <button className="btn-outline h-8" disabled={saving || testing} onClick={() => void test()}>
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Test connection
            </button>
            <span className="text-[11px] text-muted-ink ml-auto inline-flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {state?.lastCheckedAt ? `Last tested ${fmtDateTime(state.lastCheckedAt)}` : "Never tested"}
              {state?.updatedAt ? ` · updated ${fmtDateTime(state.updatedAt)}` : ""}
            </span>
          </div>

          <div className="px-4 pb-4">
            <p className="text-[11px] text-muted-ink flex items-start gap-1.5">
              <Info className="h-3 w-3 mt-0.5 shrink-0 text-brass" />
              <span>
                Used as the fallback sender for every tenant without their own WhatsApp connection. Webhook events arrive at{" "}
                <code className="rounded bg-plaster-deep/60 px-1 py-0.5 text-[10.5px] text-pine-700">/api/whatsapp/webhook</code> (GET,POST).
                <Webhook className="ml-1 inline h-3 w-3 text-muted-ink" />
              </span>
            </p>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Group panel ─────────────────────────────────────────────────────────────

function SettingsGroupPanel({ group, settings, onSaved }: {
  group: string;
  settings: SettingRow[];
  onSaved: () => void;
}) {
  const api = useOwnerApi();
  const { toast } = useToast();

  // draft values — sensitive keys always start EMPTY (never prefilled)
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const s of settings) {
      // Sensitive keys always start EMPTY. Non-sensitive keys prefill only when
      // the preview is the full value (not truncated with "…").
      const fullPreview = s.configured && !s.sensitive && !s.preview.endsWith("…");
      initial[s.key] = fullPreview ? s.preview : "";
    }
    setDrafts(initial);
  }, [settings]);

  const meta = GROUP_META[group] ?? { title: group, hint: "" };

  const changedKeys = useMemo(() => {
    return settings
      .filter((s) => {
        const v = (drafts[s.key] ?? "").trim();
        if (s.sensitive) return v.length > 0; // blank = keep stored value
        return v !== (s.configured ? s.preview : "");
      })
      .map((s) => s.key);
  }, [settings, drafts]);

  async function save() {
    if (changedKeys.length === 0) return;
    setSaving(true);
    try {
      const payload: Record<string, string> = {};
      for (const k of changedKeys) payload[k] = (drafts[k] ?? "").trim();
      const res = await api<{ ok: boolean; saved: number }>("/api/owner/settings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast({ title: "Settings saved", description: `${res.saved} value${res.saved === 1 ? "" : "s"} updated.` });
      onSaved();
    } catch (e) {
      toast({ title: "Save failed", description: errText(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <p className="panel-title flex items-center gap-2"><Settings2 className="h-4 w-4 text-brass" /> {meta.title}</p>
          {meta.hint && <p className="text-xs text-muted-ink mt-0.5">{meta.hint}</p>}
        </div>
        <button className="btn-pine h-8" disabled={saving || changedKeys.length === 0} onClick={() => void save()}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save{changedKeys.length > 0 ? ` (${changedKeys.length})` : ""}
        </button>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-4">
        {settings.map((s) => {
          const value = drafts[s.key] ?? "";
          const dirty = changedKeys.includes(s.key);
          return (
            <div key={s.key}>
              <div className="flex flex-wrap items-center gap-1.5 mb-1">
                <Label htmlFor={`set-${s.key}`} className="field-label mb-0">{keyLabel(s.key)}</Label>
                {s.sensitive && (
                  <span className="badge border-warn/40 bg-warn/10 text-warn text-[10px] py-0">
                    <EyeOff className="h-2.5 w-2.5" /> sensitive
                  </span>
                )}
                <span className={`badge text-[10px] py-0 ${s.configured ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"}`}>
                  {s.configured ? "configured" : "not set"}
                </span>
                {dirty && <span className="badge border-brass/40 bg-brass/10 text-brass text-[10px] py-0">edited</span>}
              </div>

              {s.sensitive ? (
                <Input
                  id={`set-${s.key}`}
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder={
                    s.configured
                      ? `configured ${s.preview || "••••"} — leave blank to keep`
                      : "not configured — enter value"
                  }
                />
              ) : TEXTAREA_KEYS.has(s.key) ? (
                <Textarea
                  id={`set-${s.key}`}
                  rows={3}
                  className="font-mono text-xs"
                  value={value}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder={s.configured ? s.preview : "Template body…"}
                />
              ) : (
                <Input
                  id={`set-${s.key}`}
                  type={NUMBER_KEYS.has(s.key) ? "number" : "text"}
                  min={NUMBER_KEYS.has(s.key) ? 0 : undefined}
                  step="any"
                  value={value}
                  onChange={(e) => setDrafts((d) => ({ ...d, [s.key]: e.target.value }))}
                  placeholder={s.configured ? s.preview : keyLabel(s.key)}
                />
              )}

              <p className="text-[11px] text-muted-ink mt-1">
                {s.configured
                  ? <>Set by {s.updatedBy ?? "system"} · {fmtDateTime(s.updatedAt)}</>
                  : "Never configured"}
              </p>
            </div>
          );
        })}
      </div>
      {group === "billing" && (
        <div className="px-4 pb-4">
          <p className="text-[11px] text-muted-ink flex items-start gap-1.5">
            <Info className="h-3 w-3 mt-0.5 shrink-0 text-brass" />
            These defaults drive onboarding (trial length), the daily jobs (grace → suspension → retention) and every generated invoice (GST %).
          </p>
        </div>
      )}
    </div>
  );
}
