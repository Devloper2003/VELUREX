"use client";

// Task 4-a — Night Audit: one-click end-of-day close (no-shows, room charges,
// revenue lock, daily report, business-date roll-forward, accountability log).

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate, fmtTime, fmtDateTime } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  MoonStar, ShieldCheck, BedDouble, Users, CalendarCheck, Lock, UserX,
  CheckCircle2, Loader2, RefreshCw, Wallet, Sparkles, AlertTriangle,
} from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const CAN_RUN = ["hotel_admin", "front_desk"];

interface AuditLog {
  id: string;
  businessDate: string;
  runByName: string;
  runAt: string;
  totalRevenue: number;
  roomRevenue: number;
  fnbRevenue: number;
  miscRevenue: number;
  occupancyPercent: number;
  adr: number;
  revpar: number;
  occupiedRooms: number;
  totalRooms: number;
  noShowCount: number;
  noShowCharges: number;
  outstandingBalance: number;
  notes: string;
}

interface AuditData {
  businessDate: string;
  property: { name: string; noShowPercent: number };
  lastAudit: AuditLog | null;
  history: AuditLog[];
  preview: {
    noShowCandidates: {
      id: string; confirmationNumber: string; guestName: string; roomNumber: string;
      checkIn: string; nights: number; nightlyRate: number; firstNightCharge: number;
    }[];
    arrivalsToday: number;
    inHouse: number;
    occupancyNow: number;
    occupiedRooms: number;
    totalRooms: number;
    revenueToday: { room: number; fnb: number; misc: number; total: number };
    estRoomChargesToPost: number;
    daysOpen: number | null;
  };
}

interface RunResult {
  log: AuditLog;
  breakdown: {
    noShowReservations: { confirmationNumber: string; guestName: string; charge: number }[];
    roomChargesPosted: number;
    lockedItems: number;
  };
}

