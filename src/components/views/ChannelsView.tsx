"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check, X, RefreshCw, Loader2, Link2, Link2Off, Settings2, ListChecks,
  AlertTriangle, Clock, Lock, Eye, EyeOff, ShieldCheck, ArrowRight, ScrollText, Wifi,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/* ─── Types ──────────────────────────────────────────────────────────────── */

interface ChannelDef {
  key: string; name: string; blurb: string; iconBg: string; monogram: string;
  credentialFields: { key: string; label: string; placeholder: string; required: boolean }[];
}
interface ConnectionInfo {
  id: string; status: string; isActive: boolean; lastSyncedAt: string | null;
  mappedRoomTypes: number; queue: { pending: number; failed: number };
}
interface ChannelEntry extends ChannelDef {
  connected: boolean;
  connection: ConnectionInfo | null;
}
interface RoomTypeLite { id: string; name: string; code: string }
interface ChannelsPayload { channels: ChannelEntry[]; roomTypes: RoomTypeLite[] }

interface LogItem {
  id: string; channel: string; action: string; status: string; message: string;
  attemptedAt: string; date: string | null; roomTypeName: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  booking_com: "Booking.com", expedia: "Expedia", mmt: "MakeMyTrip",
  goibibo: "Goibibo", yatra: "Yatra", agoda: "Agoda", easemytrip: "EasyMyTrip",
  cleartrip: "Cleartrip", airbnb: "Airbnb", oyo: "OYO", own_website: "Own Website",
};

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

export default function ChannelsView() {
  const { user } = useSession();
  const { toast } = useToast();
  const isAdmin = user?.role === "hotel_admin";

  const [data, setData] = useState<ChannelsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"connections" | "sync-log">("connections");

  const [connectTarget, setConnectTarget] = useState<ChannelEntry | null>(null);
  const [mapTarget, setMapTarget] = useState<ChannelEntry | null>(null);

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

  if (loading && !data) {
    return (
      <div className="panel p-10 flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-brass" />
        <p className="text-sm text-muted-ink">Loading channel connections…</p>
      </div>
    );
  }
  if (!data) return null;

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
          One control room for every OTA and your own website — map room types once, then open,
          close and re-price everywhere from <span className="font-medium text-pine">Inventory Control</span>. Credentials are
          encrypted at rest and never leave the server.
        </p>

        <div className="ml-auto inline-flex rounded-md border border-line-strong bg-plaster/60 p-0.5" role="tablist" aria-label="Channels sections">
          <button
            role="tab" aria-selected={tab === "connections"} onClick={() => setTab("connections")}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
              tab === "connections" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
            )}
          >
            <Link2 className="h-3.5 w-3.5" /> Connections
          </button>
          <button
            role="tab" aria-selected={tab === "sync-log"} onClick={() => setTab("sync-log")}
            className={cn(
              "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
              tab === "sync-log" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
            )}
          >
            <ScrollText className="h-3.5 w-3.5" /> Sync Log
          </button>
        </div>
      </div>

      {tab === "connections" && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {data.channels.map((ch) => (
            <ChannelCard
              key={ch.key}
              ch={ch}
              isAdmin={isAdmin}
              onConnect={() => setConnectTarget(ch)}
              onManage={() => setMapTarget(ch)}
              onChanged={() => load(false)}
            />
          ))}
        </div>
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
    </div>
  );
}

/* ─── Channel card ───────────────────────────────────────────────────────── */

