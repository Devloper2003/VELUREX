"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ChevronLeft, ChevronRight, Clock3, Copy, History, KeyRound, MoreVertical,
  Search, ShieldCheck, UserCheck, Users, UserX,
} from "lucide-react";
import {
  useOwnerApi, fmtDateTime, relativeDays, StatusBadge, EmptyState, Loading, ErrorState, StatCard, usePolling,
} from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/* ─── types (API contracts) ──────────────────────────────────────────────── */

interface UserProperty { id: string; name: string; city: string; subscriptionStatus: string }

interface UserRow {
  id: string; name: string; email: string; phone: string;
  role: string; active: boolean; mustChangePassword?: boolean;
  lastLoginAt: string | null; recentLogin: string | null;
  property: UserProperty | null; createdAt: string;
}

interface UsersResp { users: UserRow[]; total: number; page: number; pageSize: number; pages: number }

interface UserDetail {
  user: UserRow & { googleEmail: string | null };
  loginHistory: { at: string; details: string }[];
}

const ROLES = ["hotel_admin", "front_desk", "housekeeping", "restaurant_staff"] as const;

const ROLE_STYLES: Record<string, string> = {
  hotel_admin: "border-pine-700/40 bg-pine-100 text-pine-700",
  front_desk: "border-brass/40 bg-brass-50 text-brass",
  housekeeping: "border-ok/40 bg-ok/10 text-ok",
  restaurant_staff: "border-warn/40 bg-warn/10 text-warn",
};

const AVATAR_STYLES: Record<string, string> = {
  hotel_admin: "bg-pine-100 text-pine-700",
  front_desk: "bg-brass-50 text-brass",
  housekeeping: "bg-ok/10 text-ok",
  restaurant_staff: "bg-warn/10 text-warn",
};

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase() || "?";
}

