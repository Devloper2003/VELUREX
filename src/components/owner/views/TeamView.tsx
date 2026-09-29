"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  UserCog, Users, UserPlus, UserCheck, UserX, ShieldCheck, ShieldAlert,
  KeyRound, LogOut, Copy, RefreshCw, MoreHorizontal, Clock3, BadgeCheck,
  Mail, Eye, EyeOff, Loader2, AlertTriangle, ScrollText, Lock,
} from "lucide-react";
import { useOwnerApi, fmtDate, fmtDateTime, relativeDays, Loading, ErrorState, StatusBadge } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import { useSession } from "@/lib/store";
import {
  TEAM_INVITABLE_ROLES, PLATFORM_ROLE_LABELS, PLATFORM_ROLE_DESCRIPTIONS,
  type PlatformRole,
} from "@/lib/owner-roles";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Member {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  mustChangePassword: boolean;
  isDemo: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

function initials(name: string): string {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

const ROLE_BADGE: Record<string, string> = {
  software_owner: "border-brass/50 bg-brass/10 text-brass",
  platform_admin: "border-ok/40 bg-ok/10 text-ok",
  platform_support: "border-warn/40 bg-warn/10 text-warn",
  platform_finance: "border-pine-600/30 bg-pine-100/60 text-pine-700",
};

// ─── View ────────────────────────────────────────────────────────────────────

export default function TeamView() {
  const api = useOwnerApi();
  const { toast } = useToast();
  const sessionUser = useSession((s) => s.user);

  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Invite dialog
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invName, setInvName] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState<string>("platform_admin");
  const [invErr, setInvErr] = useState("");
  const [invBusy, setInvBusy] = useState(false);

  // Temp-password reveal (invite or reset) — shown exactly once
  const [pwdShown, setPwdShown] = useState<{ name: string; email: string; tempPassword: string } | null>(null);
  const [pwdVisible, setPwdVisible] = useState(false);

  // Role change dialog
  const [roleTarget, setRoleTarget] = useState<Member | null>(null);
  const [rolePick, setRolePick] = useState<string>("");
  const [roleBusy, setRoleBusy] = useState(false);

  // Deactivate confirm
  const [deactTarget, setDeactTarget] = useState<Member | null>(null);
  // Remove confirm
  const [removeTarget, setRemoveTarget] = useState<Member | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const d = await api<{ members: Member[] }>("/api/owner/team");
      setMembers(d.members ?? []);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const stats = useMemo(() => {
    const m = members ?? [];
    return {
      total: m.length,
      active: m.filter((x) => x.active).length,
      pendingSetup: m.filter((x) => x.mustChangePassword && x.active).length,
      deactivated: m.filter((x) => !x.active).length,
    };
  }, [members]);

  async function submitInvite(e: React.FormEvent) {
    e.preventDefault();
    setInvErr("");
    if (invName.trim().length < 2) { setInvErr("Enter the member's full name"); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(invEmail.trim())) { setInvErr("Enter a valid email address"); return; }
    setInvBusy(true);
    try {
      const r = await api<{ tempPassword: string }>("/api/owner/team", {
        method: "POST",
        body: JSON.stringify({ name: invName.trim(), email: invEmail.trim().toLowerCase(), role: invRole }),
      });
      setInviteOpen(false);
      setPwdVisible(false);
      setPwdShown({ name: invName.trim(), email: invEmail.trim().toLowerCase(), tempPassword: r.tempPassword });
      setInvName(""); setInvEmail(""); setInvRole("platform_admin");
      toast({ title: "Team member invited", description: "Share the temporary password — it is shown only once." });
      await load();
    } catch (e2) {
      setInvErr(errText(e2));
    } finally {
      setInvBusy(false);
    }
  }

  async function patchMember(m: Member, body: Record<string, unknown>, okMsg?: string) {
    setBusyId(m.id);
    try {
      await api(`/api/owner/team/${m.id}`, { method: "PATCH", body: JSON.stringify(body) });
      if (okMsg) toast({ title: okMsg });
      await load();
      return true;
    } catch (e) {
      toast({ title: "Action failed", description: errText(e), variant: "destructive" });
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function resetPassword(m: Member) {
    setBusyId(m.id);
    try {
      const r = await api<{ tempPassword: string }>(`/api/owner/team/${m.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "reset_password" }),
      });
      setPwdVisible(false);
      setPwdShown({ name: m.name, email: m.email, tempPassword: r.tempPassword });
      await load();
    } catch (e) {
      toast({ title: "Password reset failed", description: errText(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function copyPwd() {
    if (!pwdShown) return;
    try {
      await navigator.clipboard.writeText(pwdShown.tempPassword);
      toast({ title: "Copied", description: "Temporary password is on your clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the password text and copy manually.", variant: "destructive" });
    }
  }

  async function confirmRoleChange() {
    if (!roleTarget || !rolePick) return;
    setRoleBusy(true);
    const ok = await patchMember(roleTarget, { action: "update", role: rolePick }, "Role updated");
    setRoleBusy(false);
    if (ok) setRoleTarget(null);
  }

  async function confirmDeactivate() {
    if (!deactTarget) return;
    const ok = await patchMember(deactTarget, { action: "deactivate" }, "Member deactivated");
    setDeactTarget(null);
    void ok;
  }

  async function confirmRemove() {
    if (!removeTarget) return;
    setBusyId(removeTarget.id);
    try {
      await api(`/api/owner/team/${removeTarget.id}`, { method: "DELETE" });
      toast({ title: "Member removed" });
      setRemoveTarget(null);
      await load();
    } catch (e) {
      toast({ title: "Remove failed", description: errText(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  const kpiCards = [
    { label: "Members", value: stats.total, icon: Users, tone: "pine" as const },
    { label: "Active", value: stats.active, icon: UserCheck, tone: "ok" as const },
    { label: "Password setup pending", value: stats.pendingSetup, icon: KeyRound, tone: "brass" as const },
    { label: "Deactivated", value: stats.deactivated, icon: UserX, tone: "danger" as const },
  ];

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {kpiCards.map((k) => (
          <div key={k.label} className="stat-card">
            <div className="flex items-center justify-between gap-2 min-h-9">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink pt-0.5">{k.label}</p>
              <span className={`h-9 w-9 rounded-md flex items-center justify-center shrink-0 ${
                k.tone === "pine" ? "icon-chip-pine" : k.tone === "ok" ? "bg-ok/10 border border-ok/25 text-ok"
                : k.tone === "brass" ? "icon-chip" : "bg-danger/10 border border-danger/25 text-danger"
              }`}>
                <k.icon className="h-4 w-4" />
              </span>
            </div>
            <p className="kpi-value mt-1.5">{k.value}</p>
          </div>
        ))}
      </div>

      {/* Roster */}
      <div className="panel">
        <div className="panel-header flex-wrap gap-3">
          <div>
            <p className="panel-title flex items-center gap-2">
              <UserCog className="h-4 w-4 text-brass" /> Platform team
            </p>
            <p className="text-xs text-muted-ink mt-0.5">
              Members sign in on the same login page · temporary passwords force a permanent reset on first login
            </p>
          </div>
          <div className="flex items-center gap-2 ml-auto">
            <button className="btn-ghost h-8" onClick={() => void load()} aria-label="Refresh team roster">
              <RefreshCw className="h-4 w-4" />
            </button>
            <button className="btn-pine h-9 px-3 text-[13px]" onClick={() => { setInviteOpen(true); setInvErr(""); }}>
              <UserPlus className="h-4 w-4" /> Invite member
            </button>
          </div>
        </div>

        {loading ? (
          <Loading label="Loading team roster…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : (members ?? []).length === 0 ? (
          <div className="p-8" />
        ) : (
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full text-sm min-w-[860px]">
              <thead>
                <tr className="th-row">
                  <th className="th">Member</th>
                  <th className="th">Role</th>
                  <th className="th">Status</th>
                  <th className="th">Last login</th>
                  <th className="th">Joined</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line/70">
                {(members ?? []).map((m) => {
                  const self = m.id === sessionUser?.id;
                  const ownerAcc = m.role === "software_owner";
                  const canRemove = !m.active && !m.lastLoginAt && !ownerAcc && !self;
                  return (
                    <tr key={m.id} className="tr-hover">
                      <td className="td">
                        <div className="flex items-center gap-2.5">
                          <span className={`h-9 w-9 rounded-full flex items-center justify-center text-[12px] font-semibold shrink-0 ${
                            ownerAcc ? "bg-pine-700 text-panel ring-1 ring-brass-light/40" : "bg-plaster-deep text-pine border border-line"
                          }`}>
                            {initials(m.name)}
                          </span>
                          <div className="min-w-0">
                            <p className="font-medium text-pine flex items-center gap-1.5">
                              <span className="truncate max-w-[180px]">{m.name}</span>
                              {self && <span className="badge border-brass/40 bg-brass/10 text-brass text-[9px]">You</span>}
                            </p>
                            <p className="text-xs text-muted-ink truncate max-w-[220px] flex items-center gap-1">
                              <Mail className="h-3 w-3 shrink-0" /> {m.email}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="td">
                        <span className={`badge ${ROLE_BADGE[m.role] ?? "border-line-strong bg-plaster text-muted-ink"}`}>
                          {ownerAcc ? <ShieldCheck className="h-3 w-3" /> : <ShieldAlert className="h-3 w-3" />}
                          {PLATFORM_ROLE_LABELS[m.role as PlatformRole] ?? m.role}
                        </span>
                      </td>
                      <td className="td">
                        {ownerAcc ? (
                          <StatusBadge status="active" />
                        ) : !m.active ? (
                          <StatusBadge status="suspended" />
                        ) : m.mustChangePassword ? (
                          <span className="badge border-warn/40 bg-warn/10 text-warn" title="Temporary password active — permanent reset required on first login">
                            <KeyRound className="h-3 w-3" /> Setup pending
                          </span>
                        ) : (
                          <StatusBadge status="active" />
                        )}
                      </td>
                      <td className="td">
                        {m.lastLoginAt ? (
                          <span className="text-[13px] text-ink flex items-center gap-1.5">
                            <Clock3 className="h-3.5 w-3.5 text-muted-ink shrink-0" />
                            {relativeDays(m.lastLoginAt)}
                            <span className="text-[11px] text-muted-ink hidden xl:inline">· {fmtDateTime(m.lastLoginAt)}</span>
                          </span>
                        ) : (
                          <span className="text-xs text-muted-ink italic">Never signed in</span>
                        )}
                      </td>
                      <td className="td text-[13px] text-muted-ink">{fmtDate(m.createdAt)}</td>
                      <td className="td text-right">
                        {ownerAcc ? (
                          <span className="text-[11px] text-muted-ink inline-flex items-center gap-1" title="The account holder — immutable from Team & Roles">
                            <Lock className="h-3 w-3" /> Account holder
                          </span>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button className="btn-ghost h-8 w-8 p-0" aria-label={`Actions for ${m.name}`} disabled={busyId === m.id}>
                                {busyId === m.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <MoreHorizontal className="h-4 w-4" />}
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-56">
                              {!self && (
                                <DropdownMenuItem onClick={() => { setRoleTarget(m); setRolePick(m.role); }}>
                                  <ShieldAlert className="h-4 w-4 text-brass" /> Change role
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => void resetPassword(m)}>
                                <KeyRound className="h-4 w-4 text-brass" /> Reset to temp password
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={async () => { await patchMember(m, { action: "force_logout" }, "Sessions terminated"); }}>
                                <LogOut className="h-4 w-4 text-muted-ink" /> Force logout
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {!self && m.active && (
                                <DropdownMenuItem className="text-warn focus:text-warn" onClick={() => setDeactTarget(m)}>
                                  <UserX className="h-4 w-4" /> Deactivate
                                </DropdownMenuItem>
                              )}
                              {!self && !m.active && (
                                <DropdownMenuItem className="text-ok focus:text-ok" onClick={async () => { await patchMember(m, { action: "activate" }, "Member activated"); }}>
                                  <UserCheck className="h-4 w-4" /> Activate
                                </DropdownMenuItem>
                              )}
                              {canRemove && (
                                <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setRemoveTarget(m)}>
                                  <AlertTriangle className="h-4 w-4" /> Remove permanently
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Roles & permissions matrix */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><ScrollText className="h-4 w-4 text-brass" /> Roles &amp; permissions</p>
          <p className="text-xs text-muted-ink">Enforced on every API call — denied actions return 403, and every member action is audited</p>
        </div>
        <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          {(Object.keys(PLATFORM_ROLE_DESCRIPTIONS) as PlatformRole[]).map((r) => (
            <div key={r} className={`rounded-md border p-3 ${r === "software_owner" ? "border-brass/40 bg-brass/5" : "border-line bg-plaster/40"}`}>
              <div className="flex items-center gap-2">
                <span className={`badge ${ROLE_BADGE[r] ?? ""}`}>{PLATFORM_ROLE_LABELS[r]}</span>
                {r === "software_owner" && (
                  <span className="text-[10px] text-muted-ink flex items-center gap-1"><Lock className="h-3 w-3" /> you</span>
                )}
              </div>
              <p className="text-xs text-muted-ink mt-1.5 leading-relaxed">{PLATFORM_ROLE_DESCRIPTIONS[r]}</p>
            </div>
          ))}
        </div>
      </div>

      {/* ── Invite dialog ── */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <UserPlus className="h-4.5 w-4.5 text-brass" style={{ width: 18, height: 18 }} /> Invite team member
            </DialogTitle>
            <DialogDescription>
              An account is created with a temporary password. The member signs in with it and must set a permanent password before using the console.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={submitInvite} className="space-y-3.5">
            <div>
              <label className="field-label" htmlFor="inv-name">Full name</label>
              <input id="inv-name" className="field" value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="e.g. Priya Nair" autoFocus />
            </div>
            <div>
              <label className="field-label" htmlFor="inv-email">Email</label>
              <input id="inv-email" type="email" className="field" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="name@velurexhms.in" />
            </div>
            <div>
              <label className="field-label">Role</label>
              <Select value={invRole} onValueChange={setInvRole}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {TEAM_INVITABLE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>{PLATFORM_ROLE_LABELS[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-ink mt-1.5 leading-relaxed">{PLATFORM_ROLE_DESCRIPTIONS[invRole as PlatformRole]}</p>
            </div>
            {invErr && (
              <p className="text-[12px] text-danger flex items-center gap-1.5"><AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {invErr}</p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" className="btn-outline" onClick={() => setInviteOpen(false)}>Cancel</button>
              <button type="submit" className="btn-pine" disabled={invBusy}>
                {invBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />}
                Create account
              </button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Temp password reveal (once) ── */}
      <Dialog open={!!pwdShown} onOpenChange={(o) => { if (!o) setPwdShown(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display flex items-center gap-2">
              <KeyRound className="text-brass" style={{ width: 18, height: 18 }} /> Temporary password
            </DialogTitle>
            <DialogDescription>
              For <span className="font-medium text-ink">{pwdShown?.name}</span> &lt;{pwdShown?.email}&gt; — valid until they set a permanent password.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-brass/40 bg-brass/5 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <code className="font-mono text-base font-semibold tracking-wider text-pine select-all">
                {pwdVisible ? pwdShown?.tempPassword : "••••••••••••"}
              </code>
              <div className="flex items-center gap-1">
                <button type="button" className="btn-ghost h-8 w-8 p-0" onClick={() => setPwdVisible((v) => !v)} aria-label={pwdVisible ? "Hide password" : "Show password"}>
                  {pwdVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
                <button type="button" className="btn-outline h-8" onClick={() => void copyPwd()}>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              </div>
            </div>
            <p className="text-[11px] text-muted-ink mt-2.5 flex items-start gap-1.5 leading-relaxed">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-warn" />
              Shown only once — it is stored encrypted (hashed) and cannot be retrieved again. Share it over a secure channel; the member must set a permanent password on first login.
            </p>
          </div>
          <div className="flex justify-end">
            <button className="btn-pine" onClick={() => setPwdShown(null)}>
              <BadgeCheck className="h-4 w-4" /> Done
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Role change dialog ── */}
      <Dialog open={!!roleTarget} onOpenChange={(o) => { if (!o) setRoleTarget(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Change role — {roleTarget?.name}</DialogTitle>
            <DialogDescription>{roleTarget?.email}</DialogDescription>
          </DialogHeader>
          <div>
            <label className="field-label">New role</label>
            <Select value={rolePick} onValueChange={setRolePick}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {TEAM_INVITABLE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>{PLATFORM_ROLE_LABELS[r]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-ink mt-1.5 leading-relaxed">{PLATFORM_ROLE_DESCRIPTIONS[rolePick as PlatformRole]}</p>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-outline" onClick={() => setRoleTarget(null)}>Cancel</button>
            <button className="btn-pine" disabled={roleBusy || !rolePick || rolePick === roleTarget?.role} onClick={() => void confirmRoleChange()}>
              {roleBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Update role
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Deactivate confirm ── */}
      <AlertDialog open={!!deactTarget} onOpenChange={(o) => { if (!o) setDeactTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate {deactTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Sign-in is blocked immediately and their open tabs are signed out. History and audit entries are kept — you can reactivate at any time.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-warn text-white hover:bg-warn/90" onClick={() => void confirmDeactivate()}>
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Remove confirm ── */}
      <AlertDialog open={!!removeTarget} onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removeTarget?.name} permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the account record. Only members who never signed in can be removed — anyone else should be deactivated instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-danger text-white hover:bg-danger/90" onClick={() => void confirmRemove()}>
              Remove member
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
