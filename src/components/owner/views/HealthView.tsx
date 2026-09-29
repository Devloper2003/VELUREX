"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Activity, Database, HardDriveDownload, AlarmClock, Play, Loader2,
  AlertTriangle, Info, RefreshCw,
} from "lucide-react";
import { useOwnerApi, relativeDays, fmtDateTime, EmptyState, Loading, ErrorState } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HealthData {
  dailyJobs: { lastRun: string | null; lastRunBy: string; configured: boolean };
  queue: { pending: number; failed: number };
  recentErrors: { id: string; action: string; details: string; createdAt: string }[];
  database: {
    sizeBytes: number;
    properties: number;
    provider?: string;
    latencyMs?: number;
    backup: { lastBackup: string | null; configured: boolean; note?: string };
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

const JOB_SCHEDULE = [
  { title: "Subscription renewals", body: "Creates the next period's invoice for subscriptions due today and rolls their renewal date forward." },
  { title: "Renewal reminders", body: "Marks tenants for reminder emails 7, 3 and 1 day before their renewal date." },
  { title: "Overdue → grace → suspend", body: "Invoices past due become overdue; after the grace period the subscription suspends and, after the retention window, data deletion is scheduled." },
  { title: "Usage snapshots", body: "Records per-tenant usage (rooms, reservations, users) for the analytics trending charts." },
];

// ─── View ────────────────────────────────────────────────────────────────────

export default function HealthView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [data, setData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await api<HealthData>("/api/owner/health"));
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function runDailyJobs() {
    setRunning(true);
    try {
      const res = await api<{ ok: boolean; ran: string[]; skipped?: string[] }>("/api/owner/cron/daily", { method: "POST" });
      if (res.ran.length > 0) {
        toast({ title: "Daily jobs ran", description: res.ran.join(" · ") });
      } else {
        toast({ title: "Daily jobs already ran today", description: (res.skipped ?? ["already-ran-today"]).join(" · ") });
      }
      await load();
    } catch (e) {
      toast({ title: "Run failed", description: errText(e), variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  const mb = data ? (data.database.sizeBytes / 1024 / 1024).toFixed(1) : "—";
  const latency = data?.database.latencyMs;
  const latencyTone =
    latency === undefined ? "text-muted-ink" : latency < 120 ? "text-ok" : latency < 400 ? "text-warn" : "text-danger";

  return (
    <div className="space-y-4">
      {loading ? (
        <Loading label="Checking system health…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : !data ? null : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="panel p-4 flex flex-col">
              <div className="flex items-center justify-between">
                <p className="field-label">Daily jobs</p>
                <AlarmClock className="h-3.5 w-3.5 text-brass" />
              </div>
              <p className="kpi-value">{data.dailyJobs.lastRun ? relativeDays(data.dailyJobs.lastRun) : "never"}</p>
              <p className="text-xs text-muted-ink mt-0.5">
                {data.dailyJobs.lastRun ? `by ${data.dailyJobs.lastRunBy} · ${fmtDateTime(data.dailyJobs.lastRun)}` : "not yet executed"}
              </p>
              <button className="btn-outline h-8 mt-3 self-start" disabled={running} onClick={() => void runDailyJobs()}>
                {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                Run now
              </button>
            </div>

            <div className="panel p-4">
              <div className="flex items-center justify-between">
                <p className="field-label">Sync queue</p>
                <Activity className="h-3.5 w-3.5 text-brass" />
              </div>
              <p className="kpi-value">
                {data.queue.pending}
                <span className="text-base text-muted-ink font-normal"> pending</span>
              </p>
              <p className={`text-xs mt-0.5 ${data.queue.failed > 0 ? "text-danger font-medium" : "text-muted-ink"}`}>
                {data.queue.failed} failed job{data.queue.failed === 1 ? "" : "s"}
              </p>
            </div>

            <div className="panel p-4">
              <div className="flex items-center justify-between">
                <p className="field-label">Database</p>
                <Database className="h-3.5 w-3.5 text-brass" />
              </div>
              <p className="kpi-value">{mb} MB</p>
              <p className="text-xs text-muted-ink mt-0.5">
                {data.database.properties} active business{data.database.properties === 1 ? "" : "es"}
                {data.database.provider ? ` · ${data.database.provider}` : ""}
              </p>
              {latency !== undefined && (
                <p className="text-[11px] mt-1 flex items-center gap-1.5">
                  <span className={`h-1.5 w-1.5 rounded-full ${latency < 120 ? "bg-ok" : latency < 400 ? "bg-warn" : "bg-danger"}`} aria-hidden />
                  <span className="text-muted-ink">Live connection</span>
                  <span className={`font-medium ${latencyTone}`}>{latency} ms</span>
                </p>
              )}
            </div>

            <div className="panel p-4">
              <div className="flex items-center justify-between">
                <p className="field-label">Backups</p>
                <HardDriveDownload className="h-3.5 w-3.5 text-brass" />
              </div>
              {data.database.backup.configured ? (
                <>
                  <p className="kpi-value">{data.database.backup.lastBackup ? relativeDays(data.database.backup.lastBackup) : "—"}</p>
                  <p className="text-xs text-muted-ink mt-0.5">last backup snapshot</p>
                </>
              ) : (
                <div className="mt-1.5 rounded-md border border-line bg-plaster/60 p-2.5">
                  <p className="text-[11px] text-muted-ink flex items-start gap-1.5 leading-relaxed">
                    <Info className="h-3 w-3 mt-0.5 shrink-0 text-muted-ink" />
                    {data.database.backup.note ?? "Backups are not configured in this environment."}
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Schedule explainer */}
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title flex items-center gap-2"><AlarmClock className="h-4 w-4 text-brass" /> What the daily job does</p>
              <p className="text-xs text-muted-ink">Runs automatically at each day rollover · manual runs above are idempotent</p>
            </div>
            <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
              {JOB_SCHEDULE.map((j) => (
                <div key={j.title} className="rounded-md border border-line p-3 bg-plaster/40">
                  <p className="text-sm font-medium text-pine">{j.title}</p>
                  <p className="text-xs text-muted-ink mt-1 leading-relaxed">{j.body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Recent errors */}
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-brass" /> Recent system errors</p>
              <button className="btn-ghost h-8" onClick={() => void load()}>
                <RefreshCw className="h-4 w-4" /> Refresh
              </button>
            </div>
            {data.recentErrors.length === 0 ? (
              <EmptyState icon={AlertTriangle} title="No system errors recorded" hint="Daily-job failures and platform errors will appear here." />
            ) : (
              <ul className="max-h-96 overflow-y-auto scroll-slim divide-y divide-line/70">
                {data.recentErrors.map((e) => (
                  <li key={e.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="badge border-danger/50 bg-danger/10 text-danger font-mono text-[10px]">{e.action}</span>
                      <span className="text-xs text-muted-ink ml-auto">{fmtDateTime(e.createdAt)}</span>
                    </div>
                    <p className="text-sm text-ink mt-1 whitespace-pre-line">{e.details}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