export default function UsersView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  /* KPIs */
  const [kpis, setKpis] = useState({ total: 0, active: 0, admins: 0, last7: 0 });

  /* list */
  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  /* filters */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");

  /* actions */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyTarget, setHistoryTarget] = useState<UserRow | null>(null);
  const [history, setHistory] = useState<UserDetail | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [forceTarget, setForceTarget] = useState<UserRow | null>(null);
  const [pwdShown, setPwdShown] = useState<{ user: UserRow; tempPassword: string } | null>(null);

  const pageSize = 12;

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (search) qs.set("search", search);
      if (roleFilter !== "all") qs.set("role", roleFilter);
      if (statusFilter !== "all") qs.set("status", statusFilter);
      const d = await api<UsersResp>(`/api/owner/users?${qs.toString()}`);
      setRows(d.users ?? []);
      setTotal(d.total ?? 0);
      setPages(Math.max(1, d.pages ?? 1));
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [api, search, roleFilter, statusFilter, page]);

  const loadKpis = useCallback(async () => {
    try {
      const [all, activeR, adminR, recent] = await Promise.all([
        api<UsersResp>("/api/owner/users?pageSize=1"),
        api<UsersResp>("/api/owner/users?status=active&pageSize=1"),
        api<UsersResp>("/api/owner/users?role=hotel_admin&pageSize=1"),
        api<UsersResp>("/api/owner/users?pageSize=50"),
      ]);
      const weekAgo = Date.now() - 7 * 86400000;
      setKpis({
        total: all.total ?? 0,
        active: activeR.total ?? 0,
        admins: adminR.total ?? 0,
        last7: (recent.users ?? []).filter((u) => u.recentLogin && new Date(u.recentLogin).getTime() >= weekAgo).length,
      });
    } catch { /* KPI refresh is non-critical */ }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadKpis(); }, [loadKpis]);
  usePolling(() => { void load(); }, 45000);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);
  useEffect(() => { setPage(1); }, [search, roleFilter, statusFilter]);

  const runAction = async (u: UserRow, action: string, done: string) => {
    setBusyId(u.id);
    try {
      await api<{ ok: boolean }>(`/api/owner/users/${u.id}`, { method: "PATCH", body: JSON.stringify({ action }) });
      toast({ title: done, description: `${u.name} · ${u.email}` });
      await Promise.all([load(), loadKpis()]);
    } catch (e) {
      toast({ title: "Action failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const resetPassword = async (u: UserRow) => {
    setBusyId(u.id);
    try {
      const r = await api<{ ok: boolean; tempPassword: string }>(
        `/api/owner/users/${u.id}`,
        { method: "PATCH", body: JSON.stringify({ action: "reset_password" }) }
      );
      setPwdShown({ user: u, tempPassword: r.tempPassword });
    } catch (e) {
      toast({ title: "Password reset failed", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = async (u: UserRow) => {
    setHistoryTarget(u);
    setHistory(null);
    setHistoryLoading(true);
    try {
      const d = await api<UserDetail>(`/api/owner/users/${u.id}`);
      setHistory(d);
    } catch (e) {
      toast({ title: "Could not load login history", description: String((e as Error).message), variant: "destructive" });
      setHistoryTarget(null);
    } finally {
      setHistoryLoading(false);
    }
  };

  const copyTemp = async () => {
    if (!pwdShown) return;
    try {
      await navigator.clipboard.writeText(pwdShown.tempPassword);
      toast({ title: "Copied", description: "Temp password is on your clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the password text and copy manually.", variant: "destructive" });
    }
  };

  const kpiCards = [
    { label: "Total users", value: kpis.total, icon: Users, tone: "pine" as const },
    { label: "Active", value: kpis.active, icon: UserCheck, tone: "ok" as const },
    { label: "Admins", value: kpis.admins, icon: ShieldCheck, tone: "brass" as const },
    { label: "Logged in last 7d", value: kpis.last7, icon: Clock3, tone: "pine" as const },
  ];

  const hasFilters = search !== "" || roleFilter !== "all" || statusFilter !== "all";

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {kpiCards.map((k) => (
          <StatCard key={k.label} label={k.label} value={String(k.value)} icon={k.icon} tone={k.tone} />
        ))}
      </div>

      {/* toolbar */}
      <div className="panel p-3 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink pointer-events-none" />
          <input
            className="field pl-9"
            placeholder="Search users by name or email…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            aria-label="Search users"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={roleFilter} onValueChange={setRoleFilter}>
            <SelectTrigger className="w-[170px] h-9" aria-label="Filter by role">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r} className="capitalize">{r.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[150px] h-9" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* table */}
      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title flex items-center gap-2"><Users className="h-4 w-4 text-brass" /> Users</h2>
          <span className="text-xs text-muted-ink">{total} across all businesses</span>
        </div>
        {loading ? (
          <Loading label="Loading users…" />
        ) : err ? (
          <ErrorState message={err} onRetry={() => void load()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={Users}
            title={hasFilters ? "No users match these filters" : "No users yet"}
            hint={hasFilters ? "Try clearing the search or switching the role/status filters." : "Users are created when businesses are onboarded."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">User</th>
                  <th className="th">Business</th>
                  <th className="th">Role</th>
                  <th className="th">Status</th>
                  <th className="th">Last login</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id} className="hover:bg-plaster/40 transition">
                    <td className="td">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className={`h-8 w-8 rounded-full flex items-center justify-center text-[11px] font-semibold shrink-0 ${AVATAR_STYLES[u.role] ?? "bg-plaster text-muted-ink"}`}>
                          {initials(u.name)}
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5 min-w-0">
                            <span className="block text-sm font-medium text-pine truncate max-w-[200px]">{u.name}</span>
                            {u.mustChangePassword && (
                              <span className="badge border-warn/40 bg-warn/10 text-warn shrink-0" title="Signed in on a temporary password — must set a permanent one on first login">
                                Temp password
                              </span>
                            )}
                          </span>
                          <span className="block text-[11px] text-muted-ink truncate max-w-[200px]">{u.email}</span>
                        </span>
                      </div>
                    </td>
                    <td className="td">
                      {u.property ? (
                        <>
                          <span className="block text-[13px] text-ink">{u.property.name}</span>
                          <span className="block text-[11px] text-muted-ink">{u.property.city || "—"}</span>
                        </>
                      ) : (
                        <span className="text-muted-ink text-xs">—</span>
                      )}
                    </td>
                    <td className="td">
                      <span className={`badge capitalize ${ROLE_STYLES[u.role] ?? "border-line-strong bg-plaster text-muted-ink"}`}>
                        {u.role.replace(/_/g, " ")}
                      </span>
                    </td>
                    <td className="td">
                      {u.active ? (
                        <StatusBadge status="active" />
                      ) : (
                        <span className="badge border-line-strong bg-plaster text-muted-ink">Inactive</span>
                      )}
                    </td>
                    <td className="td whitespace-nowrap text-[13px]">
                      {u.lastLoginAt ? (
                        <>
                          <span className="text-ink">{fmtDateTime(u.lastLoginAt)}</span>
                          <span className="block text-[11px] text-muted-ink">{relativeDays(u.lastLoginAt)}</span>
                        </>
                      ) : (
                        <span className="text-muted-ink">never</span>
                      )}
                    </td>
                    <td className="td text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="btn-ghost h-8 w-8 p-0" aria-label={`Actions for ${u.name}`} disabled={busyId === u.id}>
                            <MoreVertical className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => void openHistory(u)}>
                            <History className="h-3.5 w-3.5 mr-2" /> View login history
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void resetPassword(u)}>
                            <KeyRound className="h-3.5 w-3.5 mr-2" /> Reset password
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => setForceTarget(u)}>
                            <UserX className="h-3.5 w-3.5 mr-2" /> Force logout
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          {u.active ? (
                            <DropdownMenuItem onClick={() => void runAction(u, "deactivate", "User deactivated")} className="text-danger focus:text-danger">
                              <UserX className="h-3.5 w-3.5 mr-2" /> Deactivate
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem onClick={() => void runAction(u, "activate", "User activated")} className="text-ok focus:text-ok">
                              <UserCheck className="h-3.5 w-3.5 mr-2" /> Activate
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* pagination footer */}
        {!loading && !err && rows.length > 0 && (
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-line">
            <span className="text-xs text-muted-ink">
              Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
            </span>
            <div className="flex items-center gap-2">
              <button className="btn-outline h-8" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                <ChevronLeft className="h-3.5 w-3.5" /> Prev
              </button>
              <span className="text-xs text-muted-ink tabular-nums">Page {page} / {pages}</span>
              <button className="btn-outline h-8" disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))}>
                Next <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* login history dialog */}
      <Dialog open={historyTarget !== null} onOpenChange={(o) => { if (!o) setHistoryTarget(null); }}>
        <DialogContent className="max-w-lg bg-panel">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">
              Login history — {historyTarget?.name}
            </DialogTitle>
            <DialogDescription>
              {historyTarget?.email}
              {history?.user.property ? ` · ${history.user.property.name}` : ""}
              {history?.user.googleEmail ? ` · Google: ${history.user.googleEmail}` : ""}
            </DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <Loading label="Loading history…" />
          ) : history && history.loginHistory.length > 0 ? (
            <div className="space-y-2 max-h-96 overflow-y-auto scroll-slim pr-1">
              {history.loginHistory.map((l, i) => (
                <div key={`${l.at}-${i}`} className="flex items-start gap-2.5 border-b border-line/60 pb-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok mt-1.5 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-[13px] text-ink">{fmtDateTime(l.at)}</p>
                    <p className="text-[11px] text-muted-ink">{l.details || "Session sign-in"}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={Clock3} title="No logins recorded" hint="This user has never signed in yet." />
          )}
        </DialogContent>
      </Dialog>

      {/* temp password dialog — one-time reveal, same pattern as hotel-side Settings → Staff */}
      <Dialog open={pwdShown !== null} onOpenChange={(o) => { if (!o) setPwdShown(null); }}>
        <DialogContent className="max-w-md bg-panel">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">Temporary password for {pwdShown?.user.name}</DialogTitle>
            <DialogDescription>
              {pwdShown?.user.email} · share it with the user over a secure channel — it replaces their old password immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 flex items-start gap-2 text-[13px] text-warn">
            <Clock3 className="h-4 w-4 shrink-0 mt-0.5" />
            <span>This password is shown only once. The user must set a permanent password on first login.</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-line bg-plaster px-3 py-2 font-mono text-[15px] tracking-widest text-pine select-all">
              {pwdShown?.tempPassword}
            </code>
            <button className="btn-outline" onClick={() => void copyTemp()}>
              <Copy className="h-4 w-4" /> Copy
            </button>
          </div>
          <DialogFooter>
            <button className="btn-pine" onClick={() => setPwdShown(null)}>Done</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* force logout confirm */}
      <AlertDialog open={forceTarget !== null} onOpenChange={(o) => { if (!o) setForceTarget(null); }}>
        <AlertDialogContent className="bg-panel">
          <AlertDialogHeader>
            <AlertDialogTitle>Force logout {forceTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              All open sessions of {forceTarget?.email} will be signed out on their next app poll. They can log
              back in immediately with their password. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              onClick={() => { if (forceTarget) void runAction(forceTarget, "force_logout", "Sessions terminated"); setForceTarget(null); }}
            >
              Force logout
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </div>
  );
}
