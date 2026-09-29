"use client";

import { useCallback, useEffect, useState } from "react";
import { Network, CheckCircle2, AlertTriangle, Layers, RefreshCw, Loader2 } from "lucide-react";
import {
  useOwnerApi, relativeDays, StatusBadge, EmptyState, Loading, ErrorState, StatCard,
} from "@/components/owner/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ConnectionRow {
  id: string;
  channel: string;
  status: string;
  isActive: boolean;
  lastSyncedAt: string | null;
  updatedAt: string;
  property: { id: string; name: string; city: string; subscriptionStatus: string };
  failures7d: number;
}

interface QueueJob {
  id: string;
  action: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  property: string;
}

interface IntegrationsData {
  connections: ConnectionRow[];
  queue: QueueJob[];
  summary: { connected: number; error: number; total: number };
}

const CHANNEL_LABELS: Record<string, string> = {
  booking_com: "Booking.com",
  agoda: "Agoda",
  makemytrip: "MakeMyTrip",
  go_mmt: "Goibibo (MMT)",
  airbnb: "Airbnb",
  expedia: "Expedia",
  yatra: "Yatra",
  cleartrip: "Cleartrip",
  oyo: "OYO",
  fabhotels: "FabHotels",
  own_site: "Own site",
};

function channelLabel(ch: string): string {
  return CHANNEL_LABELS[ch] ?? ch.replace(/_/g, " ");
}

function connStatusBadge(status: string, isActive: boolean): { label: string; cls: string } {
  if (status === "connected" && isActive) return { label: "connected", cls: "border-ok/40 bg-ok/10 text-ok" };
  if (status === "error") return { label: "error", cls: "border-danger/40 bg-danger/10 text-danger" };
  return { label: status === "connected" ? "paused" : status, cls: "border-line-strong bg-plaster text-muted-ink" };
}

function ageHours(iso: string): string {
  const h = Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
  if (h >= 48) return `${Math.round(h / 24)}d ago`;
  if (h <= 0) return "just now";
  return `${h}h ago`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function IntegrationsView() {
  const api = useOwnerApi();
  const [data, setData] = useState<IntegrationsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setRefreshing(true);
    try {
      const res = await api<IntegrationsData>("/api/owner/integrations");
      setData(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard
          label="Connected"
          value={data ? String(data.summary.connected) : "—"}
          sub="active channel connections"
          icon={CheckCircle2}
          tone="ok"
        />
        <StatCard
          label="Errors"
          value={data ? String(data.summary.error) : "—"}
          sub="connections in error state"
          icon={AlertTriangle}
          tone="danger"
          valueClass="text-danger"
        />
        <StatCard
          label="Total connections"
          value={data ? String(data.summary.total) : "—"}
          sub="across all businesses"
          icon={Layers}
          tone="brass"
        />
      </div>

      {/* Connections table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><Network className="h-4 w-4 text-brass" /> Channel connections</p>
          <button className="btn-outline h-8" onClick={() => void load()} disabled={refreshing}>
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </div>
        {loading ? (
          <Loading label="Loading connections…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !data || data.connections.length === 0 ? (
          <EmptyState icon={Network} title="No channel connections" hint="Once tenants connect OTAs in their Channel Manager, they appear here." />
        ) : (
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr>
                  <th className="th">Business</th>
                  <th className="th">Channel</th>
                  <th className="th">Status</th>
                  <th className="th">Last sync</th>
                  <th className="th">Failures 7d</th>
                  <th className="th">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.connections.map((c) => {
                  const badge = connStatusBadge(c.status, c.isActive);
                  return (
                    <tr key={c.id} className="hover:bg-plaster/50 transition">
                      <td className="td">
                        <span className="block font-medium text-pine">{c.property.name}</span>
                        <span className="text-xs text-muted-ink">{c.property.city}</span>
                      </td>
                      <td className="td">
                        <span className="badge border-pine/30 bg-pine/5 text-pine capitalize">{channelLabel(c.channel)}</span>
                      </td>
                      <td className="td"><span className={`badge capitalize ${badge.cls}`}>{badge.label}</span></td>
                      <td className="td text-muted-ink">{c.lastSyncedAt ? relativeDays(c.lastSyncedAt) : "never"}</td>
                      <td className="td">
                        <span className={c.failures7d > 0 ? "text-warn font-medium" : "text-muted-ink"}>{c.failures7d}</span>
                      </td>
                      <td className="td text-muted-ink">{relativeDays(c.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Sync queue */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><RefreshCw className="h-4 w-4 text-brass" /> Sync queue</p>
          <p className="text-xs text-muted-ink">{data ? `${data.queue.length} recent job${data.queue.length === 1 ? "" : "s"}` : "…"}</p>
        </div>
        {loading ? (
          <Loading label="Loading queue…" />
        ) : error ? null : !data || data.queue.length === 0 ? (
          <EmptyState icon={RefreshCw} title="Queue is empty" hint="No pending, processing or failed sync jobs right now." />
        ) : (
          <ul className="max-h-72 overflow-y-auto scroll-slim divide-y divide-line/70">
            {data.queue.map((j) => (
              <li key={j.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <span className="font-medium text-pine min-w-40">{j.property}</span>
                <span className="badge border-line-strong bg-plaster text-muted-ink">{j.action.replace(/_/g, " ")}</span>
                {j.status === "failed"
                  ? <span className="badge border-danger/40 bg-danger/10 text-danger">failed</span>
                  : <StatusBadge status={j.status === "processing" ? "in_progress" : j.status} />}
                <span className="text-xs text-muted-ink">{j.attempts} attempt{j.attempts === 1 ? "" : "s"}</span>
                <span className="text-xs text-muted-ink ml-auto">{ageHours(j.createdAt)}</span>
                {j.lastError && (
                  <span className="w-full text-xs text-danger truncate" title={j.lastError}>⚠ {j.lastError}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
