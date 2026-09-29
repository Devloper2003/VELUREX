"use client";

import { useSession } from "@/lib/store";
import { useEffect, useState, useCallback } from "react";

/** Format rupees the Velurex way (en-IN). */
export function inr(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n);
}

/** ISO date → "12 Mar 2025". */
export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/** ISO datetime → "12 Mar, 10:24". */
export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return new Date(d).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function relativeDays(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const diff = Math.round((new Date(d).getTime() - Date.now()) / 86400000);
  if (diff === 0) return "today";
  if (diff > 0) return `in ${diff}d`;
  return `${Math.abs(diff)}d ago`;
}

/** Authenticated owner fetch (Bearer from the session store). */
export function useOwnerApi() {
  const token = useSession((s) => s.token);
  return useCallback(
    async <T,>(path: string, init?: RequestInit): Promise<T> => {
      const res = await fetch(path, {
        ...init,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(init?.headers ?? {}),
        },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { data, status: res.status });
      return data as T;
    },
    [token]
  );
}

/** Tiny polling hook for owner views. */
export function usePolling(fn: () => void | Promise<void>, ms = 30000) {
  useEffect(() => {
    const t = setInterval(fn, ms);
    return () => clearInterval(t);
  }, [fn, ms]);
}

/** Unlimited display helper (-1 caps). */
export function cap(n: number): string {
  return n === -1 ? "∞" : String(n);
}

export function pct(used: number, c: number): number {
  if (c === -1) return Math.min(100, (used / Math.max(used, 1)) * 100);
  if (c === 0) return used > 0 ? 100 : 0;
  return Math.min(100, Math.round((used / c) * 100));
}

export const STATUS_STYLES: Record<string, string> = {
  active: "border-ok/40 bg-ok/10 text-ok",
  trial: "border-brass/40 bg-brass/10 text-brass",
  overdue: "border-warn/50 bg-warn/10 text-warn",
  suspended: "border-danger/40 bg-danger/10 text-danger",
  cancelled: "border-line-strong bg-plaster text-muted-ink",
  paused: "border-warn/40 bg-warn/10 text-warn",
  deleted: "border-line-strong bg-plaster text-muted-ink",
  paid: "border-ok/40 bg-ok/10 text-ok",
  pending: "border-brass/40 bg-brass/10 text-brass",
  refunded: "border-line-strong bg-plaster text-muted-ink",
  open: "border-danger/40 bg-danger/10 text-danger",
  in_progress: "border-brass/40 bg-brass/10 text-brass",
  waiting: "border-warn/40 bg-warn/10 text-warn",
  resolved: "border-ok/40 bg-ok/10 text-ok",
  closed: "border-line-strong bg-plaster text-muted-ink",
  urgent: "border-danger/50 bg-danger/10 text-danger",
  high: "border-warn/50 bg-warn/10 text-warn",
  normal: "border-line-strong bg-plaster text-muted-ink",
  low: "border-line-strong bg-plaster text-muted-ink",
};

export function StatusBadge({ status, className = "" }: { status: string; className?: string }) {
  const label = status.replace(/_/g, " ");
  const style = STATUS_STYLES[status] ?? "border-line-strong bg-plaster text-muted-ink";
  const dot =
    status === "active" || status === "paid" || status === "resolved"
      ? "bg-ok"
      : status === "trial" || status === "pending" || status === "in_progress"
        ? "bg-brass"
        : status === "overdue" || status === "paused" || status === "waiting" || status === "high"
          ? "bg-warn"
          : status === "suspended" || status === "open" || status === "urgent"
            ? "bg-danger"
            : "bg-line-strong";
  return (
    <span className={`badge capitalize ${style} ${className}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot} shrink-0`} aria-hidden />
      {label}
    </span>
  );
}

export function HealthDot({ score }: { score: number }) {
  const color = score >= 75 ? "bg-ok" : score >= 50 ? "bg-warn" : "bg-danger";
  return (
    <span className="inline-flex items-center gap-1.5" title={`Health score ${score}/100`}>
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className="text-xs font-medium text-ink">{score}</span>
    </span>
  );
}

export function EmptyState({ icon: Icon, title, hint }: { icon: React.ComponentType<{ className?: string }>; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <span className="h-11 w-11 rounded-full bg-brass-50 border border-brass/25 flex items-center justify-center mb-3">
        <Icon className="h-5 w-5 text-brass" />
      </span>
      <p className="text-sm font-medium text-pine">{title}</p>
      {hint && <p className="text-xs text-muted-ink mt-1 max-w-xs leading-relaxed">{hint}</p>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-10 gap-2.5">
      <span className="h-4 w-4 rounded-full border-2 border-brass border-t-transparent animate-spin" aria-hidden />
      <span className="text-sm text-muted-ink">{label}</span>
    </div>
  );
}

/** Error banner with retry. */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <p className="text-sm text-danger">{message}</p>
      {onRetry && (
        <button className="btn-outline h-8" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/* ─── Premium primitives (Task 24) — additive, used by the redesigned shell/dashboard ─── */

/** Page heading with an optional Great Vibes eyebrow script. */
export function PageHeading({
  eyebrow,
  title,
  sub,
  actions,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
      <div className="min-w-0">
        {eyebrow && <p className="font-script text-brass text-xl leading-none mb-1">{eyebrow}</p>}
        <h1 className="section-title text-xl">{title}</h1>
        {sub && <p className="text-xs text-muted-ink mt-0.5">{sub}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

const STAT_TONES = {
  brass: "icon-chip",
  pine: "icon-chip-pine",
  ok: "h-9 w-9 rounded-md flex items-center justify-center shrink-0 bg-ok/10 border border-ok/25 text-ok",
  warn: "h-9 w-9 rounded-md flex items-center justify-center shrink-0 bg-warn/10 border border-warn/25 text-warn",
  danger: "h-9 w-9 rounded-md flex items-center justify-center shrink-0 bg-danger/10 border border-danger/25 text-danger",
} as const;

/** Premium KPI stat card — brass hairline warms on hover, optional icon chip + trend line. */
export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "brass",
  valueClass = "",
  onClick,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: React.ComponentType<{ className?: string }>;
  tone?: keyof typeof STAT_TONES;
  valueClass?: string;
  onClick?: () => void;
}) {
  const Wrapper = onClick ? "button" : "div";
  return (
    <Wrapper
      {...(onClick ? { type: "button" as const, onClick } : {})}
      className="stat-card text-left w-full"
      aria-label={onClick ? `${label}: ${value}` : undefined}
    >
      <div className="flex items-start justify-between gap-2 min-h-9">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink pt-0.5">{label}</p>
        {Icon && (
          <span className={STAT_TONES[tone]}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <p className={`kpi-value mt-1.5 ${valueClass}`}>{value}</p>
      {sub && <p className="text-[11px] text-muted-ink mt-0.5 leading-snug">{sub}</p>}
    </Wrapper>
  );
}

/** Severity chip with icon — for alert lists. */
export function SeverityChip({ severity, kind }: { severity: string; kind?: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    info: { cls: "border-pine-600/30 bg-pine-100/60 text-pine-700", label: "Info" },
    warn: { cls: "border-warn/40 bg-warn/10 text-warn", label: "Warning" },
    danger: { cls: "border-danger/40 bg-danger/10 text-danger", label: "Urgent" },
  };
  const s = map[severity] ?? map.info;
  return (
    <span className={`badge ${s.cls} uppercase tracking-wider`} title={kind}>
      {s.label}
    </span>
  );
}
