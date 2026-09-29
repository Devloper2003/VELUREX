"use client";

import { useCallback, useEffect, useState } from "react";
import { ScrollText, Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useOwnerApi, fmtDateTime, EmptyState, Loading, ErrorState } from "@/components/owner/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AuditLogRow {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  propertyId: string;
  createdAt: string;
}

interface AuditResponse {
  logs: AuditLogRow[];
  total: number;
  page: number;
  pages: number;
  actions: { action: string; count: number }[];
}

/** Accent classes for sensitive actions. */
function actionAccent(action: string): { row: string; badge: string } {
  if (action.startsWith("IMPERSONATE_")) {
    return { row: "border-l-2 border-l-danger", badge: "border-danger/50 bg-danger/10 text-danger" };
  }
  if (action.includes("SUSPEND")) {
    return { row: "border-l-2 border-l-warn", badge: "border-warn/50 bg-warn/10 text-warn" };
  }
  if (action.includes("REFUND")) {
    return { row: "border-l-2 border-l-warn", badge: "border-warn/50 bg-warn/10 text-warn" };
  }
  return { row: "border-l-2 border-l-transparent", badge: "border-line-strong bg-plaster text-pine" };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function AuditView() {
  const api = useOwnerApi();

  const [data, setData] = useState<AuditResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [action, setAction] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<AuditLogRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
      if (action) qs.set("action", action);
      if (search.trim()) qs.set("search", search.trim());
      const res = await api<AuditResponse>(`/api/owner/audit?${qs.toString()}`);
      setData(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api, page, action, search]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel p-3 flex flex-wrap items-center gap-2">
        <Select
          value={action || "all"}
          onValueChange={(v) => { setAction(v === "all" ? "" : v); setPage(1); }}
        >
          <SelectTrigger className="w-64 h-9"><SelectValue placeholder="All actions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All actions</SelectItem>
            {(data?.actions ?? []).map((a) => (
              <SelectItem key={a.action} value={a.action}>
                {a.action} <span className="text-muted-ink">({a.count})</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="h-3.5 w-3.5 text-muted-ink absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            className="w-64 h-9 pl-8"
            placeholder="Search actor, entity or details…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <div className="flex-1" />
        <p className="text-xs text-muted-ink">{data ? `${data.total} entr${data.total === 1 ? "y" : "ies"}` : "…"}</p>
      </div>

      {/* Log table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><ScrollText className="h-4 w-4 text-brass" /> Platform audit trail</p>
          <p className="text-xs text-muted-ink">Impersonation, suspension and refund rows are highlighted</p>
        </div>
        {loading ? (
          <Loading label="Loading audit trail…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !data || data.logs.length === 0 ? (
          <EmptyState icon={ScrollText} title="No audit entries match" hint="Try a different action filter or clear the search." />
        ) : (
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[820px]">
              <thead>
                <tr>
                  <th className="th">When</th>
                  <th className="th">Actor</th>
                  <th className="th">Action</th>
                  <th className="th">Entity</th>
                  <th className="th">Details</th>
                </tr>
              </thead>
              <tbody>
                {data.logs.map((log) => {
                  const accent = actionAccent(log.action);
                  return (
                    <tr
                      key={log.id}
                      className={`cursor-pointer hover:bg-plaster/60 transition ${accent.row}`}
                      onClick={() => setDetail(log)}
                      title="Click for full details"
                    >
                      <td className="td whitespace-nowrap text-muted-ink">{fmtDateTime(log.createdAt)}</td>
                      <td className="td max-w-40"><span className="block truncate" title={log.actorName}>{log.actorName || log.actorId}</span></td>
                      <td className="td">
                        <span className={`badge font-mono text-[10px] ${accent.badge}`}>{log.action}</span>
                      </td>
                      <td className="td text-muted-ink">{log.entity}</td>
                      <td className="td max-w-96">
                        <span className="block truncate" title={log.details}>{log.details}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-line">
            <p className="text-xs text-muted-ink">Page {data.page} of {data.pages}</p>
            <div className="flex gap-2">
              <button className="btn-outline h-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>
              <button className="btn-outline h-8" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Detail dialog */}
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-base">{detail?.action}</DialogTitle>
            <DialogDescription>
              {detail ? `${detail.entity} · ${fmtDateTime(detail.createdAt)}` : ""}
            </DialogDescription>
          </DialogHeader>
          {detail && (
            <div className="space-y-2 text-sm">
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <p className="field-label">Actor</p>
                  <p className="text-ink break-words">{detail.actorName || detail.actorId}</p>
                </div>
                <div>
                  <p className="field-label">Entity ID</p>
                  <p className="font-mono text-xs text-muted-ink break-all">{detail.entityId || "—"}</p>
                </div>
                <div>
                  <p className="field-label">Property</p>
                  <p className="font-mono text-xs text-muted-ink break-all">{detail.propertyId || "platform"}</p>
                </div>
              </div>
              <div>
                <p className="field-label">Details</p>
                <p className="text-ink whitespace-pre-line rounded-md border border-line bg-plaster/50 p-3">{detail.details || "—"}</p>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
