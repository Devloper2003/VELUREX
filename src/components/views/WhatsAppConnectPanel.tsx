"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { fmtDateTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  BadgeCheck, Check, ChefHat, Copy, ExternalLink, Eye, EyeOff, Image as ImageIcon, KeyRound, Loader2, MessageCircle,
  Phone, PlugZap, RefreshCw, Send, ShieldCheck, Unplug, Webhook,
} from "lucide-react";

/**
 * Tenant self-service WhatsApp Cloud API connection (Settings → WhatsApp API).
 * Status summary card + 3 numbered steps (Meta app credentials → Webhook
 * pairing → Verify & test). Existing configs are prefilled so the hotel can
 * UPDATE any field; the saved access token stays blank with only a masked
 * hint — never rendered in full.
 */

interface WaConfig {
  displayPhone: string;
  phoneNumberId: string;
  wabaId: string;
  hasToken: boolean;
  tokenHint: string;
  verifyToken: string;
  status: "disconnected" | "connected" | "error";
  lastError: string;
  lastCheckedAt: string | null;
  connectedAt: string | null;
}
interface WaResp {
  config: WaConfig;
  provider: "tenant" | "platform" | "mock";
  webhookUrl: string;
}

/** Detailed Meta walkthrough — collapsed inside step 1. */
const META_GUIDE = [
  {
    title: "Create your Meta Business assets",
    body: "Sign up at business.facebook.com, then create a WhatsApp Business Account (WABA) and add your hotel's phone number. Note the Phone Number ID and WABA ID from the WhatsApp → API Setup page.",
  },
  {
    title: "Generate a permanent access token",
    body: "In Business Settings → Users → System users, add a system user with the Admin role and generate a token with the whatsapp_business_messaging + whatsapp_business_management permissions. Paste it below — it is encrypted before storage.",
  },
  {
    title: "Save & test the connection",
    body: "Fill the credentials form and press Test connection in step 3. Velurex verifies the token against the Meta Graph API and marks the hotel connected.",
  },
  {
    title: "Pair the webhook",
    body: "In your Meta App dashboard (WhatsApp → Configuration) set the Callback URL and Verify token exactly as shown in step 2, then subscribe to the messages field.",
  },
  {
    title: "Send a test message",
    body: "Use Send test in step 3 to deliver a real WhatsApp text to your own phone and confirm the pipeline end-to-end.",
  },
];

function StepBadge({ n }: { n: number }) {
  return (
    <span className="h-7 w-7 shrink-0 rounded-full bg-pine-700 text-panel text-[12px] font-semibold flex items-center justify-center" aria-hidden>
      {n}
    </span>
  );
}

