"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, X, RefreshCw, Loader2, Link2, Link2Off, Settings2, ListChecks,
  AlertTriangle, Clock, Lock, Eye, EyeOff, ShieldCheck, ArrowRight, ScrollText,
  Wifi, ExternalLink, Info, Search, Send, Calendar, Webhook, KeyRound, Copy,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { validateCredentialFields } from "@/lib/channel-adapters";

/* ─── Types (mirrors GET /api/channels — now includes the normalized specs) ── */

interface CredentialFieldSpec {
  key: string; label: string; placeholder: string; required: boolean;
  help?: string; secret?: boolean; inputMode?: "text" | "numeric";
  minLength?: number; numeric?: boolean; pattern?: string; patternHint?: string;
}
type LinkMethod = "api_keys" | "oauth2" | "ical";
interface LinkMethodDef {
  method: LinkMethod; label: string; badge?: string; blurb: string;
  fields: CredentialFieldSpec[]; steps?: string[]; scopes?: string[]; oauthNote?: string;
}
interface ChannelDef {
  key: string; name: string; blurb: string; iconBg: string; monogram: string;
  category: "global" | "india" | "direct"; popular?: boolean;
  portalUrl?: string; portalLabel?: string;
  credentialFields: CredentialFieldSpec[];
  linkMethods: LinkMethodDef[];
  catalog: { id: string; label: string }[];
}
interface ConnectionInfo {
  id: string; status: string; isActive: boolean; lastSyncedAt: string | null;
  linkMethod: LinkMethod; icalUrl: string | null; webhookUrl: string | null;
  mappedRoomTypes: number; queue: { pending: number; failed: number };
}
interface ChannelEntry extends ChannelDef {
  connected: boolean;
  connection: ConnectionInfo | null;
}
interface OtaSlots {
  used: number; limit: number; remaining: number | null;
  canConnect: boolean; planName: string | null;
}
interface RoomTypeLite { id: string; name: string; code: string }
interface ChannelsPayload { channels: ChannelEntry[]; roomTypes: RoomTypeLite[]; otaChannels?: OtaSlots }

interface LogItem {
  id: string; channel: string; action: string; status: string; message: string;
  attemptedAt: string; date: string | null; roomTypeName: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  booking_com: "Booking.com", expedia: "Expedia", mmt: "MakeMyTrip",
  goibibo: "Goibibo", yatra: "Yatra", agoda: "Agoda", easemytrip: "EasyMyTrip",
  cleartrip: "Cleartrip", airbnb: "Airbnb", oyo: "OYO", own_website: "Own Website",
};

const CATEGORY_LABEL: Record<string, string> = {
  global: "Global OTA", india: "India OTA", direct: "Direct",
};

const METHOD_LABEL: Record<LinkMethod, string> = {
  api_keys: "API Keys", oauth2: "OAuth 2.0", ical: "iCal",
};
const METHOD_ICON: Record<LinkMethod, typeof KeyRound> = {
  api_keys: KeyRound, oauth2: ShieldCheck, ical: Calendar,
};

/** Clipboard with a legacy fallback — used by the Link URLs dialog. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

const timeAgo = (iso: string | null): string => {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* ─── Shared 3-step onboarding stepper ───────────────────────────────────── */