export default function NightAuditView() {
  const user = useSession((s) => s.user);
  const { toast } = useToast();
  const [data, setData] = useState<AuditData | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const canRun = !!user && CAN_RUN.includes(user.role);

  const load = useCallback(async () => {
    try {
      setData(await api<AuditData>("/api/night-audit"));
    } catch {
      /* offline: keep stale */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  async function runAudit() {
    setRunning(true);
    try {
      const res = await api<RunResult>("/api/night-audit", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setResult(res);
      toast({
        title: "Night audit completed",
        description: `${inr(res.log.totalRevenue)} revenue · ${res.log.occupancyPercent}% occupancy · ${res.breakdown.noShowReservations.length} no-show(s) flagged`,
      });
      await load();
    } catch (e) {
      toast({
        title: "Night audit failed",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setRunning(false);
    }
  }

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="grid lg:grid-cols-2 gap-4">
          <div className="panel p-5"><div className="skeleton h-56 rounded" /></div>
          <div className="panel p-5"><div className="skeleton h-56 rounded" /></div>
        </div>
        <div className="panel p-5"><div className="skeleton h-48 rounded" /></div>
        <div className="panel p-5"><div className="skeleton h-40 rounded" /></div>
      </div>
    );
  }
  if (!data) {
    return <div className="panel p-6 text-sm text-danger">Could not load night audit. Check your connection.</div>;
  }

  const { preview, lastAudit } = data;
  const candidates = preview.noShowCandidates;

  return (
    <div className="space-y-4">
      {/* ── Top row: Run Audit + Last Audit ─────────────────────────────── */}
      <div className="grid lg:grid-cols-2 gap-4">
        {/* Run Night Audit */}
        <div className="panel p-5 flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-ink font-medium uppercase tracking-wider">Run Night Audit</p>
              <h2 className="font-display text-3xl font-semibold text-pine mt-1 tracking-tight">
                {fmtDate(data.businessDate)}
              </h2>
              <p className="text-[11px] text-muted-ink mt-0.5">Business date being closed</p>
            </div>
            <div className="h-10 w-10 rounded-md bg-pine-100 flex items-center justify-center shrink-0">
              <MoonStar className="h-5 w-5 text-pine-700" />
            </div>
          </div>

          <p className="text-sm text-muted-ink mt-3">
            This will close the day, post room charges, flag no-shows, lock transactions, update rates &amp; generate daily reports.
          </p>

          <div className="flex flex-wrap gap-2 mt-3">
            <Chip icon={<UserX className="h-3 w-3" />} tone={candidates.length > 0 ? "danger" : "ok"}>
              {candidates.length} no-show candidate{candidates.length === 1 ? "" : "s"}
            </Chip>
            <Chip icon={<BedDouble className="h-3 w-3" />} tone="pine">
              {preview.estRoomChargesToPost} room charge{preview.estRoomChargesToPost === 1 ? "" : "s"} to post
            </Chip>
            <Chip icon={<Lock className="h-3 w-3" />} tone="brass">
              {preview.daysOpen === null ? "First audit" : `Open ${preview.daysOpen} day${preview.daysOpen === 1 ? "" : "s"} since last audit`}
            </Chip>
          </div>

          {/* Success summary */}
          {result && (
            <div className="mt-4 rounded-md border border-pine-700/25 bg-pine-100/60 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-ok shrink-0" />
                <p className="font-display font-semibold text-pine">
                  Day closed — {fmtDate(result.log.businessDate)} finalized
                </p>
                <Sparkles className="h-4 w-4 text-brass ml-auto" />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3">
                <MiniStat label="Revenue" value={inr(result.log.totalRevenue)} />
                <MiniStat label="Occupancy" value={`${result.log.occupancyPercent}%`} />
                <MiniStat
                  label="No-shows"
                  value={String(result.log.noShowCount)}
                  sub={result.log.noShowCount > 0 ? inr(result.log.noShowCharges) : undefined}
                />
                <MiniStat label="New business date" value={fmtDate(data.businessDate)} />
              </div>
              {result.breakdown.noShowReservations.length > 0 && (
                <ul className="mt-3 space-y-1 border-t border-pine-700/15 pt-2">
                  {result.breakdown.noShowReservations.map((n) => (
                    <li key={n.confirmationNumber} className="text-[12px] text-ink flex items-center gap-1.5">
                      <AlertTriangle className="h-3 w-3 text-danger shrink-0" />
                      <b>{n.guestName}</b> ({n.confirmationNumber}) charged {inr(n.charge)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-muted-ink mt-2">
                {result.breakdown.roomChargesPosted} room charges posted · {result.breakdown.lockedItems} transactions locked
              </p>
            </div>
          )}

          <div className="mt-auto pt-4 flex items-center gap-2">
            {canRun ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button className="btn-pine h-10 px-6" disabled={running}>
                    {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoonStar className="h-4 w-4" />}
                    {running ? "Running audit…" : "Run Audit"}
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Run night audit for {fmtDate(data.businessDate)}?</AlertDialogTitle>
                    <AlertDialogDescription asChild>
                      <div className="space-y-2">
                        <p>The end-of-day close will:</p>
                        <ul className="space-y-1.5 text-[13px]">
                          <li>• Flag <b>{candidates.length}</b> no-show reservation{candidates.length === 1 ? "" : "s"} and post first-night charges ({data.property.noShowPercent}% policy)</li>
                          <li>• Post <b>{preview.estRoomChargesToPost}</b> room charge{preview.estRoomChargesToPost === 1 ? "" : "s"} to in-house folios</li>
                          <li>• Lock all transactions for {fmtDate(data.businessDate)} — locked items cannot be edited or voided</li>
                          <li>• Generate the daily revenue report and roll the business date forward to <b>{fmtDate(data.businessDate)}</b> + 1</li>
                        </ul>
                        <p className="text-[12px]">This action cannot be undone for the closing date.</p>
                      </div>
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-pine-700 text-panel hover:bg-pine-600"
                      onClick={runAudit}
                    >
                      Run Night Audit
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-block">
                    <button className="btn-pine h-10 px-6" disabled>
                      <MoonStar className="h-4 w-4" /> Run Audit
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>Only Hotel Admin and Front Desk can run the night audit</TooltipContent>
              </Tooltip>
            )}
            <button className="btn-ghost" onClick={load} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} /> Refresh
            </button>
          </div>
        </div>

        {/* Last Audit */}
        <div className="panel p-5 flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs text-muted-ink font-medium uppercase tracking-wider">Last Audit</p>
              {lastAudit ? (
                <>
                  <h2 className="font-display text-2xl font-semibold text-pine mt-1 tracking-tight">
                    {fmtDate(lastAudit.businessDate)}
                  </h2>
                  <p className="text-[11px] text-muted-ink mt-0.5">
                    Run by {lastAudit.runByName} · {fmtDateTime(lastAudit.runAt)}
                  </p>
                </>
              ) : (
                <p className="text-sm text-muted-ink mt-2">No audit has been run yet.</p>
              )}
            </div>
            <div className="h-10 w-10 rounded-md bg-brass-50 flex items-center justify-center shrink-0">
              <ShieldCheck className="h-5 w-5 text-brass" />
            </div>
          </div>

          {lastAudit && (
            <>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3 mt-4">
                <Stat label="Total Revenue" value={inr(lastAudit.totalRevenue)} />
                <Stat label="Occupancy" value={`${lastAudit.occupancyPercent}%`} sub={`${lastAudit.occupiedRooms}/${lastAudit.totalRooms} rooms`} />
                <Stat label="No-Shows" value={String(lastAudit.noShowCount)} sub={lastAudit.noShowCount > 0 ? inr(lastAudit.noShowCharges) : "—"} danger={lastAudit.noShowCount > 0} />
                <Stat label="ADR" value={inr(lastAudit.adr)} />
                <Stat label="RevPAR" value={inr(lastAudit.revpar)} />
                <Stat label="Outstanding" value={inr(lastAudit.outstandingBalance)} warn />
              </div>
              {lastAudit.notes && (
                <p className="text-[11px] text-muted-ink mt-3 border-t border-line pt-2">{lastAudit.notes}</p>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Preview + Daily report ──────────────────────────────────────── */}
      <div className="grid lg:grid-cols-5 gap-4">
        {/* Audit preview */}
        <div className="panel lg:col-span-3">
          <div className="panel-header">
            <p className="panel-title">Audit Preview — {fmtDate(data.businessDate)}</p>
            <div className="hidden sm:flex flex-wrap gap-2">
              <Chip icon={<BedDouble className="h-3 w-3" />}>{preview.inHouse} in-house</Chip>
              <Chip icon={<CalendarCheck className="h-3 w-3" />}>{preview.arrivalsToday} arrivals</Chip>
              <Chip icon={<Users className="h-3 w-3" />}>{preview.occupancyNow}% occupied now</Chip>
            </div>
          </div>
          <div className="sm:hidden px-4 pt-3 flex flex-wrap gap-2">
            <Chip icon={<BedDouble className="h-3 w-3" />}>{preview.inHouse} in-house</Chip>
            <Chip icon={<CalendarCheck className="h-3 w-3" />}>{preview.arrivalsToday} arrivals</Chip>
            <Chip icon={<Users className="h-3 w-3" />}>{preview.occupancyNow}% occupied now</Chip>
          </div>
          <div className="p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[13px] font-medium text-pine">No-show candidates</p>
              <p className="text-[11px] text-muted-ink">
                {preview.estRoomChargesToPost} room charge{preview.estRoomChargesToPost === 1 ? "" : "s"} will be posted · {preview.occupiedRooms}/{preview.totalRooms} rooms occupied
              </p>
            </div>
            {candidates.length === 0 ? (
              <div className="rounded-md border border-line bg-plaster/40 px-4 py-6 text-center">
                <CheckCircle2 className="h-5 w-5 text-ok mx-auto" />
                <p className="text-sm text-ink mt-1.5">No no-show candidates</p>
                <p className="text-[11px] text-muted-ink">Every past arrival is checked in, cancelled, or already flagged.</p>
              </div>
            ) : (
              <div className="overflow-x-auto scroll-slim rounded-md border border-line">
                <table className="w-full min-w-[560px]">
                  <thead>
                    <tr>
                      <th className="th">Guest</th>
                      <th className="th">Conf #</th>
                      <th className="th">Room</th>
                      <th className="th">Arrival</th>
                      <th className="th text-right">First-night charge</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.map((c) => (
                      <tr key={c.id} className="hover:bg-plaster/50">
                        <td className="td font-medium text-pine">{c.guestName}</td>
                        <td className="td font-mono text-[12px]">{c.confirmationNumber}</td>
                        <td className="td">{c.roomNumber}</td>
                        <td className="td">{fmtDate(c.checkIn)}</td>
                        <td className="td text-right font-medium text-danger">{inr(c.firstNightCharge)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {candidates.length > 0 && (
              <p className="text-[11px] text-muted-ink mt-2">
                Arrivals before {fmtDate(data.businessDate)} with no check-in are flagged no_show and charged {data.property.noShowPercent}% of the first night ({inr(candidates.reduce((s, c) => s + c.firstNightCharge, 0))} total).
              </p>
            )}
          </div>
        </div>

        {/* Daily report from last audit */}
        <div className="panel lg:col-span-2">
          <div className="panel-header">
            <p className="panel-title">
              Daily Report{lastAudit ? ` — ${fmtDate(lastAudit.businessDate)}` : ""}
            </p>
            <Wallet className="h-4 w-4 text-brass" />
          </div>
          {lastAudit ? (
            <div className="p-4 space-y-4">
              <RevBar label="Rooms" value={lastAudit.roomRevenue} total={lastAudit.totalRevenue || 1} color="#1F4B43" />
              <RevBar label="F&B" value={lastAudit.fnbRevenue} total={lastAudit.totalRevenue || 1} color="#B9873E" />
              <RevBar label="Misc / No-Show" value={lastAudit.miscRevenue} total={lastAudit.totalRevenue || 1} color="#4C7A5A" />
              <div className="grid grid-cols-3 gap-3 border-t border-line pt-3">
                <div>
                  <p className="kpi-value">{lastAudit.occupancyPercent}%</p>
                  <p className="text-[11px] text-muted-ink">Occupancy</p>
                </div>
                <div>
                  <p className="kpi-value">{inr(lastAudit.adr)}</p>
                  <p className="text-[11px] text-muted-ink">ADR</p>
                </div>
                <div>
                  <p className="kpi-value">{inr(lastAudit.revpar)}</p>
                  <p className="text-[11px] text-muted-ink">RevPAR</p>
                </div>
              </div>
              <div className="flex items-center justify-between border-t border-line pt-3 text-sm">
                <span className="text-muted-ink">Outstanding balance</span>
                <span className="font-semibold text-brass">{inr(lastAudit.outstandingBalance)}</span>
              </div>
            </div>
          ) : (
            <div className="p-6 text-center">
              <MoonStar className="h-5 w-5 text-muted-ink mx-auto" />
              <p className="text-sm text-ink mt-1.5">No daily report yet</p>
              <p className="text-[11px] text-muted-ink">Run the night audit to generate the first report.</p>
            </div>
          )}
        </div>
      </div>

      {/* ── History ─────────────────────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Audit History</p>
          <span className="text-xs text-muted-ink">{data.history.length} finalized day{data.history.length === 1 ? "" : "s"}</span>
        </div>
        <div className="overflow-auto max-h-96 scroll-slim">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr>
                <th className="th">Date</th>
                <th className="th">Run by</th>
                <th className="th">Run at</th>
                <th className="th">Occupancy</th>
                <th className="th">ADR</th>
                <th className="th">RevPAR</th>
                <th className="th text-right">Rooms</th>
                <th className="th text-right">F&amp;B</th>
                <th className="th text-right">Misc</th>
                <th className="th text-right">Total</th>
                <th className="th">No-shows</th>
                <th className="th">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((h) => (
                <tr key={h.id} className="hover:bg-plaster/50">
                  <td className="td font-medium text-pine">{fmtDate(h.businessDate)}</td>
                  <td className="td">{h.runByName || "—"}</td>
                  <td className="td text-muted-ink">{fmtTime(h.runAt)}</td>
                  <td className="td">{h.occupancyPercent}%</td>
                  <td className="td">{inr(h.adr)}</td>
                  <td className="td">{inr(h.revpar)}</td>
                  <td className="td text-right">{inr(h.roomRevenue)}</td>
                  <td className="td text-right">{inr(h.fnbRevenue)}</td>
                  <td className="td text-right">{inr(h.miscRevenue)}</td>
                  <td className="td text-right font-semibold">{inr(h.totalRevenue)}</td>
                  <td className="td">
                    {h.noShowCount > 0 ? (
                      <span className="text-danger font-medium">{h.noShowCount} · {inr(h.noShowCharges)}</span>
                    ) : (
                      <span className="text-muted-ink">0</span>
                    )}
                  </td>
                  <td className="td">
                    <span className="badge border-ok/40 bg-ok/10 text-ok">
                      <Lock className="h-3 w-3" /> Finalized
                    </span>
                  </td>
                </tr>
              ))}
              {data.history.length === 0 && (
                <tr>
                  <td className="td text-center text-muted-ink" colSpan={12}>
                    No audits recorded yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/* ── Small building blocks ──────────────────────────────────────────────── */

function Chip({ icon, tone = "plain", children }: {
  icon?: React.ReactNode;
  tone?: "plain" | "pine" | "brass" | "ok" | "danger";
  children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    plain: "border-line bg-plaster text-ink",
    pine: "border-pine-700/30 bg-pine-100 text-pine-700",
    brass: "border-brass/40 bg-brass-50 text-brass",
    ok: "border-ok/40 bg-ok/10 text-ok",
    danger: "border-danger/40 bg-danger/10 text-danger",
  };
  return (
    <span className={cn("badge", tones[tone])}>
      {icon}
      {children}
    </span>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-[11px] text-muted-ink">{label}</p>
      <p className="font-display font-semibold text-pine text-lg leading-tight">{value}</p>
      {sub && <p className="text-[11px] text-muted-ink">{sub}</p>}
    </div>
  );
}

function Stat({ label, value, sub, warn, danger }: { label: string; value: string; sub?: string; warn?: boolean; danger?: boolean }) {
  return (
    <div>
      <p className="text-[11px] text-muted-ink">{label}</p>
      <p className={cn("font-display font-semibold text-lg leading-tight", warn ? "text-brass" : danger ? "text-danger" : "text-pine")}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-muted-ink">{sub}</p>}
    </div>
  );
}

function RevBar({ label, value, total, color }: { label: string; value: number; total: number; color: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, Math.round((value / total) * 100))) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[13px] mb-1">
        <span className="text-ink">{label}</span>
        <span className="font-medium text-pine">
          {inr(value)} <span className="text-muted-ink text-[11px]">({pct}%)</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-plaster-deep overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}