function ChannelCard({
  ch, isAdmin, onConnect, onManage, onChanged,
}: {
  ch: ChannelEntry;
  isAdmin: boolean;
  onConnect: () => void;
  onManage: () => void;
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
            <p className="font-display font-semibold text-pine text-[15px] leading-tight truncate">{ch.name}</p>
            <p className="text-[10.5px] text-muted-ink truncate">{ch.blurb}</p>
          </div>
        </div>
        {statusBadge}
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
          <button className="btn-pine h-8 text-[12px] flex-1" onClick={onConnect} disabled={!isAdmin}
            title={isAdmin ? "" : "Only the hotel admin can connect channels"}>
            <Link2 className="h-3.5 w-3.5" /> Connect
          </button>
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
                "Full sync queued"
              )}
            >
              {busy === "Sync now" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync Now
            </button>
            <button className="btn-outline h-8 text-[12px]" onClick={onManage} disabled={!isAdmin}>
              <ListChecks className="h-3.5 w-3.5" /> Map ({conn.mappedRoomTypes})
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

/* ─── Connect dialog ─────────────────────────────────────────────────────── */

function ConnectDialog({ channel, onClose, onConnected }: { channel: ChannelEntry; onClose: () => void; onConnected: () => void }) {
  const { toast } = useToast();
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await api<{ message: string }>("/api/channels", {
        method: "POST",
        body: JSON.stringify({ channel: channel.key, credentials: creds }),
      });
      toast({ title: `${channel.name} connected`, description: res.message });
      onConnected();
    } catch (e) {
      toast({ title: "Connection failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = channel.credentialFields.every((f) => !f.required || (creds[f.key]?.trim().length ?? 0) >= 4);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-label={`Connect ${channel.name}`}>
      <div className="absolute inset-0 bg-pine/50" onClick={busy ? undefined : onClose} />
      <div className="relative panel border-line-strong w-full max-w-md expand-in">
        <div className="panel-header">
          <div className="flex items-center gap-2.5">
            <span className="h-8 w-8 rounded-md flex items-center justify-center text-panel text-[12px] font-bold" style={{ backgroundColor: channel.iconBg }}>
              {channel.monogram}
            </span>
            <div>
              <p className="panel-title">Connect {channel.name}</p>
              <p className="text-[11px] text-muted-ink">OAuth/API-key handshake · encrypted at rest</p>
            </div>
          </div>
          <button className="btn-ghost px-1.5 h-6" onClick={onClose} disabled={busy} aria-label="Close"><X className="h-3.5 w-3.5" /></button>
        </div>

        <div className="px-4 py-4 space-y-3.5">
          {channel.credentialFields.length === 0 ? (
            <div className="rounded-md border border-ok/30 bg-ok/10 px-3 py-2.5 text-[12.5px] text-ok flex items-start gap-2">
              <Check className="h-4 w-4 mt-0.5 shrink-0" />
              <span>The Velurex booking engine is part of your subscription — no keys needed. Connecting it links the hosted /book page and embeddable widget to unified inventory instantly.</span>
            </div>
          ) : (
            channel.credentialFields.map((f) => (
              <div key={f.key}>
                <label className="field-label" htmlFor={`cred-${f.key}`}>{f.label}{f.required && " *"}</label>
                <div className="relative">
                  <input
                    id={`cred-${f.key}`}
                    type={show ? "text" : "password"}
                    className="field pr-9 font-mono text-[12.5px]"
                    placeholder={f.placeholder}
                    value={creds[f.key] ?? ""}
                    onChange={(e) => setCreds((c) => ({ ...c, [f.key]: e.target.value }))}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine transition"
                    onClick={() => setShow((s) => !s)}
                    aria-label={show ? "Hide credentials" : "Show credentials"}
                  >
                    {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
            ))
          )}
          <p className="text-[11px] text-muted-ink flex items-start gap-1.5">
            <Lock className="h-3 w-3 mt-0.5 shrink-0" />
            Keys are AES-256-GCM encrypted per tenant and used only server-side when pushing inventory. Demo mode validates the handshake against a mock channel API.
          </p>
        </div>

        <div className="border-t border-line px-4 py-3 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn-pine" onClick={submit} disabled={busy || !canSubmit}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            {busy ? "Handshaking…" : "Test & Connect"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Mapping dialog ─────────────────────────────────────────────────────── */

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

  const save = async () => {
    setSaving(true);
    try {
      await api(`/api/channels/${connId}/mappings`, {
        method: "PUT",
        body: JSON.stringify({ mappings: roomTypes.map((rt) => ({ roomTypeId: rt.id, externalRoomTypeId: rows[rt.id] ?? "" })) }),
      });
      toast({ title: "Mapping saved", description: `${mapped} room type${mapped === 1 ? "" : "s"} mapped to ${channel.name}.` });
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
      <div className="relative panel border-line-strong w-full max-w-lg max-h-[80vh] flex flex-col expand-in">
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
                  <th className="th w-[46%]">{CHANNEL_LABEL[channel.key] ?? channel.name} room type id</th>
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
                        {(channel as unknown as { catalog?: { id: string; label: string }[] }).catalog?.length
                          ? (channel as unknown as { catalog: { id: string; label: string }[] }).catalog.map((o) => (
                            <option key={o.id} value={o.id}>{o.label}</option>
                          ))
                          : MAPPING_OPTIONS[channel.key]?.map((o) => (
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

        <div className="border-t border-line px-4 py-3 flex items-center justify-between gap-2">
          <p className="text-[11px] text-muted-ink">Unmapped room types are never pushed to this channel.</p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn-pine" onClick={save} disabled={saving || loading}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Save mapping
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Static catalogs mirrored client-side (matches CHANNEL_CATALOGS server-side). */
const MAPPING_OPTIONS: Record<string, { id: string; label: string }[]> = {
  booking_com: [
    { id: "107370201", label: "107370201 — Deluxe King Room" },
    { id: "107370202", label: "107370202 — Executive Suite" },
    { id: "107370203", label: "107370203 — Premier Double" },
    { id: "107370204", label: "107370204 — Garden Villa" },
  ],
  expedia: [
    { id: "EXP-RM-2201", label: "EXP-RM-2201 · Deluxe King" },
    { id: "EXP-RM-2202", label: "EXP-RM-2202 · Executive Suite" },
    { id: "EXP-RM-2203", label: "EXP-RM-2203 · Premier Double" },
    { id: "EXP-RM-2204", label: "EXP-RM-2204 · Garden Villa" },
  ],
  mmt: [
    { id: "MMT-RT-88101", label: "MMT-RT-88101 Deluxe" },
    { id: "MMT-RT-88102", label: "MMT-RT-88102 Suite" },
    { id: "MMT-RT-88103", label: "MMT-RT-88103 Premier" },
    { id: "MMT-RT-88104", label: "MMT-RT-88104 Villa" },
  ],
  goibibo: [
    { id: "GO-RTX-4501", label: "GO-RTX-4501 Deluxe Room" },
    { id: "GO-RTX-4502", label: "GO-RTX-4502 Executive Suite" },
    { id: "GO-RTX-4503", label: "GO-RTX-4503 Premier Room" },
    { id: "GO-RTX-4504", label: "GO-RTX-4504 Garden Villa" },
  ],
  yatra: [
    { id: "YTR-77110", label: "YTR-77110 — Deluxe" },
    { id: "YTR-77120", label: "YTR-77120 — Suite" },
    { id: "YTR-77130", label: "YTR-77130 — Premier" },
    { id: "YTR-77140", label: "YTR-77140 — Villa" },
  ],
  own_website: [
    { id: "OWN-DELUXE", label: "OWN-DELUXE (auto-mapped from Velurex)" },
    { id: "OWN-SUITE", label: "OWN-SUITE (auto-mapped from Velurex)" },
    { id: "OWN-PREMIER", label: "OWN-PREMIER (auto-mapped from Velurex)" },
    { id: "OWN-VILLA", label: "OWN-VILLA (auto-mapped from Velurex)" },
  ],
};

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
    (!statusFilter || i.status === statusFilter) && (!channelFilter || i.channel === channelFilter)
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