function Stepper({ step }: { step: 1 | 2 }) {
  const steps = ["Connect", "Map rooms", "Go live"];
  return (
    <div className="flex items-center gap-1" aria-label={`Step ${step} of 3 — ${steps[step - 1]}`}>
      {steps.map((s, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <div key={s} className="flex items-center gap-1">
            {i > 0 && <span className={cn("h-px w-3.5", done || active ? "bg-brass" : "bg-line-strong")} aria-hidden />}
            <span
              className={cn(
                "h-[18px] w-[18px] rounded-full flex items-center justify-center text-[9.5px] font-bold border shrink-0",
                done
                  ? "bg-ok/15 border-ok/40 text-ok"
                  : active
                    ? "bg-brass/15 border-brass text-brass"
                    : "bg-plaster border-line-strong text-muted-ink",
              )}
            >
              {done ? <Check className="h-2.5 w-2.5" /> : n}
            </span>
            <span className={cn("text-[10.5px] whitespace-nowrap", active ? "text-pine font-semibold" : "text-muted-ink")}>{s}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ─── Main view ───────────────────────────────────────────────────────────── */

export default function ChannelsView() {
  const { user } = useSession();
  const { toast } = useToast();
  const isAdmin = user?.role === "hotel_admin";

  const [data, setData] = useState<ChannelsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"connections" | "sync-log">("connections");
  const [cat, setCat] = useState<"all" | "global" | "india" | "direct">("all");
  const [query, setQuery] = useState("");

  const [connectTarget, setConnectTarget] = useState<ChannelEntry | null>(null);
  const [mapTarget, setMapTarget] = useState<ChannelEntry | null>(null);
  const [urlsTarget, setUrlsTarget] = useState<ChannelEntry | null>(null);

  const load = useCallback(async (spinner = false) => {
    if (spinner) setLoading(true);
    try {
      setData(await api<ChannelsPayload>("/api/channels"));
    } catch (e) {
      if (spinner) toast({ title: "Could not load channels", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      if (spinner) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(true); }, [load]);

  const connectedCount = data?.channels.filter((c) => c.connected && c.connection?.status === "connected").length ?? 0;
  const activeCount = data?.channels.filter((c) => c.connected && c.connection?.isActive && c.connection?.status === "connected").length ?? 0;
  const ota = data?.otaChannels;

  const visibleChannels = useMemo(() => {
    if (!data) return [];
    const list = [...data.channels].sort((a, b) => Number(!!b.popular) - Number(!!a.popular));
    const q = query.trim().toLowerCase();
    return list.filter(
      (c) =>
        (cat === "all" || c.category === cat) &&
        (q === "" || `${c.name} ${c.blurb}`.toLowerCase().includes(q)),
    );
  }, [data, cat, query]);

  if (loading && !data) {
    return (
      <div className="panel p-10 flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-brass" />
        <p className="text-sm text-muted-ink">Loading channel connections…</p>
      </div>
    );
  }
  if (!data) return null;

  const slotExhausted = !!ota && !ota.canConnect;

  return (
    <div className="space-y-4">
      {/* Header strip */}
      <div className="panel px-4 py-3 flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2.5">
          <span className="h-9 w-9 rounded-md bg-pine-100/70 flex items-center justify-center">
            <Wifi className="h-4.5 w-4.5 text-pine-700" />
          </span>
          <div className="leading-tight">
            <p className="text-[13px] font-semibold text-pine">{connectedCount} of {data.channels.length} channels connected</p>
            <p className="text-[11px] text-muted-ink">{activeCount} actively receiving inventory pushes</p>
          </div>
        </div>
        <div className="h-8 w-px bg-line hidden sm:block" />
        <p className="text-[11.5px] text-muted-ink max-w-xl leading-snug">
          One control room for every OTA and your own website — link with API keys, the new OAuth 2.0 standard or
          universal iCal calendars, map room types once, then open, close and re-price everywhere from
          <span className="font-medium text-pine"> Inventory Control</span>. Secrets are encrypted at rest and never leave the server.
        </p>

        {ota && ota.limit >= 0 && (
          <span
            className={cn(
              "badge",
              slotExhausted
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-line-strong bg-plaster text-muted-ink",
            )}
            title={slotExhausted ? "Plan limit reached — upgrade or add the OTA add-on to connect more channels" : "OTA channels allowed by your plan"}
          >
            <Lock className="h-3 w-3" />
            {ota.used}/{ota.limit} OTA slots{ota.planName ? ` · ${ota.planName}` : ""}
          </span>
        )}

        <div className="ml-auto inline-flex rounded-md border border-line-strong bg-plaster/60 p-0.5" role="tablist" aria-label="Channels sections">
          <button
            role="tab" aria-selected={tab === "connections"} onClick={() => setTab("connections")}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
              tab === "connections" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine",
            )}
          >
            <Link2 className="h-3.5 w-3.5" /> Connections
          </button>
          <button
            role="tab" aria-selected={tab === "sync-log"} onClick={() => setTab("sync-log")}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
              tab === "sync-log" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine",
            )}
          >
            <ScrollText className="h-3.5 w-3.5" /> Sync Log
          </button>
        </div>
      </div>

      {tab === "connections" && (
        <>
          {/* Filter strip */}
          <div className="panel px-4 py-2.5 flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-line-strong bg-plaster/60 p-0.5" role="group" aria-label="Filter by category">
              {([
                ["all", "All"],
                ["global", "Global OTAs"],
                ["india", "India OTAs"],
                ["direct", "Direct"],
              ] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setCat(k)}
                  aria-pressed={cat === k}
                  className={cn(
                    "h-7 px-2.5 rounded-[5px] text-[12px] font-medium transition",
                    cat === k ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="relative ml-auto w-full sm:w-56">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" aria-hidden />
              <input
                className="field h-8 pl-8 text-[12px]"
                placeholder="Search channels…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search channels"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visibleChannels.map((ch) => (
              <ChannelCard
                key={ch.key}
                ch={ch}
                isAdmin={isAdmin}
                slotExhausted={slotExhausted}
                slots={ota ?? null}
                onConnect={() => setConnectTarget(ch)}
                onManage={() => setMapTarget(ch)}
                onShowUrls={() => setUrlsTarget(ch)}
                onChanged={() => load(false)}
              />
            ))}
          </div>

          {visibleChannels.length === 0 && (
            <div className="panel px-4 py-10 text-center">
              <Settings2 className="h-8 w-8 text-line-strong mx-auto mb-2" />
              <p className="text-sm text-muted-ink">No channels match “{query || cat}”.</p>
            </div>
          )}
        </>
      )}

      {tab === "sync-log" && <SyncLogView />}

      {/* Connect dialog */}
      {connectTarget && (
        <ConnectDialog
          channel={connectTarget}
          onClose={() => setConnectTarget(null)}
          onConnected={async () => {
            setConnectTarget(null);
            await load(false);
            const fresh = await api<ChannelsPayload>("/api/channels");
            const updated = fresh.channels.find((c) => c.key === connectTarget.key);
            if (updated) setMapTarget(updated);
          }}
        />
      )}

      {/* Mapping dialog */}
      {mapTarget && mapTarget.connection && (
        <MappingDialog
          channel={mapTarget}
          roomTypes={data.roomTypes}
          onClose={() => setMapTarget(null)}
          onSaved={() => { setMapTarget(null); load(false); }}
        />
      )}

      {/* Link URLs dialog — outbound iCal feed + inbound webhook */}
      {urlsTarget && urlsTarget.connection && (
        <LinkUrlsDialog channel={urlsTarget} onClose={() => setUrlsTarget(null)} />
      )}
    </div>
  );
}

/* ─── Channel card ───────────────────────────────────────────────────────── */

function ChannelCard({
  ch, isAdmin, slotExhausted, slots, onConnect, onManage, onShowUrls, onChanged,
}: {
  ch: ChannelEntry;
  isAdmin: boolean;
  slotExhausted: boolean;
  slots: OtaSlots | null;
  onConnect: () => void;
  onManage: () => void;
  onShowUrls: () => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const conn = ch.connection;
  const status = conn?.status ?? "disconnected";
  const paused = conn ? !conn.isActive : false;

  const act = async (label: string, fn: () => Promise<string | void>, successMsg?: string) => {
    setBusy(label);
    try {
      const detail = await fn();
      toast({ title: successMsg ?? label, description: detail || undefined });
      onChanged();
    } catch (e) {
      toast({ title: `${label} failed`, description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  const statusBadge = (() => {
    if (!conn) return <span className="badge border-line-strong bg-plaster text-muted-ink"><Link2Off className="h-3 w-3" /> Not connected</span>;
    if (status === "connected" && paused) return <span className="badge border-warn/40 bg-warn/10 text-warn"><EyeOff className="h-3 w-3" /> Paused</span>;
    if (status === "connected") return <span className="badge border-ok/40 bg-ok/10 text-ok"><span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ok opacity-60" /><span className="relative inline-flex rounded-full h-2 w-2 bg-ok" /></span> Connected</span>;
    if (status === "error") return <span className="badge border-danger/40 bg-danger/10 text-danger"><AlertTriangle className="h-3 w-3" /> Error</span>;
    return <span className="badge border-line-strong bg-plaster text-muted-ink"><Link2Off className="h-3 w-3" /> Disconnected</span>;
  })();

  const upgradeHint = () => {
    toast({
      title: "OTA channel slots used up",
      description: `${slots?.used ?? 0} of ${slots?.limit ?? 0} channels are connected on ${slots?.planName ?? "your plan"}. Upgrade your plan or add the OTA add-on from My Subscription to connect more.`,
    });
  };

  return (
    <div className={cn("panel flex flex-col", status === "connected" && !paused && "border-ok/30")}>
      <div className="panel-header">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="h-9 w-9 rounded-md flex items-center justify-center text-panel text-[13px] font-bold shrink-0"
            style={{ backgroundColor: ch.iconBg }}
            aria-hidden
          >
            {ch.monogram}
          </span>
          <div className="min-w-0">
            <p className="font-display font-semibold text-pine text-[15px] leading-tight truncate flex items-center gap-1.5">
              {ch.name}
              {ch.popular && (
                <span className="badge border-brass/40 bg-brass/10 text-brass text-[9px] px-1.5 py-0 shrink-0">Popular</span>
              )}
            </p>
            <p className="text-[10.5px] text-muted-ink truncate">
              {CATEGORY_LABEL[ch.category] ?? ch.category} · {ch.blurb}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {statusBadge}
          {conn && (
            <span className="badge border-line-strong bg-plaster text-muted-ink text-[9px] px-1.5 py-0 gap-1" title={`Linked via ${METHOD_LABEL[conn.linkMethod]}`}>
              {(() => {
                const MI = METHOD_ICON[conn.linkMethod] ?? KeyRound;
                return <MI className="h-2.5 w-2.5" />;
              })()}
              {METHOD_LABEL[conn.linkMethod] ?? conn.linkMethod}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-2.5 flex-1">
        {conn ? (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <MiniStat label="Mapped" value={`${conn.mappedRoomTypes}`} />
              <MiniStat label="Queue" value={conn.queue.pending > 0 ? `${conn.queue.pending}` : "0"} warn={conn.queue.pending > 0} />
              <MiniStat label="Failed" value={`${conn.queue.failed}`} danger={conn.queue.failed > 0} />
            </div>
            <p className="text-[11px] text-muted-ink flex items-center gap-1.5">
              <Clock className="h-3 w-3" /> Last sync: {timeAgo(conn.lastSyncedAt)}
            </p>
            {conn.queue.failed > 0 && (
              <p className="text-[11px] text-danger flex items-center gap-1.5">
                <AlertTriangle className="h-3 w-3" /> {conn.queue.failed} push{conn.queue.failed === 1 ? "" : "es"} failed — retry from the grid or re-sync
              </p>
            )}
          </>
        ) : (
          <p className="text-[12px] text-muted-ink leading-relaxed">
            Connect once, map your room types, and this channel receives every availability and rate
            change automatically. No more extranet logins.
          </p>
        )}
      </div>

      <div className="border-t border-line px-4 py-3 flex flex-wrap items-center gap-2">
        {!conn ? (
          slotExhausted && ch.key !== "own_website" ? (
            <button className="btn-outline h-8 text-[12px] flex-1" onClick={upgradeHint} disabled={!isAdmin}>
              <Lock className="h-3.5 w-3.5" /> Upgrade to connect
            </button>
          ) : (
            <button className="btn-pine h-8 text-[12px] flex-1" onClick={onConnect} disabled={!isAdmin}
              title={isAdmin ? "" : "Only the hotel admin can connect channels"}>
              <Link2 className="h-3.5 w-3.5" /> {ch.key === "own_website" ? "Enable" : "Connect"}
            </button>
          )
        ) : (
          <>
            <button
              className="btn-pine h-8 text-[12px]"
              disabled={busy !== null || !isAdmin || status !== "connected" || paused || conn.mappedRoomTypes === 0}
              title={conn.mappedRoomTypes === 0 ? "Map room types first" : paused ? "Channel is paused" : ""}
              onClick={() => act(
                "Sync now",
                async () => {
                  const res = await api<{ message: string }>(`/api/channels/${conn.id}/sync`, { method: "POST" });
                  return res.message;
                },
                "Full sync queued",
              )}
            >
              {busy === "Sync now" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync Now
            </button>
            <button className="btn-outline h-8 text-[12px]" onClick={onManage} disabled={!isAdmin}>
              <ListChecks className="h-3.5 w-3.5" /> Map ({conn.mappedRoomTypes})
            </button>
            <button
              className="btn-outline h-8 text-[12px]"
              onClick={onShowUrls}
              disabled={!isAdmin}
              title="Your iCal calendar feed and webhook endpoint URLs"
            >
              <Webhook className="h-3.5 w-3.5" /> URLs
            </button>
            <button
              className="btn-ghost h-8 px-2 text-[12px]"
              disabled={busy !== null || !isAdmin}
              onClick={() => act("Pause", () => api(`/api/channels/${conn.id}`, { method: "PATCH", body: JSON.stringify({ isActive: false }) }), `${ch.name} paused — it stays connected`)}
              title="Pause pushes without disconnecting"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
            <button
              className="btn-ghost h-8 px-2 text-danger hover:bg-danger/10"
              disabled={busy !== null || !isAdmin}
              onClick={() => act("Disconnect", () => api(`/api/channels/${conn.id}`, { method: "DELETE" }), `${ch.name} disconnected`)}
              title="Disconnect and remove mapping"
            >
              <Link2Off className="h-3.5 w-3.5" />
            </button>
            {paused && (
              <button
                className="btn-brass h-8 text-[12px] w-full"
                disabled={busy !== null || !isAdmin}
                onClick={() => act("Resume", () => api(`/api/channels/${conn.id}`, { method: "PATCH", body: JSON.stringify({ isActive: true }) }), `${ch.name} resumed — pushes flow again`)}
              >
                <Eye className="h-3.5 w-3.5" /> Resume pushes
              </button>
            )}
            {status === "error" && (
              <button
                className="btn-brass h-8 text-[12px] w-full"
                disabled={busy !== null || !isAdmin}
                onClick={() => act("Reconnect", () => api(`/api/channels/${conn.id}`, { method: "PATCH", body: JSON.stringify({ action: "reconnect" }) }), `${ch.name} re-connected`)}
              >
                <ShieldCheck className="h-3.5 w-3.5" /> Reconnect
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function MiniStat({ label, value, warn, danger }: { label: string; value: string; warn?: boolean; danger?: boolean }) {
  return (
    <div className="rounded-md bg-plaster/60 border border-line px-2 py-1.5">
      <p className={cn("font-display font-semibold text-[15px] leading-none", danger ? "text-danger" : warn ? "text-warn" : "text-pine")}>{value}</p>
      <p className="text-[9.5px] uppercase tracking-wider text-muted-ink mt-0.5">{label}</p>
    </div>
  );
}

/* ─── Connect dialog (Step 1 — link method selector + normalized form) ────── */

function ConnectDialog({ channel, onClose, onConnected }: { channel: ChannelEntry; onClose: () => void; onConnected: () => void }) {
  const { toast } = useToast();
  const methods = channel.linkMethods ?? [];
  const [method, setMethod] = useState<LinkMethod>(methods[0]?.method ?? "api_keys");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const methodDef = useMemo(
    () => methods.find((m) => m.method === method) ?? null,
    [methods, method],
  );

  const noKeys = !methodDef || methodDef.fields.length === 0;
  const liveErrors = useMemo(
    () => (noKeys ? {} : validateCredentialFields(methodDef.fields, creds)),
    [methodDef, creds, noKeys],
  );
  const canSubmit = noKeys || Object.keys(liveErrors).length === 0;

  const switchMethod = (m: LinkMethod) => {
    setMethod(m);
    setTouched({});
    setErrors({});
    setServerError(null);
  };

  const submit = async () => {
    setServerError(null);
    if (!noKeys && methodDef) {
      const clientErrors = validateCredentialFields(methodDef.fields, creds);
      setErrors(clientErrors);
      if (Object.keys(clientErrors).length > 0) return;
    }
    setBusy(true);
    try {
      const res = await api<{ message: string }>("/api/channels", {
        method: "POST",
        body: JSON.stringify({ channel: channel.key, method, credentials: creds }),
      });
      toast({ title: `${channel.name} connected via ${METHOD_LABEL[method]}`, description: res.message });
      onConnected();
    } catch (e) {
      const err = e as Error & { body?: { fieldErrors?: Record<string, string> } };
      if (err.body?.fieldErrors) setErrors(err.body.fieldErrors);
      setServerError(err.message || "Connection failed");
    } finally {
      setBusy(false);
    }
  };

  const MethodIcon = METHOD_ICON[method];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label={`Connect ${channel.name}`}>
      <div className="absolute inset-0 bg-pine/50" onClick={busy ? undefined : onClose} />
      <div className="relative panel border-line-strong w-full max-w-md max-h-[88vh] overflow-y-auto scroll-slim expand-in">
        <div className="panel-header">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-md flex items-center justify-center text-panel text-[12px] font-bold" style={{ backgroundColor: channel.iconBg }}>
              {channel.monogram}
            </span>
            <div>
              <p className="panel-title">Connect {channel.name}</p>
              <p className="text-[11px] text-muted-ink">
                {noKeys ? "One click — no keys needed" : `${METHOD_LABEL[method]} link · encrypted at rest`}
              </p>
            </div>
          </div>
          <button className="btn-ghost px-1.5 h-6" onClick={onClose} disabled={busy} aria-label="Close"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="px-4 pt-2.5 pb-1 border-b border-line">
          <Stepper step={1} />
        </div>

        <div className="px-4 py-4 space-y-3.5">
          {noKeys ? (
            <div className="rounded-md border border-ok/30 bg-ok/10 px-3 py-2.5 text-[12.5px] text-ok flex items-start gap-2">
              <Check className="h-4 w-4 mt-0.5 shrink-0" />
              <span>The Velurex booking engine is part of your subscription — no keys needed. Connecting it links the hosted /book page and embeddable widget to unified inventory instantly (room types auto-map in the next step).</span>
            </div>
          ) : (
            <>
              {/* Link technology selector */}
              {methods.length > 1 && (
                <div>
                  <p className="field-label mb-1.5">How do you want to link {channel.name}?</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5" role="radiogroup" aria-label="Link method">
                    {methods.map((m) => {
                      const Icon = METHOD_ICON[m.method];
                      const active = m.method === method;
                      return (
                        <button
                          key={m.method}
                          role="radio"
                          aria-checked={active}
                          onClick={() => switchMethod(m.method)}
                          className={cn(
                            "text-left rounded-md border px-2.5 py-2 transition",
                            active
                              ? "border-brass bg-brass/10 ring-1 ring-brass/40"
                              : "border-line-strong bg-plaster/50 hover:border-brass/50",
                          )}
                        >
                          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-pine">
                            <Icon className={cn("h-3.5 w-3.5", active ? "text-brass" : "text-muted-ink")} />
                            {m.label}
                            {m.badge && (
                              <span className={cn("badge text-[8.5px] px-1 py-0 shrink-0", active ? "border-brass/40 bg-brass/15 text-brass" : "border-line-strong bg-plaster text-muted-ink")}>{m.badge}</span>
                            )}
                          </span>
                          <span className="block text-[10px] text-muted-ink leading-snug mt-0.5 line-clamp-2">{m.blurb}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* iCal guided steps */}
              {methodDef?.method === "ical" && methodDef.steps && (
                <ol className="rounded-md border border-line bg-plaster/50 px-3 py-2.5 space-y-1.5 list-none">
                  {methodDef.steps.map((s, i) => (
                    <li key={i} className="flex items-start gap-2 text-[11.5px] text-muted-ink leading-snug">
                      <span className="h-4 w-4 mt-px rounded-full bg-pine-700 text-panel text-[9px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                      <span>{s}</span>
                    </li>
                  ))}
                  <li className="flex items-start gap-2 text-[11px] text-ok pt-1 border-t border-line">
                    <Calendar className="h-3.5 w-3.5 mt-px shrink-0" />
                    <span>Your Velurex calendar URL appears on the channel card right after connecting — no approvals, no waitlists.</span>
                  </li>
                </ol>
              )}

              {/* OAuth scopes preview */}
              {methodDef?.method === "oauth2" && methodDef.scopes && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[10.5px] text-muted-ink">Requested scopes:</span>
                  {methodDef.scopes.map((s) => (
                    <span key={s} className="badge border-pine-700/30 bg-pine-100/70 text-pine-700 text-[9.5px] px-1.5 py-0 font-mono">{s}</span>
                  ))}
                </div>
              )}

              {channel.portalUrl && (
                <a
                  href={channel.portalUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-[11.5px] font-medium text-brass hover:text-pine transition underline underline-offset-2 decoration-brass/40"
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  Open {channel.portalLabel ?? channel.name} to get your {methodDef.method === "ical" ? "calendar URL" : methodDef.method === "oauth2" ? "client credentials" : "credentials"} — new tab
                </a>
              )}

              {methodDef.fields.map((f) => {
                const isSecret = !!f.secret;
                const shown = showSecrets[f.key] ?? false;
                const err = touched[f.key] ? errors[f.key] : undefined;
                return (
                  <div key={f.key}>
                    <label className="field-label" htmlFor={`cred-${f.key}`}>{f.label}{f.required && " *"}</label>
                    <div className="relative">
                      <input
                        id={`cred-${f.key}`}
                        type={isSecret && !shown ? "password" : "text"}
                        inputMode={f.inputMode ?? "text"}
                        className={cn("field pr-9 font-mono text-[12.5px]", err && "border-danger/60 focus:border-danger")}
                        placeholder={f.placeholder}
                        value={creds[f.key] ?? ""}
                        onChange={(e) => {
                          setCreds((c) => ({ ...c, [f.key]: e.target.value }));
                          setServerError(null);
                        }}
                        onBlur={() => {
                          setTouched((t) => ({ ...t, [f.key]: true }));
                          setErrors((prev) => ({ ...prev, [f.key]: liveErrors[f.key] ?? "" }));
                        }}
                        autoComplete="off"
                        aria-invalid={!!err}
                        aria-describedby={err ? `cred-err-${f.key}` : undefined}
                      />
                      {isSecret && (
                        <button
                          type="button"
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine transition"
                          onClick={() => setShowSecrets((s) => ({ ...s, [f.key]: !shown }))}
                          aria-label={shown ? `Hide ${f.label}` : `Show ${f.label}`}
                        >
                          {shown ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      )}
                    </div>
                    {err ? (
                      <p id={`cred-err-${f.key}`} className="mt-1 text-[11px] text-danger flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3 shrink-0" /> {err}
                      </p>
                    ) : f.help ? (
                      <p className="mt-1 text-[10.5px] text-muted-ink leading-snug">{f.help}</p>
                    ) : null}
                  </div>
                );
              })}

              {methodDef?.method === "oauth2" && methodDef.oauthNote && (
                <p className="text-[11px] text-muted-ink flex items-start gap-1.5 bg-pine-100/40 border border-line rounded-md px-2.5 py-2">
                  <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0 text-brass" />
                  <span>{methodDef.oauthNote}</span>
                </p>
              )}
            </>
          )}

          {serverError && (
            <div role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[12px] text-danger flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>{serverError}</span>
            </div>
          )}

          <p className="text-[11px] text-muted-ink flex items-start gap-1.5 bg-plaster/60 border border-line rounded-md px-2.5 py-2">
            <Info className="h-3 w-3 mt-0.5 shrink-0 text-brass" />
            <span>
              <span className="font-medium text-pine">Sandbox handshake:</span> the format is validated against a mock channel
              API today — live OTA verification switches on when your channel manager goes live. Secrets are AES-256-GCM
              encrypted per tenant and used only server-side; after connecting you also get a webhook URL + (for iCal)
              your calendar feed on the card.
            </span>
          </p>
        </div>

        <div className="border-t border-line px-4 py-3 flex justify-end gap-2 sticky bottom-0 bg-panel">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={busy || !canSubmit} title={canSubmit ? "" : "Fill every required field in a valid format"}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <MethodIcon className="h-4 w-4" />}
            {busy
              ? "Handshaking…"
              : noKeys
                ? "Enable Booking Engine"
                : method === "oauth2" ? "Authorize & Connect" : method === "ical" ? "Link Calendars" : "Test & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Link URLs dialog (outbound iCal feed + inbound webhook) ─────────────── */

function LinkUrlsDialog({ channel, onClose }: { channel: ChannelEntry; onClose: () => void }) {
  const { toast } = useToast();
  const conn = channel.connection;
  const [testing, setTesting] = useState(false);

  if (!conn) return null;
  const isIcal = conn.linkMethod === "ical";

  const copy = async (url: string, what: string) => {
    const ok = await copyText(url);
    toast({
      title: ok ? `${what} copied` : "Copy failed",
      description: ok ? "Paste it into the extranet field — keep the full URL including the token." : "Select the URL manually and copy it.",
      variant: ok ? undefined : "destructive",
    });
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const res = await api<{ message: string }>(`/api/channels/${conn.id}/webhook-test`, { method: "POST" });
      toast({ title: "Test event delivered", description: res.message });
    } catch (e) {
      toast({ title: "Test failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  const events = ["booking.created", "booking.updated", "booking.cancelled"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label={`Link URLs for ${channel.name}`}>
      <div className="absolute inset-0 bg-pine/50" onClick={onClose} />
      <div className="relative panel border-line-strong w-full max-w-lg max-h-[88vh] overflow-y-auto scroll-slim expand-in">
        <div className="panel-header">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-md flex items-center justify-center text-panel text-[12px] font-bold" style={{ backgroundColor: channel.iconBg }}>
              {channel.monogram}
            </span>
            <div>
              <p className="panel-title">Link URLs — {channel.name}</p>
              <p className="text-[11px] text-muted-ink flex items-center gap-1">
                Linked via {METHOD_LABEL[conn.linkMethod]}
                <span className="badge border-line-strong bg-plaster text-muted-ink text-[9px] px-1.5 py-0">{METHOD_LABEL[conn.linkMethod]}</span>
              </p>
            </div>
          </div>
          <button className="btn-ghost px-1.5 h-6" onClick={onClose} aria-label="Close"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="px-4 py-4 space-y-4">
          {/* Outbound iCal feed */}
          <div className={cn("rounded-md border px-3 py-3", isIcal ? "border-brass/40 bg-brass/5" : "border-line bg-plaster/40")}>
            <div className="flex items-center gap-2 mb-1">
              <Calendar className={cn("h-4 w-4", isIcal ? "text-brass" : "text-muted-ink")} />
              <p className="text-[12.5px] font-semibold text-pine">Your Velurex calendar URL <span className="font-normal text-muted-ink">(outbound feed)</span></p>
              {isIcal && <span className="badge border-brass/40 bg-brass/10 text-brass text-[9px] px-1.5 py-0">Active for this link</span>}
            </div>
            <p className="text-[11px] text-muted-ink leading-snug mb-2">
              {isIcal
                ? `Paste this into ${channel.name}'s extranet → Calendar → "Import URL". Their system pulls it and your Velurex bookings appear on their calendar.`
                : "Every connection gets a live iCal feed — handy as a universal fallback if you ever need calendar-based sync."}
            </p>
            {conn.icalUrl ? (
              <div className="flex items-center gap-1.5">
                <input readOnly value={conn.icalUrl} onFocus={(e) => e.currentTarget.select()} className="field h-8 font-mono text-[11px] flex-1" aria-label="Velurex iCal export URL" />
                <button className="btn-outline h-8 px-2.5 text-[11.5px] shrink-0" onClick={() => copy(conn.icalUrl!, "Calendar URL")}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              </div>
            ) : (
              <p className="text-[11px] text-muted-ink">Not available for this connection.</p>
            )}
          </div>

          {/* Inbound webhook */}
          <div className="rounded-md border border-line bg-plaster/40 px-3 py-3">
            <div className="flex items-center gap-2 mb-1">
              <Webhook className="h-4 w-4 text-muted-ink" />
              <p className="text-[12.5px] font-semibold text-pine">Webhook endpoint <span className="font-normal text-muted-ink">(inbound events)</span></p>
            </div>
            <p className="text-[11px] text-muted-ink leading-snug mb-2">
              {channel.name} (or your integration partner) can POST booking events here — new, modified and cancelled
              bookings land instantly and show up in the Sync Log.
            </p>
            {conn.webhookUrl ? (
              <>
                <div className="flex items-center gap-1.5">
                  <input readOnly value={conn.webhookUrl} onFocus={(e) => e.currentTarget.select()} className="field h-8 font-mono text-[11px] flex-1" aria-label="Webhook endpoint URL" />
                  <button className="btn-outline h-8 px-2.5 text-[11.5px] shrink-0" onClick={() => copy(conn.webhookUrl!, "Webhook URL")}>
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 mt-2">
                  <span className="text-[10.5px] text-muted-ink">Accepted events:</span>
                  {events.map((ev) => (
                    <span key={ev} className="badge border-line-strong bg-plaster text-muted-ink text-[9.5px] px-1.5 py-0 font-mono">{ev}</span>
                  ))}
                </div>
                <button className="btn-outline h-8 text-[12px] mt-2.5" onClick={sendTest} disabled={testing}>
                  {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                  Send test event
                </button>
              </>
            ) : (
              <p className="text-[11px] text-muted-ink">Not available for this connection.</p>
            )}
          </div>

          <p className="text-[11px] text-muted-ink flex items-start gap-1.5">
            <ShieldCheck className="h-3 w-3 mt-0.5 shrink-0 text-ok" />
            <span>Both URLs carry a private per-connection token — anyone who has them can read your booking dates, so treat them like passwords. Disconnecting rotates access.</span>
          </p>
        </div>

        <div className="border-t border-line px-4 py-3 flex justify-end sticky bottom-0 bg-panel">
          <button className="btn-pine" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Mapping dialog (Step 2 — room type mapping, all channels) ──────────── */

function MappingDialog({
  channel, roomTypes, onClose, onSaved,
}: {
  channel: ChannelEntry;
  roomTypes: RoomTypeLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Record<string, string>>({});
  const connId = channel.connection?.id ?? "";

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const res = await api<{ mapping: { roomTypeId: string; externalRoomTypeId: string }[] }>(`/api/channels/${connId}/mappings`);
        const initial: Record<string, string> = {};
        for (const rt of roomTypes) initial[rt.id] = res.mapping.find((m) => m.roomTypeId === rt.id)?.externalRoomTypeId ?? "";
        setRows(initial);
      } catch (e) {
        toast({ title: "Could not load mapping", description: e instanceof Error ? e.message : "", variant: "destructive" });
      } finally {
        setLoading(false);
      }
    })();
  }, [connId, roomTypes, toast]);

  const mapped = useMemo(() => Object.values(rows).filter(Boolean).length, [rows]);

  const save = async (syncNow: boolean) => {
    setSaving(true);
    try {
      await api(`/api/channels/${connId}/mappings`, {
        method: "PUT",
        body: JSON.stringify({ mappings: roomTypes.map((rt) => ({ roomTypeId: rt.id, externalRoomTypeId: rows[rt.id] ?? "" })) }),
      });
      if (syncNow) {
        try {
          const res = await api<{ message: string }>(`/api/channels/${connId}/sync`, { method: "POST" });
          toast({ title: `Mapping saved — first sync queued for ${channel.name}`, description: res.message });
        } catch (e) {
          toast({
            title: "Mapping saved, but the first sync could not start",
            description: e instanceof Error ? e.message : "",
            variant: "destructive",
          });
        }
      } else {
        toast({ title: "Mapping saved", description: `${mapped} room type${mapped === 1 ? "" : "s"} mapped to ${channel.name}.` });
      }
      onSaved();
    } catch (e) {
      toast({ title: "Save failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label={`Map room types for ${channel.name}`}>
      <div className="absolute inset-0 bg-pine/50" onClick={saving ? undefined : onClose} />
      <div className="relative panel border-line-strong w-full max-w-lg max-h-[85vh] flex flex-col expand-in">
        <div className="panel-header">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-md flex items-center justify-center text-panel text-[12px] font-bold" style={{ backgroundColor: channel.iconBg }}>
              {channel.monogram}
            </span>
            <div>
              <p className="panel-title">Room type mapping — {channel.name}</p>
              <p className="text-[11px] text-muted-ink">{mapped} of {roomTypes.length} mapped · OTAs use their own ids</p>
            </div>
          </div>
          <button className="btn-ghost px-1.5 h-6" onClick={onClose} disabled={saving} aria-label="Close"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="px-4 py-2 border-b border-line">
          <Stepper step={2} />
        </div>

        <div className="overflow-y-auto scroll-slim flex-1">
          {loading ? (
            <div className="px-4 py-8 flex items-center justify-center gap-2 text-sm text-muted-ink">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading mapping…
            </div>
          ) : (
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Velurex room type</th>
                  <th className="th w-[46%]">{CHANNEL_LABEL[channel.key] ?? channel.name} room type</th>
                </tr>
              </thead>
              <tbody>
                {roomTypes.map((rt) => (
                  <tr key={rt.id}>
                    <td className="td">
                      <p className="font-medium text-pine text-[13px]">{rt.name}</p>
                      <p className="text-[11px] text-muted-ink">{rt.code}</p>
                    </td>
                    <td className="td">
                      <select
                        className="field h-8 text-[12px]"
                        value={rows[rt.id] ?? ""}
                        onChange={(e) => setRows((r) => ({ ...r, [rt.id]: e.target.value }))}
                        aria-label={`Map ${rt.name}`}
                      >
                        <option value="">— Not mapped —</option>
                        {channel.catalog?.map((o) => (
                          <option key={o.id} value={o.id}>{o.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="border-t border-line px-4 py-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-ink">Unmapped room types are never pushed to this channel.</p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn-outline" onClick={() => save(false)} disabled={saving || loading}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save
            </button>
            <button
              className="btn-pine"
              onClick={() => save(true)}
              disabled={saving || loading || mapped === 0}
              title={mapped === 0 ? "Map at least one room type to push a first sync" : "Save the mapping and push the next 30 days of inventory + rates now"}
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Save &amp; push first sync
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Sync log viewer ────────────────────────────────────────────────────── */

function SyncLogView() {
  const { toast } = useToast();
  const [items, setItems] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<"" | "success" | "failed">("");
  const [channelFilter, setChannelFilter] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await api<{ items: LogItem[] }>("/api/channel-inventory/sync-log");
      setItems(res.items);
    } catch (e) {
      toast({ title: "Could not load sync log", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    setLoading(true);
    void load();
    const t = window.setInterval(load, 6000);
    return () => window.clearInterval(t);
  }, [load]);

  const channels = useMemo(() => [...new Set(items.map((i) => i.channel))], [items]);
  const filtered = items.filter((i) =>
    (!statusFilter || i.status === statusFilter) && (!channelFilter || i.channel === channelFilter),
  );

  const statusCell = (st: string) =>
    st === "success"
      ? <span className="badge border-ok/40 bg-ok/10 text-ok"><Check className="h-3 w-3" /> success</span>
      : st === "failed"
        ? <span className="badge border-danger/40 bg-danger/10 text-danger"><AlertTriangle className="h-3 w-3" /> failed</span>
        : <span className="badge border-warn/40 bg-warn/10 text-warn"><Clock className="h-3 w-3" /> pending</span>;

  return (
    <div className="panel">
      <div className="panel-header flex-wrap">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-brass" />
          <p className="panel-title">Channel sync log</p>
          <span className="badge border-line-strong bg-plaster text-muted-ink">{filtered.length} entries</span>
        </div>
        <div className="flex items-center gap-2">
          <select className="field h-8 w-auto text-[12px]" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as "")} aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
          </select>
          <select className="field h-8 w-auto text-[12px]" value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Filter by channel">
            <option value="">All channels</option>
            {channels.map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c] ?? c}</option>)}
          </select>
          <button className="btn-outline h-8 text-[12px]" onClick={() => void load()}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <div className="px-4 py-10 flex items-center justify-center gap-2 text-sm text-muted-ink">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading sync history…
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <Settings2 className="h-8 w-8 text-line-strong mx-auto mb-2" />
          <p className="text-sm text-muted-ink">No sync attempts yet — toggle a cell in Inventory Control or press “Sync Now” on a connected channel.</p>
        </div>
      ) : (
        <div className="max-h-[62vh] overflow-y-auto scroll-slim">
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="th">When</th>
                <th className="th">Channel</th>
                <th className="th">Action</th>
                <th className="th">Room type / date</th>
                <th className="th">Status</th>
                <th className="th">Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((l) => (
                <tr key={l.id} className="hover:bg-plaster/40 transition">
                  <td className="td whitespace-nowrap text-[12px]">{fmtTime(l.attemptedAt)}</td>
                  <td className="td text-[12.5px] font-medium text-pine">{CHANNEL_LABEL[l.channel] ?? l.channel}</td>
                  <td className="td text-[12px] capitalize">{l.action.replace("_", " ")}</td>
                  <td className="td text-[12px]">
                    {l.roomTypeName ?? "—"}
                    {l.date && <span className="text-muted-ink"> · {l.date}</span>}
                  </td>
                  <td className="td">{statusCell(l.status)}</td>
                  <td className="td text-[11.5px] text-muted-ink max-w-[280px]"><span className="line-clamp-2">{l.message}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t border-line px-4 py-2.5 text-[11px] text-muted-ink flex items-center gap-1.5">
        <ArrowRight className="h-3 w-3" />
        Failed pushes can be retried from the grid cell (warning icon) — each retry re-enters the async queue and is logged here.
      </div>
    </div>
  );
}