export default function WhatsAppConnectPanel({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();

  const [resp, setResp] = useState<WaResp | null>(null);
  const [loading, setLoading] = useState(true);

  // form state
  const [displayPhone, setDisplayPhone] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [verifyToken, setVerifyToken] = useState("");
  const [dirty, setDirty] = useState(false);

  const [busy, setBusy] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState("");
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<WaResp>("/api/whatsapp/config");
      setResp(r);
      setDisplayPhone(r.config.displayPhone);
      setPhoneNumberId(r.config.phoneNumberId);
      setWabaId(r.config.wabaId);
      setVerifyToken(r.config.verifyToken);
      setAccessToken("");
      setDirty(false);
    } catch (e) {
      toast({ title: "Could not load WhatsApp settings", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  function copy(label: string, value: string) {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(null), 1600);
    });
  }

  async function save(next?: () => void) {
    setBusy("save");
    try {
      await api("/api/whatsapp/config", {
        method: "PUT",
        body: JSON.stringify({ displayPhone, phoneNumberId, wabaId, accessToken, verifyToken }),
      });
      setDirty(false);
      toast({ title: "WhatsApp credentials saved", description: "Run Test connection to verify and go live." });
      await load();
      next?.();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy("test");
    try {
      const run = async () => {
        const r = await api<{ ok: boolean; status: string; error: string }>("/api/whatsapp/config/test", { method: "POST" });
        if (r.ok) {
          toast({ title: "WhatsApp connected 🎉", description: "Meta verified your credentials. Your hotel number is now live." });
        } else {
          toast({ title: "Connection test failed", description: r.error || "Check your credentials and try again.", variant: "destructive" });
        }
        await load();
      };
      if (dirty) await save(run);
      else await run();
    } catch (e) {
      toast({ title: "Connection test failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy("disconnect");
    try {
      await api("/api/whatsapp/config/disconnect", { method: "POST" });
      toast({ title: "WhatsApp disconnected", description: "Saved IDs were kept — re-enter a token to connect again." });
      await load();
    } catch (e) {
      toast({ title: "Disconnect failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  async function sendTest() {
    if (!testPhone.trim()) {
      toast({ title: "Enter a phone number first", variant: "destructive" });
      return;
    }
    setBusy("testMsg");
    try {
      const r = await api<{ ok: boolean; status: string }>("/api/whatsapp/config/test-message", {
        method: "POST",
        body: JSON.stringify({ phone: testPhone }),
      });
      if (r.status === "sent") toast({ title: "Test message sent", description: `Delivered to ${testPhone} via your WhatsApp number.` });
      else if (r.status === "mock") toast({ title: "Simulated (mock) message", description: "No live credentials yet — connect WhatsApp Cloud API to send real messages." });
      else toast({ title: "Send failed", description: "Meta rejected the message — check the token and phone number.", variant: "destructive" });
    } catch (e) {
      toast({ title: "Send failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  }

  const cfg = resp?.config;
  const status = cfg?.status ?? "disconnected";
  const configured = Boolean(cfg?.phoneNumberId && cfg?.hasToken);

  const statusChip =
    status === "connected"
      ? { cls: "border-ok/40 bg-ok/10 text-ok", label: "Connected", icon: BadgeCheck }
      : status === "error"
        ? { cls: "border-danger/30 bg-danger/10 text-danger", label: "Error — check message", icon: RefreshCw }
        : { cls: "border-line-strong bg-plaster text-muted-ink", label: "Disconnected", icon: Unplug };

  return (
    <div className="space-y-4">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div>
        <h2 className="font-display text-[18px] font-semibold text-pine tracking-tight flex items-center gap-2">
          <MessageCircle className="h-4.5 w-4.5 text-brass" /> WhatsApp Cloud API
        </h2>
        <p className="text-[12.5px] text-muted-ink mt-0.5">
          Connect your own WhatsApp Business number so booking confirmations, pre-arrival notes and guest chats are sent from <em>your</em> number.
        </p>
      </div>

      {/* ── Status summary card ───────────────────────────────────────── */}
      <div className="panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold", statusChip.cls)}>
              <statusChip.icon className="h-3.5 w-3.5" /> {statusChip.label}
            </span>
            {resp?.provider === "platform" && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-brass/40 bg-brass-50 px-2.5 py-1 text-[11px] font-semibold text-brass">
                <ShieldCheck className="h-3.5 w-3.5" /> Platform fallback active
              </span>
            )}
            {status === "connected" && cfg?.displayPhone && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-plaster px-2.5 py-1 text-[11px] font-medium text-muted-ink">
                <Phone className="h-3 w-3" /> {cfg.displayPhone}
              </span>
            )}
          </div>
          <span className="text-[11.5px] text-muted-ink">
            {cfg?.lastCheckedAt ? `Last checked ${fmtDateTime(cfg.lastCheckedAt)}` : "Not tested yet"}
            {cfg?.connectedAt ? ` · connected ${fmtDateTime(cfg.connectedAt)}` : ""}
          </span>
        </div>

        {status === "error" && cfg?.lastError && (
          <div className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger mt-3">
            Last test failed: {cfg.lastError}
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3 pt-3 border-t border-line">
          {[
            { label: "Credentials", value: configured ? "Saved & encrypted" : cfg?.phoneNumberId ? "Partial — token missing" : "Not entered" },
            { label: "Access token", value: cfg?.hasToken ? `Saved (${cfg.tokenHint || "encrypted"})` : "None" },
            { label: "Webhook", value: verifyToken ? "Verify token ready" : "Generate by saving step 1" },
            { label: "Sender", value: resp?.provider === "tenant" ? "Your number" : resp?.provider === "platform" ? "Platform number" : "Simulated (mock)" },
          ].map((item) => (
            <div key={item.label}>
              <p className="text-[10px] uppercase tracking-wide text-muted-ink font-semibold">{item.label}</p>
              <p className="text-[12.5px] text-pine font-medium mt-0.5 truncate">{item.value}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Step 1 · Meta app credentials ─────────────────────────────── */}
      <div className="panel p-4">
        <div className="flex items-center gap-2.5 mb-3">
          <StepBadge n={1} />
          <p className="panel-title mb-0 flex items-center gap-2"><KeyRound className="h-4 w-4 text-brass" /> Meta app credentials</p>
          {cfg?.hasToken && (
            <span className="badge border-ok/40 bg-ok/10 text-ok text-[10px] py-0 ml-auto">saved · {cfg.tokenHint}</span>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-ink py-6 justify-center"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
        ) : (
          <>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="field-label" htmlFor="wa-display">Display number</label>
                <div className="relative">
                  <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                  <Input id="wa-display" className="field pl-9" placeholder="+91 98200 11223" value={displayPhone}
                    disabled={!isAdmin} onChange={(e) => { setDisplayPhone(e.target.value); setDirty(true); }} />
                </div>
              </div>
              <div>
                <label className="field-label" htmlFor="wa-waba">WhatsApp Business Account ID (WABA)</label>
                <Input id="wa-waba" className="field" placeholder="e.g. 10245789635412" value={wabaId}
                  disabled={!isAdmin} onChange={(e) => { setWabaId(e.target.value); setDirty(true); }} />
              </div>
              <div>
                <label className="field-label" htmlFor="wa-phone-id">Phone Number ID *</label>
                <Input id="wa-phone-id" className="field" placeholder="From WhatsApp → API Setup" value={phoneNumberId}
                  disabled={!isAdmin} onChange={(e) => { setPhoneNumberId(e.target.value); setDirty(true); }} />
              </div>
              <div>
                <label className="field-label" htmlFor="wa-token">
                  Access token {cfg?.hasToken ? <span className="text-ok font-medium">(saved · {cfg.tokenHint})</span> : "*"}
                </label>
                <div className="relative">
                  <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                  <Input
                    id="wa-token"
                    type={showToken ? "text" : "password"}
                    className="field pl-9 pr-9"
                    placeholder={cfg?.hasToken ? `••• saved — leave blank to keep` : "EAAG… system-user token"}
                    value={accessToken}
                    disabled={!isAdmin}
                    onChange={(e) => { setAccessToken(e.target.value); setDirty(true); }}
                    autoComplete="off"
                  />
                  <button type="button" aria-label={showToken ? "Hide token" : "Show token"}
                    onClick={() => setShowToken((v) => !v)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine-700">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
                <p className="text-[11px] text-muted-ink mt-1">Encrypted with AES-256-GCM at rest — never shown in full again.</p>
              </div>
            </div>

            {isAdmin && (
              <div className="flex flex-wrap items-center gap-2 mt-4 pt-3 border-t border-line">
                <Button onClick={() => save()} disabled={busy !== null} className="btn-pine h-9 px-4 gap-1.5 text-[12.5px]">
                  {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} {cfg?.hasToken ? "Save changes" : "Save"}
                </Button>
                {cfg?.hasToken && (
                  <Button onClick={disconnect} disabled={busy !== null} className="btn-ghost h-9 px-4 gap-1.5 text-[12.5px] text-danger hover:bg-danger/5">
                    {busy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />} Disconnect
                  </Button>
                )}
                <span className="text-[11.5px] text-muted-ink ml-auto">
                  {configured ? "Editing any field re-runs verification in step 3" : "Fill at least Phone Number ID + Access token"}
                </span>
              </div>
            )}

            <details className="mt-3 group">
              <summary className="cursor-pointer select-none text-[12px] font-medium text-pine-700 hover:text-brass inline-flex items-center gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                Detailed Meta setup guide <span className="text-muted-ink font-normal">(5 steps)</span>
              </summary>
              <ol className="space-y-3 mt-3">
                {META_GUIDE.map((s, i) => (
                  <li key={s.title} className="flex items-start gap-3">
                    <span className="h-6 w-6 shrink-0 rounded-full bg-plaster-deep text-pine-700 text-[11px] font-semibold flex items-center justify-center mt-0.5">
                      {i + 1}
                    </span>
                    <div>
                      <p className="text-[13px] font-semibold text-pine leading-tight">{s.title}</p>
                      <p className="text-[12px] text-muted-ink mt-0.5 leading-relaxed">{s.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <a
                href="https://business.facebook.com/wa/manage/home/"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[12px] font-medium text-pine-700 hover:text-brass mt-3"
              >
                <ExternalLink className="h-3.5 w-3.5" /> Open Meta Business Manager
              </a>
            </details>
          </>
        )}
      </div>

      {/* ── Step 2 · Webhook pairing ──────────────────────────────────── */}
      <div className="panel p-4">
        <div className="flex items-center gap-2.5 mb-3">
          <StepBadge n={2} />
          <p className="panel-title mb-0 flex items-center gap-2"><Webhook className="h-4 w-4 text-brass" /> Webhook pairing (Meta App dashboard)</p>
          {verifyToken && (
            <span className="badge border-ok/40 bg-ok/10 text-ok text-[10px] py-0 ml-auto">ready</span>
          )}
        </div>
        <div className="grid lg:grid-cols-2 gap-3">
          <div>
            <label className="field-label">Callback URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md border border-line bg-plaster-deep/60 px-2.5 py-2 text-[11.5px] text-pine-700">
                {resp?.webhookUrl || "—"}
              </code>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Copy callback URL" onClick={() => copy("url", resp?.webhookUrl ?? "")}>
                {copied === "url" ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
          <div>
            <label className="field-label">Verify token</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate rounded-md border border-line bg-plaster-deep/60 px-2.5 py-2 text-[11.5px] text-pine-700">
                {verifyToken || "—"}
              </code>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" aria-label="Copy verify token" onClick={() => copy("token", verifyToken)}>
                {copied === "token" ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-[11.5px] text-muted-ink mt-2.5">
          Paste both values under WhatsApp → Configuration, then click “Verify and save”. Subscribe to the <span className="font-semibold text-pine-700">messages</span> field for delivery receipts.
          {isAdmin && !verifyToken && " Save your credentials in step 1 to generate a verify token."}
        </p>
      </div>

      {/* ── Step 3 · Verify & test ────────────────────────────────────── */}
      {isAdmin && (
        <div className="panel p-4">
          <div className="flex items-center gap-2.5 mb-3">
            <StepBadge n={3} />
            <p className="panel-title mb-0 flex items-center gap-2"><PlugZap className="h-4 w-4 text-brass" /> Verify &amp; test</p>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center gap-2">
            <Button onClick={test} disabled={busy !== null} className="btn-pine h-9 px-4 gap-1.5 text-[12.5px] shrink-0">
              {busy === "test" ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />} Test connection
            </Button>
            <p className="text-[11.5px] text-muted-ink">
              {dirty ? "Unsaved changes will be saved first, then verified with Meta." : "Verifies the saved token against the Meta Graph API and flips the hotel to connected."}
            </p>
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-center mt-4 pt-3 border-t border-line">
            <Input className="field sm:max-w-xs" placeholder="+91 98xxx xxxxx" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} aria-label="Test message phone number" />
            <Button onClick={sendTest} disabled={busy !== null} className="btn-outline h-9 px-4 gap-1.5 text-[12.5px] shrink-0">
              {busy === "testMsg" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send test message
            </Button>
            <p className="text-[11.5px] text-muted-ink sm:ml-2">
              Delivers a real WhatsApp text to prove the pipeline end-to-end; simulated and logged when not yet live.
            </p>
          </div>
        </div>
      )}

      {/* ── Step 4 · KOT broadcast ───────────────────────────────────── */}
      {isAdmin && <KotBroadcastCard />}
    </div>
  );
}

/**
 * Step 4 — KOT broadcast settings. Every new POS order (KOT) is WhatsApped to
 * the property owner(s) (auto-picked from admin accounts) plus a tenant-managed
 * group list, as a branded ticket image or plain text.
 */
function KotBroadcastCard() {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [format, setFormat] = useState<"image" | "text">("image");
  const [phonesText, setPhonesText] = useState("");
  const [ownerCount, setOwnerCount] = useState(0);
  const [preview, setPreview] = useState("");

  const load = useCallback(async () => {
    try {
      const r = await api<{
        config: { enabled: boolean; format: "image" | "text"; phones: string[] };
        ownerRecipients: number;
        preview: { text: string };
      }>("/api/whatsapp/kot-broadcast");
      setEnabled(r.config.enabled);
      setFormat(r.config.format);
      setPhonesText(r.config.phones.join("\n"));
      setOwnerCount(r.ownerRecipients);
      setPreview(r.preview.text);
    } catch {
      /* non-fatal — the card still renders with defaults */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const phones = phonesText
        .split("\n")
        .map((p) => p.trim())
        .filter(Boolean);
      const r = await api<{
        config: { enabled: boolean; format: "image" | "text"; phones: string[] };
        ownerRecipients: number;
      }>("/api/whatsapp/kot-broadcast", {
        method: "PUT",
        body: JSON.stringify({ enabled, format, phones }),
      });
      setPhonesText(r.config.phones.join("\n"));
      setOwnerCount(r.ownerRecipients);
      toast({
        title: "KOT broadcast saved",
        description: r.config.enabled
          ? `New KOTs go to ${r.ownerRecipients} owner number${r.ownerRecipients === 1 ? "" : "s"} + ${r.config.phones.length} group number${r.config.phones.length === 1 ? "" : "s"}.`
          : "Broadcast is off — enable it any time.",
      });
    } catch (e) {
      toast({ title: "Could not save KOT broadcast", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const groupCount = phonesText.split("\n").map((p) => p.trim()).filter(Boolean).length;

  return (
    <div className="panel p-4">
      <div className="flex items-center gap-2.5 mb-1">
        <StepBadge n={4} />
        <p className="panel-title mb-0 flex items-center gap-2">
          <ChefHat className="h-4 w-4 text-brass" /> KOT broadcast — kitchen tickets on WhatsApp
        </p>
        <span
          className={cn(
            "badge text-[10px] py-0 ml-auto",
            enabled ? "border-ok/40 bg-ok/10 text-ok" : "border-line-strong bg-plaster text-muted-ink"
          )}
        >
          {enabled ? "On" : "Off"}
        </span>
      </div>
      <p className="text-[12.5px] text-muted-ink mb-3">
        The moment a KOT is generated in the Restaurant POS, the full ticket — items, notes and total — is sent to the owner and your group.
      </p>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[13px] text-muted-ink">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      ) : (
        <div className="space-y-3.5">
          {/* Enable + format */}
          <div className="grid sm:grid-cols-2 gap-3">
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              onClick={() => setEnabled((v) => !v)}
              className={cn(
                "flex items-center justify-between gap-3 rounded-md border px-3.5 py-3 text-left transition",
                enabled ? "border-pine-700/40 bg-pine-700/[.04]" : "border-line-strong bg-panel"
              )}
            >
              <span>
                <span className="block text-[13px] font-semibold text-pine">Broadcast on new KOT</span>
                <span className="block text-[11.5px] text-muted-ink mt-0.5">Sent the instant an order hits the kitchen</span>
              </span>
              <span
                className={cn(
                  "relative h-6 w-11 shrink-0 rounded-full transition",
                  enabled ? "bg-pine-700" : "bg-line-strong"
                )}
                aria-hidden
              >
                <span
                  className={cn(
                    "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all",
                    enabled ? "left-[22px]" : "left-0.5"
                  )}
                />
              </span>
            </button>

            <div>
              <span className="field-label">Ticket format</span>
              <div className="grid grid-cols-2 gap-1 rounded-md border border-line-strong bg-panel p-1">
                {([
                  { key: "image", label: "Ticket image", icon: ImageIcon },
                  { key: "text", label: "Text only", icon: MessageCircle },
                ] as const).map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setFormat(f.key)}
                    aria-pressed={format === f.key}
                    className={cn(
                      "inline-flex items-center justify-center gap-1.5 rounded border py-2 text-[12px] font-medium transition",
                      format === f.key
                        ? "border-pine-700/40 bg-pine-700 text-panel"
                        : "border-transparent text-muted-ink hover:bg-plaster-deep/50"
                    )}
                  >
                    <f.icon className="h-3.5 w-3.5" /> {f.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-ink mt-1">
                {format === "image"
                  ? "Branded ticket image with a text caption — falls back to text if image delivery fails."
                  : "Plain WhatsApp text with bold item lines."}
              </p>
            </div>
          </div>

          {/* Recipients */}
          <div className="grid lg:grid-cols-2 gap-3">
            <div>
              <label className="field-label" htmlFor="kot-phones">
                Group numbers (one per line, max 12)
              </label>
              <textarea
                id="kot-phones"
                className="field min-h-[96px] font-mono text-[12.5px]"
                placeholder={"+91 98200 11223\n+91 98111 22334"}
                value={phonesText}
                onChange={(e) => setPhonesText(e.target.value)}
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-ink mt-1">
                {groupCount} group number{groupCount === 1 ? "" : "s"} · plus {ownerCount} owner number
                {ownerCount === 1 ? "" : "s"} picked up automatically from admin accounts.
              </p>
            </div>
            <div>
              <span className="field-label">Message preview (text format)</span>
              <pre className="max-h-[96px] overflow-y-auto scroll-slim whitespace-pre-wrap rounded-md border border-line bg-plaster-deep/40 px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-pine">
                {preview || "—"}
              </pre>
              <p className="text-[11px] text-muted-ink mt-1">Every send is logged in Messages — delivery status per number.</p>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={save} disabled={busy} className="btn-pine h-9 px-4 gap-1.5 text-[12.5px]">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Save KOT broadcast
            </Button>
            <span className="text-[11.5px] text-muted-ink">Applies from the next order — nothing is retro-sent.</span>
          </div>
        </div>
      )}
    </div>
  );
}
