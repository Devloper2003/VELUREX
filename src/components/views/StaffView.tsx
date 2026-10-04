"use client";

/**
 * Staff Management (HR) — Directory · Attendance · Payroll.
 * Task 35-a. Hotel-admin module: HR profiles, daily attendance with punch
 * clock (Asia/Kolkata business date), and monthly payroll register.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate, fmtTime } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  UsersRound, UserCheck, IndianRupee, CalendarClock, Search, Pencil, LogIn, LogOut,
  RefreshCw, CheckCheck, ChevronDown, ChevronUp, Download, Sparkles, Wallet, Hourglass,
  Receipt, CalendarX, Loader2, StickyNote, BadgeCheck,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ─── Types ───────────────────────────────────────────────────────────────────

interface StaffMember {
  id: string; name: string; email: string; phone: string; role: string;
  designation: string; department: string; salary: number; joinDate: string | null; active: boolean;
}
interface StaffLite {
  id: string; name: string; email: string; role: string; designation: string; department: string; active: boolean;
}
interface AttendanceRow {
  id: string; staffId: string; date: string; status: string;
  checkInAt: string | null; checkOutAt: string | null;
  hoursWorked: number; overtimeHours: number; notes: string; markedBy: string;
}
interface AttSummary {
  present: number; absent: number; leave: number; halfDays: number; late: number; weekOffs: number; pct: number;
}
interface AttBoard {
  month: string; staff: StaffLite[]; rows: AttendanceRow[]; summaries: Record<string, AttSummary>;
}
interface PayrollRec {
  id: string; staffId: string; month: number; year: number;
  baseSalary: number; allowances: number; deductions: number; advance: number; bonus: number; netPay: number;
  presentDays: number; halfDays: number; leaveDays: number; absentDays: number;
  status: string; paidAt: string | null; paidMethod: string; notes: string;
  staff: { name: string; designation: string; department: string; email: string; active: boolean };
}
interface PayrollResp {
  year: number; month: number; records: PayrollRec[];
  summary: { totalNet: number; paid: number; pending: number; headcount: number };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEPARTMENTS = [
  { value: "front_office", label: "Front Office" },
  { value: "housekeeping", label: "Housekeeping" },
  { value: "fnb", label: "F&B" },
  { value: "maintenance", label: "Maintenance" },
  { value: "accounts", label: "Accounts" },
  { value: "other", label: "Other" },
] as const;

const DEPT_LABELS: Record<string, string> = Object.fromEntries(DEPARTMENTS.map((d) => [d.value, d.label]));

const ROLE_LABELS: Record<string, string> = {
  hotel_admin: "Admin",
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  restaurant_staff: "Restaurant",
};

const ATT_STATUSES = [
  { value: "present", label: "Present" },
  { value: "late", label: "Late" },
  { value: "half_day", label: "Half Day" },
  { value: "leave", label: "Leave" },
  { value: "absent", label: "Absent" },
  { value: "week_off", label: "Week Off" },
] as const;

const ATT_BADGE: Record<string, string> = {
  present: "border-ok/40 bg-ok/10 text-ok",
  late: "border-warn/40 bg-warn/10 text-warn",
  half_day: "border-warn/40 bg-warn/10 text-warn",
  leave: "border-brass/40 bg-brass-50 text-brass",
  absent: "border-danger/40 bg-danger/10 text-danger",
  week_off: "border-line bg-muted text-muted-foreground",
};

const PAY_BADGE: Record<string, string> = {
  draft: "border-line bg-muted text-muted-foreground",
  processed: "border-warn/40 bg-warn/10 text-warn",
  paid: "border-ok/40 bg-ok/10 text-ok",
};

const ATT_LABELS: Record<string, string> = Object.fromEntries(ATT_STATUSES.map((s) => [s.value, s.label]));

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ─── Small helpers ───────────────────────────────────────────────────────────

/** yyyy-mm-dd for today in the property timezone (Asia/Kolkata). */
function todayKolkata(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

function currentMonthKolkata(): string {
  return todayKolkata().slice(0, 7);
}

function daysInMonthOf(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Keep the selected date inside the chosen month (defaults to today when in-month). */
function clampDateToMonth(preferred: string, month: string): string {
  if (preferred.startsWith(`${month}-`)) return preferred;
  return `${month}-01`;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const SCROLLBAR_X = "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-line-strong [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-brass";

// ─── View ────────────────────────────────────────────────────────────────────

export default function StaffView() {
  const { toast } = useToast();
  const [tab, setTab] = useState("directory");

  // ── Directory state
  const [dirStaff, setDirStaff] = useState<StaffMember[] | null>(null);
  const [dirLoading, setDirLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [deptFilter, setDeptFilter] = useState("all");
  const [activeOnly, setActiveOnly] = useState(false);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [editForm, setEditForm] = useState({ designation: "", department: "none", salary: "", joinDate: "" });
  const [savingDir, setSavingDir] = useState(false);

  // ── Attendance state
  const [board, setBoard] = useState<AttBoard | null>(null);
  const [attLoading, setAttLoading] = useState(true);
  const [attMonth, setAttMonth] = useState(currentMonthKolkata);
  const [attDate, setAttDate] = useState(todayKolkata);
  const [savingStatus, setSavingStatus] = useState<Record<string, boolean>>({});
  const [punching, setPunching] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [bulk, setBulk] = useState<{ done: number; total: number } | null>(null);

  // ── Payroll state
  const [payroll, setPayroll] = useState<PayrollResp | null>(null);
  const [payLoading, setPayLoading] = useState(true);
  const [payYear, setPayYear] = useState(() => Number(currentMonthKolkata().slice(0, 4)));
  const [payMonth, setPayMonth] = useState(() => Number(currentMonthKolkata().slice(5, 7)));
  const [generating, setGenerating] = useState(false);
  const [editRec, setEditRec] = useState<PayrollRec | null>(null);
  const [payForm, setPayForm] = useState({ allowances: "", bonus: "", deductions: "", advance: "", notes: "" });
  const [savingPay, setSavingPay] = useState(false);
  const [paidFor, setPaidFor] = useState<PayrollRec | null>(null);
  const [paidMethod, setPaidMethod] = useState("cash");
  const [paying, setPaying] = useState(false);

  // ─── Loaders ───────────────────────────────────────────────────────────────

  const loadDir = useCallback(async () => {
    setDirLoading(true);
    try {
      const r = await api<{ staff: StaffMember[] }>("/api/staff");
      setDirStaff(r.staff);
    } catch (e) {
      toast({ title: "Could not load staff directory", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setDirLoading(false);
    }
  }, [toast]);

  const loadAtt = useCallback(async () => {
    setAttLoading(true);
    try {
      const r = await api<AttBoard>(`/api/staff/attendance?month=${attMonth}`);
      setBoard(r);
    } catch (e) {
      toast({ title: "Could not load attendance", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setAttLoading(false);
    }
  }, [attMonth, toast]);

  const loadPay = useCallback(async () => {
    setPayLoading(true);
    try {
      const r = await api<PayrollResp>(`/api/staff/payroll?year=${payYear}&month=${payMonth}`);
      setPayroll(r);
    } catch (e) {
      toast({ title: "Could not load payroll", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPayLoading(false);
    }
  }, [payYear, payMonth, toast]);

  useEffect(() => { void loadDir(); }, [loadDir]);
  useEffect(() => { void loadAtt(); }, [loadAtt]);
  useEffect(() => { void loadPay(); }, [loadPay]);

  // ─── Directory derived ─────────────────────────────────────────────────────

  const filteredStaff = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (dirStaff ?? []).filter((s) => {
      if (activeOnly && !s.active) return false;
      if (deptFilter !== "all" && s.department !== deptFilter) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        s.role.toLowerCase().includes(q) ||
        s.designation.toLowerCase().includes(q) ||
        DEPT_LABELS[s.department]?.toLowerCase().includes(q)
      );
    });
  }, [dirStaff, query, deptFilter, activeOnly]);

  const kpis = useMemo(() => {
    const all = dirStaff ?? [];
    const active = all.filter((s) => s.active);
    const cost = round2(active.reduce((sum, s) => sum + s.salary, 0));
    const withJoin = active.filter((s) => s.joinDate);
    const avgTenure = withJoin.length
      ? withJoin.reduce((sum, s) => sum + (Date.now() - new Date(s.joinDate as string).getTime()), 0) / withJoin.length / (365.25 * 86_400_000)
      : null;
    return { headcount: all.length, active: active.length, cost, avgTenure };
  }, [dirStaff]);

  const openEdit = (s: StaffMember) => {
    setEditing(s);
    setEditForm({
      designation: s.designation,
      department: s.department || "none",
      salary: s.salary ? String(s.salary) : "",
      joinDate: s.joinDate ? s.joinDate.slice(0, 10) : "",
    });
  };

  const saveDirEdit = async () => {
    if (!editing) return;
    const salaryNum = editForm.salary.trim() === "" ? 0 : Number(editForm.salary);
    if (!Number.isFinite(salaryNum) || salaryNum < 0) {
      toast({ title: "Salary must be a non-negative number", variant: "destructive" });
      return;
    }
    setSavingDir(true);
    try {
      await api(`/api/staff/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          designation: editForm.designation,
          department: editForm.department === "none" ? "" : editForm.department,
          salary: salaryNum,
          joinDate: editForm.joinDate,
        }),
      });
      toast({ title: "Profile updated", description: `${editing.name}'s HR details saved.` });
      setEditing(null);
      await loadDir();
    } catch (e) {
      toast({ title: "Could not save profile", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingDir(false);
    }
  };

  // ─── Attendance derived & actions ──────────────────────────────────────────

  const rowFor = useCallback(
    (staffId: string) => board?.rows.find((r) => r.staffId === staffId && r.date === attDate) ?? null,
    [board, attDate]
  );

  const upsertRowLocal = (row: AttendanceRow) => {
    setBoard((b) => {
      if (!b) return b;
      const others = b.rows.filter((r) => !(r.staffId === row.staffId && r.date === row.date));
      return { ...b, rows: [...others, row] };
    });
  };

  // Month summary is recomputed client-side from rows so optimistic marks stay consistent.
  const monthSummary = useMemo(() => {
    const map: Record<string, AttSummary> = {};
    for (const s of board?.staff ?? []) map[s.id] = { present: 0, absent: 0, leave: 0, halfDays: 0, late: 0, weekOffs: 0, pct: 0 };
    for (const r of board?.rows ?? []) {
      const m = map[r.staffId];
      if (!m) continue;
      if (r.status === "present") m.present += 1;
      else if (r.status === "late") m.late += 1;
      else if (r.status === "absent") m.absent += 1;
      else if (r.status === "leave") m.leave += 1;
      else if (r.status === "half_day") m.halfDays += 1;
      else if (r.status === "week_off") m.weekOffs += 1;
    }
    for (const s of board?.staff ?? []) {
      const m = map[s.id];
      const attended = m.present + m.late + 0.5 * m.halfDays;
      const denom = m.present + m.late + m.halfDays + m.absent + m.leave; // week offs excluded
      m.pct = denom > 0 ? Math.round((attended / denom) * 1000) / 10 : 0;
    }
    return map;
  }, [board]);

  const markStatus = async (staffId: string, status: string, opts?: { notes?: string; quiet?: boolean }) => {
    const person = board?.staff.find((s) => s.id === staffId);
    const label = ATT_LABELS[status] ?? status;
    const tempRow: AttendanceRow = {
      id: `optimistic-${staffId}-${attDate}`,
      staffId,
      date: attDate,
      status,
      checkInAt: null,
      checkOutAt: null,
      hoursWorked: 0,
      overtimeHours: 0,
      notes: opts?.notes ?? rowFor(staffId)?.notes ?? "",
      markedBy: "",
    };
    upsertRowLocal(tempRow); // optimistic
    setSavingStatus((p) => ({ ...p, [staffId]: true }));
    try {
      const r = await api<{ record: AttendanceRow }>("/api/staff/attendance", {
        method: "POST",
        body: JSON.stringify({ staffId, date: attDate, status, ...(opts?.notes !== undefined ? { notes: opts.notes } : {}) }),
      });
      upsertRowLocal(r.record);
      if (!opts?.quiet) toast({ title: `${person?.name ?? "Staff"} marked ${label}` });
    } catch (e) {
      await loadAtt(); // revert from server truth
      if (!opts?.quiet) toast({ title: "Could not mark attendance", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingStatus((p) => {
        const next = { ...p };
        delete next[staffId];
        return next;
      });
    }
  };

  const punch = async (staffId: string, direction: "in" | "out") => {
    setPunching((p) => ({ ...p, [staffId]: true }));
    try {
      const r = await api<{ record: AttendanceRow }>("/api/staff/attendance/punch", {
        method: "POST",
        body: JSON.stringify({ staffId, direction }),
      });
      upsertRowLocal(r.record);
      const t = direction === "in" ? r.record.checkInAt : r.record.checkOutAt;
      toast({ title: direction === "in" ? "Punched in" : "Punched out", description: t ? fmtTime(t) : undefined });
    } catch (e) {
      toast({ title: "Punch failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPunching((p) => {
        const next = { ...p };
        delete next[staffId];
        return next;
      });
    }
  };

  const markAllPresent = async () => {
    if (!board || bulk) return;
    const targets = board.staff.filter((s) => s.active && rowFor(s.id)?.status !== "present");
    if (targets.length === 0) {
      toast({ title: "Everyone is already marked present" });
      return;
    }
    setBulk({ done: 0, total: targets.length });
    let ok = 0;
    for (const s of targets) {
      try {
        const r = await api<{ record: AttendanceRow }>("/api/staff/attendance", {
          method: "POST",
          body: JSON.stringify({ staffId: s.id, date: attDate, status: "present" }),
        });
        upsertRowLocal(r.record);
        ok += 1;
      } catch {
        /* keep going — failures surface on the manual marks */
      }
      setBulk((b) => (b ? { ...b, done: b.done + 1 } : b));
    }
    setBulk(null);
    toast({ title: `Marked ${ok} of ${targets.length} present` });
    await loadAtt();
  };

  const saveNote = async (staffId: string) => {
    const row = rowFor(staffId);
    const note = noteDrafts[staffId];
    if (!row) {
      toast({ title: "Pick a status first", description: "Notes save together with the attendance mark.", variant: "destructive" });
      return;
    }
    await markStatus(staffId, row.status, { notes: note ?? "" });
  };

  // ─── Payroll actions ───────────────────────────────────────────────────────

  const generatePayroll = async () => {
    setGenerating(true);
    try {
      const r = await api<{ created: number; updated: number; skipped: number; totalPayroll: number }>(
        "/api/staff/payroll/generate",
        { method: "POST", body: JSON.stringify({ year: payYear, month: payMonth }) }
      );
      toast({
        title: `${r.created} created · ${r.updated} updated · ${r.skipped} skipped`,
        description: `Locked (processed/paid) drafts were not touched · cycle total ${inr(r.totalPayroll)}`,
      });
      await loadPay();
    } catch (e) {
      toast({ title: "Generate failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  };

  const openPayEdit = (rec: PayrollRec) => {
    setEditRec(rec);
    setPayForm({
      allowances: String(rec.allowances ?? 0),
      bonus: String(rec.bonus ?? 0),
      deductions: String(rec.deductions ?? 0),
      advance: String(rec.advance ?? 0),
      notes: rec.notes ?? "",
    });
  };

  const savePayEdit = async () => {
    if (!editRec) return;
    const money = {
      allowances: Number(payForm.allowances),
      bonus: Number(payForm.bonus),
      deductions: Number(payForm.deductions),
      advance: Number(payForm.advance),
    };
    for (const [k, v] of Object.entries(money)) {
      if (!Number.isFinite(v) || v < 0) {
        toast({ title: `${k} must be a non-negative number`, variant: "destructive" });
        return;
      }
    }
    setSavingPay(true);
    try {
      const r = await api<{ record: PayrollRec }>(`/api/staff/payroll/${editRec.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...money, notes: payForm.notes }),
      });
      toast({ title: "Payroll updated", description: `Net pay ${inr(r.record.netPay)} for ${editRec.staff.name}.` });
      setEditRec(null);
      await loadPay();
    } catch (e) {
      toast({ title: "Could not update payroll", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingPay(false);
    }
  };

  const markPaid = async () => {
    if (!paidFor) return;
    setPaying(true);
    try {
      const r = await api<{ record: PayrollRec }>(`/api/staff/payroll/${paidFor.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "paid", paidMethod }),
      });
      toast({ title: "Salary marked paid", description: `${inr(r.record.netPay)} · ${paidMethod.toUpperCase()} · ${fmtDate(r.record.paidAt)}` });
      setPaidFor(null);
      await loadPay();
    } catch (e) {
      toast({ title: "Could not mark paid", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setPaying(false);
    }
  };

  const exportCsv = () => {
    if (!payroll || payroll.records.length === 0) {
      toast({ title: "Nothing to export", description: "Generate payroll drafts first." });
      return;
    }
    const month = `${payroll.year}-${String(payroll.month).padStart(2, "0")}`;
    const header = ["Staff", "Month", "Base", "Allowances", "Bonus", "Deductions", "Advance", "Net", "Status", "Method"];
    const lines = payroll.records.map((r) =>
      [r.staff.name, month, r.baseSalary, r.allowances, r.bonus, r.deductions, r.advance, r.netPay, r.status, r.paidMethod]
        .map(csvCell)
        .join(",")
    );
    const blob = new Blob(["\uFEFF" + [header.join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payroll-${month}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast({ title: "CSV exported", description: `${payroll.records.length} payroll rows downloaded.` });
  };

  // ─── Shared render bits ────────────────────────────────────────────────────

  const attDateMax = `${attMonth}-${String(daysInMonthOf(attMonth)).padStart(2, "0")}`;

  const Spinner = ({ label }: { label: string }) => (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-muted-ink">
      <Loader2 className="h-6 w-6 animate-spin text-brass" />
      <p className="text-sm">{label}</p>
    </div>
  );

  const EmptyState = ({ icon: Icon, title, hint }: { icon: typeof UsersRound; title: string; hint: string }) => (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-pine-100">
        <Icon className="h-6 w-6 text-pine-700" />
      </div>
      <p className="text-sm font-medium text-pine">{title}</p>
      <p className="max-w-xs text-xs text-muted-ink">{hint}</p>
    </div>
  );

  return (
    <div className="space-y-4 pb-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-pine">Staff &amp; Payroll</h2>
          <p className="text-xs text-muted-ink">HR directory, daily attendance and monthly payroll for your property.</p>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-11 w-full sm:h-10 sm:w-auto">
          <TabsTrigger value="directory" className="h-full flex-1 gap-1.5 px-3 text-[13px] sm:flex-none sm:px-4">
            <UsersRound className="h-4 w-4" /> Directory
          </TabsTrigger>
          <TabsTrigger value="attendance" className="h-full flex-1 gap-1.5 px-3 text-[13px] sm:flex-none sm:px-4">
            <CalendarClock className="h-4 w-4" /> Attendance
          </TabsTrigger>
          <TabsTrigger value="payroll" className="h-full flex-1 gap-1.5 px-3 text-[13px] sm:flex-none sm:px-4">
            <Receipt className="h-4 w-4" /> Payroll
          </TabsTrigger>
        </TabsList>

        {/* ─── DIRECTORY ──────────────────────────────────────────────────── */}
        <TabsContent value="directory" className="mt-4 space-y-4">
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { icon: UsersRound, label: "Headcount", value: String(kpis.headcount), sub: `${kpis.active} active` },
              { icon: UserCheck, label: "Active staff", value: String(kpis.active), sub: `${kpis.headcount - kpis.active} inactive` },
              { icon: IndianRupee, label: "Monthly payroll", value: inr(kpis.cost), sub: "Σ base salary (active)" },
              {
                icon: CalendarClock,
                label: "Avg tenure",
                value: kpis.avgTenure === null ? "—" : `${kpis.avgTenure.toFixed(1)} yr`,
                sub: "from join date",
              },
            ].map((k) => (
              <Card key={k.label} className="gap-2 rounded-lg border-line py-4">
                <CardContent className="flex items-center gap-3 px-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-pine-100">
                    <k.icon className="h-4.5 w-4.5 text-pine-700" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] uppercase tracking-wide text-muted-ink">{k.label}</p>
                    <p className="truncate font-display text-lg font-semibold leading-tight text-pine">{k.value}</p>
                    <p className="truncate text-[11px] text-muted-ink">{k.sub}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Filters */}
          <div className="panel p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="relative w-full lg:max-w-xs">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-ink" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, email, role, designation…"
                  aria-label="Search staff"
                  className="h-11 bg-panel pl-9 sm:h-10"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => setDeptFilter("all")}
                  className={cn(
                    "h-11 rounded-full border px-4 text-[13px] font-medium transition sm:h-9",
                    deptFilter === "all" ? "border-pine bg-pine text-plaster" : "border-line bg-panel text-ink hover:border-brass"
                  )}
                >
                  All
                </button>
                {DEPARTMENTS.map((d) => (
                  <button
                    key={d.value}
                    onClick={() => setDeptFilter(d.value)}
                    className={cn(
                      "h-11 rounded-full border px-4 text-[13px] font-medium transition sm:h-9",
                      deptFilter === d.value ? "border-pine bg-pine text-plaster" : "border-line bg-panel text-ink hover:border-brass"
                    )}
                  >
                    {d.label}
                  </button>
                ))}
                <div className="ml-1 flex h-11 items-center gap-2 rounded-full border border-line bg-panel px-3 sm:h-9">
                  <Switch id="active-only" checked={activeOnly} onCheckedChange={setActiveOnly} aria-label="Show active staff only" />
                  <Label htmlFor="active-only" className="cursor-pointer text-[13px] text-ink">Active only</Label>
                </div>
              </div>
            </div>

            <div className="mt-4">
              {dirLoading && !dirStaff ? (
                <Spinner label="Loading staff directory…" />
              ) : filteredStaff.length === 0 ? (
                <EmptyState
                  icon={UsersRound}
                  title={dirStaff && dirStaff.length > 0 ? "No matches" : "No staff yet"}
                  hint={
                    dirStaff && dirStaff.length > 0
                      ? "Try a different search term or clear the department filter."
                      : "Add team members from Settings → Team & Roles, then manage their HR profile here."
                  }
                />
              ) : (
                <>
                  {/* Mobile: stacked cards */}
                  <div className={cn("space-y-3 sm:hidden", "max-h-[560px] overflow-y-auto", SCROLLBAR_X)}>
                    {filteredStaff.map((s) => (
                      <div key={s.id} className={cn("panel p-3", !s.active && "opacity-60")}>
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-pine font-display text-sm font-semibold text-plaster">
                              {initials(s.name)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-pine">{s.name}</p>
                              <p className="truncate text-[11px] text-muted-ink">{s.email}</p>
                            </div>
                          </div>
                          <Button size="sm" className="h-11 gap-1.5 bg-pine px-3 text-plaster hover:bg-pine-700" onClick={() => openEdit(s)}>
                            <Pencil className="h-3.5 w-3.5" /> Edit
                          </Button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                          <Badge variant="outline" className="border-line bg-plaster-deep/40 text-ink">{ROLE_LABELS[s.role] ?? s.role}</Badge>
                          {s.department && <Badge variant="outline" className="border-brass/40 bg-brass-50 text-brass">{DEPT_LABELS[s.department] ?? s.department}</Badge>}
                          {!s.active && <Badge variant="outline" className="border-danger/40 bg-danger/10 text-danger">Inactive</Badge>}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[12px] text-muted-ink">
                          <span className="truncate">Desk: {s.designation || "—"}</span>
                          <span>₹{inr(s.salary)}/mo</span>
                          <span className="truncate">☎ {s.phone || "—"}</span>
                          <span>Joined {s.joinDate ? fmtDate(s.joinDate) : "—"}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop: table */}
                  <div className={cn("hidden sm:block", "max-h-[560px] overflow-y-auto", SCROLLBAR_X)}>
                    <Table className="min-w-[860px]">
                      <TableHeader>
                        <TableRow className="border-line hover:bg-transparent">
                          <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Staff</TableHead>
                          <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Department</TableHead>
                          <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Designation</TableHead>
                          <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Phone</TableHead>
                          <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Salary / mo</TableHead>
                          <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Joined</TableHead>
                          <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Actions</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredStaff.map((s) => (
                          <TableRow key={s.id} className={cn("border-line hover:bg-plaster/50", !s.active && "opacity-60")}>
                            <TableCell>
                              <div className="flex items-center gap-2.5">
                                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pine font-display text-[12px] font-semibold text-plaster">
                                  {initials(s.name)}
                                </div>
                                <div className="min-w-0">
                                  <p className="truncate text-sm font-semibold text-pine">
                                    {s.name}
                                    {!s.active && <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Inactive</span>}
                                  </p>
                                  <p className="truncate text-[11px] text-muted-ink">{s.email}</p>
                                </div>
                              </div>
                            </TableCell>
                            <TableCell>
                              {s.department ? (
                                <Badge variant="outline" className="border-brass/40 bg-brass-50 text-brass">{DEPT_LABELS[s.department] ?? s.department}</Badge>
                              ) : (
                                <span className="text-muted-ink">—</span>
                              )}
                              <p className="mt-0.5 text-[11px] text-muted-ink">{ROLE_LABELS[s.role] ?? s.role}</p>
                            </TableCell>
                            <TableCell className="text-[13px] text-ink">{s.designation || "—"}</TableCell>
                            <TableCell className="text-[13px] text-ink">{s.phone || "—"}</TableCell>
                            <TableCell className="text-right text-[13px] font-medium text-ink">{inr(s.salary)}</TableCell>
                            <TableCell className="text-[13px] text-ink">{s.joinDate ? fmtDate(s.joinDate) : "—"}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-11 gap-1.5 border-line bg-panel px-3 text-pine hover:bg-plaster sm:h-9"
                                onClick={() => openEdit(s)}
                                aria-label={`Edit ${s.name}`}
                              >
                                <Pencil className="h-3.5 w-3.5" /> Edit
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </>
              )}
            </div>
          </div>
        </TabsContent>

        {/* ─── ATTENDANCE ─────────────────────────────────────────────────── */}
        <TabsContent value="attendance" className="mt-4 space-y-4">
          {/* Controls */}
          <div className="panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div>
                <Label htmlFor="att-month" className="field-label text-[11px] uppercase tracking-wide text-muted-ink">Month</Label>
                <Input
                  id="att-month"
                  type="month"
                  value={attMonth}
                  max={currentMonthKolkata()}
                  onChange={(e) => {
                    const m = e.target.value;
                    if (!/^\d{4}-\d{2}$/.test(m)) return;
                    setAttMonth(m);
                    setAttDate(clampDateToMonth(todayKolkata(), m));
                  }}
                  className="h-11 w-full bg-panel sm:w-44"
                />
              </div>
              <div>
                <Label htmlFor="att-date" className="field-label text-[11px] uppercase tracking-wide text-muted-ink">Date</Label>
                <Input
                  id="att-date"
                  type="date"
                  value={attDate}
                  min={`${attMonth}-01`}
                  max={attDateMax}
                  onChange={(e) => setAttDate(e.target.value)}
                  className="h-11 w-full bg-panel sm:w-44"
                />
              </div>
              <div className="flex flex-1 flex-wrap items-center justify-start gap-2 sm:justify-end">
                <Button
                  variant="outline"
                  className="h-11 gap-1.5 border-line bg-panel text-pine hover:bg-plaster"
                  onClick={() => void loadAtt()}
                  disabled={attLoading}
                >
                  <RefreshCw className={cn("h-4 w-4", attLoading && "animate-spin")} /> Refresh
                </Button>
                <Button
                  className="h-11 gap-1.5 bg-pine text-plaster hover:bg-pine-700"
                  onClick={() => void markAllPresent()}
                  disabled={!!bulk || attLoading}
                >
                  {bulk ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
                  {bulk ? `Marking ${bulk.done}/${bulk.total}…` : "Mark all present"}
                </Button>
              </div>
            </div>
          </div>

          {attLoading && !board ? (
            <Spinner label="Loading attendance board…" />
          ) : !board || board.staff.length === 0 ? (
            <div className="panel">
              <EmptyState icon={CalendarX} title="No staff to track" hint="Add team members in Settings → Team & Roles to start tracking attendance." />
            </div>
          ) : (
            <>
              {/* Today at a glance */}
              <div className="panel">
                <div className="panel-header">
                  <p className="panel-title">Attendance — {fmtDate(`${attDate}T00:00:00`)}</p>
                  <span className="text-[11px] text-muted-ink">Tap a status · punch clock uses IST</span>
                </div>
                <div className={cn("max-h-[520px] space-y-2 overflow-y-auto p-3", SCROLLBAR_X)}>
                  {board.staff.map((s) => {
                    const row = rowFor(s.id);
                    const isIn = !!row?.checkInAt;
                    const isOut = !!row?.checkOutAt;
                    const isOpen = !!expanded[s.id];
                    return (
                      <div key={s.id} className={cn("rounded-lg border border-line bg-panel p-3", !s.active && "opacity-60")}>
                        <div className="flex flex-col gap-2.5 lg:flex-row lg:items-center lg:justify-between">
                          <div className="flex min-w-0 items-center gap-2.5">
                            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-pine font-display text-[12px] font-semibold text-plaster">
                              {initials(s.name)}
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-semibold text-pine">
                                {s.name}
                                {!s.active && <span className="ml-2 rounded bg-danger/10 px-1.5 py-0.5 text-[10px] font-medium text-danger">Inactive</span>}
                              </p>
                              <p className="truncate text-[11px] text-muted-ink">
                                {s.designation || ROLE_LABELS[s.role] || s.role}
                                {s.department ? ` · ${DEPT_LABELS[s.department] ?? s.department}` : ""}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-wrap items-center gap-2">
                            {row && (
                              <Badge variant="outline" className={cn("h-8 border", ATT_BADGE[row.status])}>
                                {ATT_LABELS[row.status] ?? row.status}
                              </Badge>
                            )}
                            <Select
                              value={row?.status ?? "unmarked"}
                              onValueChange={(v) => {
                                if (v === "unmarked") return;
                                void markStatus(s.id, v, { notes: noteDrafts[s.id] ?? row?.notes });
                              }}
                              disabled={!!savingStatus[s.id] || !!bulk}
                            >
                              <SelectTrigger className="h-11 w-[150px] bg-panel text-[13px] sm:h-10" aria-label={`Attendance status for ${s.name}`}>
                                {row ? <SelectValue /> : <SelectValue placeholder="Mark attendance…" />}
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="unmarked" disabled>Mark attendance…</SelectItem>
                                {ATT_STATUSES.map((st) => (
                                  <SelectItem key={st.value} value={st.value}>{st.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                            <Button
                              size="sm"
                              variant="outline"
                              className="h-11 min-w-[92px] gap-1.5 border-line bg-panel px-2 text-[12px] text-pine hover:bg-plaster sm:h-10"
                              disabled={isIn || !!punching[s.id] || !!bulk}
                              onClick={() => void punch(s.id, "in")}
                              title={isIn ? `Punched in at ${fmtTime(row?.checkInAt)}` : "Punch in"}
                            >
                              {punching[s.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogIn className="h-3.5 w-3.5" />}
                              {isIn ? `In ${fmtTime(row?.checkInAt)}` : "Punch In"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-11 min-w-[92px] gap-1.5 border-line bg-panel px-2 text-[12px] text-pine hover:bg-plaster sm:h-10"
                              disabled={!isIn || isOut || !!punching[s.id] || !!bulk}
                              onClick={() => void punch(s.id, "out")}
                              title={isOut ? `Punched out at ${fmtTime(row?.checkOutAt)}` : !isIn ? "Punch in first" : "Punch out"}
                            >
                              {punching[s.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <LogOut className="h-3.5 w-3.5" />}
                              {isOut ? `Out ${fmtTime(row?.checkOutAt)}` : "Punch Out"}
                            </Button>

                            <span className="min-w-[52px] text-center text-[12px] font-medium text-pine" title="Hours worked">
                              {row ? `${row.hoursWorked}h` : "—"}
                            </span>

                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-11 w-11 text-muted-ink hover:bg-plaster sm:h-10 sm:w-10"
                              onClick={() => {
                                setExpanded((p) => ({ ...p, [s.id]: !p[s.id] }));
                                setNoteDrafts((p) => ({ ...p, [s.id]: p[s.id] ?? row?.notes ?? "" }));
                              }}
                              aria-label={isOpen ? `Hide notes for ${s.name}` : `Add notes for ${s.name}`}
                              aria-expanded={isOpen}
                            >
                              {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                          </div>
                        </div>

                        {isOpen && (
                          <div className="mt-3 space-y-2 border-t border-line pt-3">
                            <div className="flex items-start gap-2">
                              <StickyNote className="mt-2.5 h-4 w-4 shrink-0 text-brass" />
                              <div className="flex-1 space-y-2">
                                <Textarea
                                  rows={2}
                                  placeholder="Note (e.g. late by 30 min — approved)…"
                                  value={noteDrafts[s.id] ?? row?.notes ?? ""}
                                  onChange={(e) => setNoteDrafts((p) => ({ ...p, [s.id]: e.target.value }))}
                                  aria-label={`Attendance note for ${s.name}`}
                                  className="bg-plaster/60"
                                />
                                <div className="flex flex-wrap items-center gap-2">
                                  <Button
                                    size="sm"
                                    className="h-11 gap-1.5 bg-pine px-3 text-plaster hover:bg-pine-700 sm:h-9"
                                    disabled={!!savingStatus[s.id]}
                                    onClick={() => void saveNote(s.id)}
                                  >
                                    {savingStatus[s.id] ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                                    Save note
                                  </Button>
                                  {row?.markedBy && <span className="text-[11px] text-muted-ink">Marked by {row.markedBy}</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Month summary */}
              <div className="panel">
                <div className="panel-header">
                  <p className="panel-title">Month summary — {MONTH_NAMES[Number(attMonth.slice(5, 7)) - 1]} {attMonth.slice(0, 4)}</p>
                  <span className="text-[11px] text-muted-ink">P · H · L · A · Late — attendance % (week offs excluded)</span>
                </div>
                <div className={cn("max-h-[420px] overflow-y-auto", SCROLLBAR_X)}>
                  <Table className="min-w-[680px]">
                    <TableHeader>
                      <TableRow className="border-line hover:bg-transparent">
                        <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Staff</TableHead>
                        <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">P</TableHead>
                        <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">H</TableHead>
                        <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">L</TableHead>
                        <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">A</TableHead>
                        <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">Late</TableHead>
                        <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Attendance %</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {board.staff.map((s) => {
                        const m = monthSummary[s.id];
                        return (
                          <TableRow key={s.id} className="border-line hover:bg-plaster/50">
                            <TableCell>
                              <p className="text-[13px] font-semibold text-pine">{s.name}</p>
                              <p className="text-[11px] text-muted-ink">{s.designation || ROLE_LABELS[s.role] || s.role}</p>
                            </TableCell>
                            <TableCell className="text-center text-[13px] font-medium text-ok">{m?.present ?? 0}</TableCell>
                            <TableCell className="text-center text-[13px] font-medium text-warn">{m?.halfDays ?? 0}</TableCell>
                            <TableCell className="text-center text-[13px] font-medium text-brass">{m?.leave ?? 0}</TableCell>
                            <TableCell className="text-center text-[13px] font-medium text-danger">{m?.absent ?? 0}</TableCell>
                            <TableCell className="text-center text-[13px] font-medium text-warn">{m?.late ?? 0}</TableCell>
                            <TableCell className="text-right">
                              <span className={cn("text-[13px] font-semibold", (m?.pct ?? 0) >= 90 ? "text-ok" : (m?.pct ?? 0) >= 75 ? "text-warn" : "text-danger")}>
                                {m?.pct ?? 0}%
                              </span>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </>
          )}
        </TabsContent>

        {/* ─── PAYROLL ────────────────────────────────────────────────────── */}
        <TabsContent value="payroll" className="mt-4 space-y-4">
          {/* Cycle controls */}
          <div className="panel p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div>
                <Label htmlFor="pay-year" className="field-label text-[11px] uppercase tracking-wide text-muted-ink">Year</Label>
                <Input
                  id="pay-year"
                  type="number"
                  min={2000}
                  max={2100}
                  value={payYear}
                  onChange={(e) => {
                    const y = Number(e.target.value);
                    if (Number.isInteger(y) && y >= 2000 && y <= 2100) setPayYear(y);
                  }}
                  className="h-11 w-full bg-panel sm:w-28"
                />
              </div>
              <div>
                <Label htmlFor="pay-month" className="field-label text-[11px] uppercase tracking-wide text-muted-ink">Month</Label>
                <Select value={String(payMonth)} onValueChange={(v) => setPayMonth(Number(v))}>
                  <SelectTrigger id="pay-month" className="h-11 w-full bg-panel sm:w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTH_NAMES.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-1 flex-wrap items-center justify-start gap-2 sm:justify-end">
                <Button
                  className="h-11 gap-1.5 bg-brass text-plaster hover:bg-brass/90"
                  onClick={() => void generatePayroll()}
                  disabled={generating}
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  Generate drafts
                </Button>
                <Button
                  variant="outline"
                  className="h-11 gap-1.5 border-line bg-panel text-pine hover:bg-plaster"
                  onClick={exportCsv}
                  disabled={payLoading || !payroll || payroll.records.length === 0}
                >
                  <Download className="h-4 w-4" /> CSV
                </Button>
              </div>
            </div>
          </div>

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { icon: Wallet, label: "Total net payable", value: inr(payroll?.summary.totalNet) },
              { icon: BadgeCheck, label: "Paid", value: inr(payroll?.summary.paid) },
              { icon: Hourglass, label: "Pending", value: inr(payroll?.summary.pending) },
              { icon: UsersRound, label: "Headcount", value: String(payroll?.summary.headcount ?? 0) },
            ].map((k) => (
              <Card key={k.label} className="gap-2 rounded-lg border-line py-4">
                <CardContent className="flex items-center gap-3 px-4">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-brass-50">
                    <k.icon className="h-4.5 w-4.5 text-brass" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[11px] uppercase tracking-wide text-muted-ink">{k.label}</p>
                    <p className="truncate font-display text-lg font-semibold leading-tight text-pine">{k.value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {payLoading && !payroll ? (
            <Spinner label="Loading payroll register…" />
          ) : !payroll || payroll.records.length === 0 ? (
            <div className="panel">
              <EmptyState
                icon={Receipt}
                title="No payroll records for this cycle"
                hint="Use “Generate drafts” to build salary drafts from this month's attendance."
              />
            </div>
          ) : (
            <div className="panel">
              <div className="panel-header">
                <p className="panel-title">Payroll register — {MONTH_NAMES[payroll.month - 1]} {payroll.year}</p>
                <span className="text-[11px] text-muted-ink">Drafts regenerate from attendance · processed/paid stay locked</span>
              </div>

              {/* Mobile: stacked cards */}
              <div className={cn("space-y-3 p-3 sm:hidden", "max-h-[560px] overflow-y-auto", SCROLLBAR_X)}>
                {payroll.records.map((r) => (
                  <div key={r.id} className="rounded-lg border border-line bg-panel p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-pine">{r.staff.name}</p>
                        <p className="truncate text-[11px] text-muted-ink">{r.staff.designation || DEPT_LABELS[r.staff.department] || "—"}</p>
                      </div>
                      <Badge variant="outline" className={cn("border", PAY_BADGE[r.status])}>{r.status}</Badge>
                    </div>
                    <div className="mt-2 grid grid-cols-3 gap-x-3 gap-y-1 text-[12px]">
                      <span className="text-muted-ink">Base</span><span className="col-span-2 text-right text-ink">{inr(r.baseSalary)}</span>
                      <span className="text-muted-ink">Allowances</span><span className="col-span-2 text-right text-ink">{inr(r.allowances)}</span>
                      <span className="text-muted-ink">Bonus</span><span className="col-span-2 text-right text-ink">{inr(r.bonus)}</span>
                      <span className="text-muted-ink">Deductions</span><span className="col-span-2 text-right text-ink">{inr(r.deductions)}</span>
                      <span className="text-muted-ink">Advance</span><span className="col-span-2 text-right text-ink">{inr(r.advance)}</span>
                      <span className="font-medium text-pine">NET</span><span className="col-span-2 text-right font-semibold text-pine">{inr(r.netPay)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted-ink">
                      Days: {r.presentDays}P · {r.halfDays}H · {r.leaveDays}L · {r.absentDays}A
                      {r.status === "paid" && r.paidAt ? ` · Paid ${fmtDate(r.paidAt)} via ${r.paidMethod.toUpperCase()}` : ""}
                    </p>
                    <div className="mt-2 flex gap-2">
                      {r.status !== "paid" && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-11 flex-1 gap-1.5 border-line bg-panel text-[12px] text-pine hover:bg-plaster"
                          onClick={() => openPayEdit(r)}
                        >
                          <Pencil className="h-3.5 w-3.5" /> Edit
                        </Button>
                      )}
                      {r.status !== "paid" && (
                        <Button
                          size="sm"
                          className="h-11 flex-1 gap-1.5 bg-ok px-2 text-[12px] text-plaster hover:bg-ok/90"
                          onClick={() => { setPaidFor(r); setPaidMethod("cash"); }}
                        >
                          <BadgeCheck className="h-3.5 w-3.5" /> Mark paid
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className={cn("hidden sm:block", "max-h-[560px] overflow-y-auto", SCROLLBAR_X)}>
                <Table className="min-w-[980px]">
                  <TableHeader>
                    <TableRow className="border-line hover:bg-transparent">
                      <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Staff</TableHead>
                      <TableHead className="text-center text-[11px] uppercase tracking-wide text-muted-ink">Days</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Base</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Allowances</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Bonus</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Deductions</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Advance</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Net</TableHead>
                      <TableHead className="text-[11px] uppercase tracking-wide text-muted-ink">Status</TableHead>
                      <TableHead className="text-right text-[11px] uppercase tracking-wide text-muted-ink">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {payroll.records.map((r) => (
                      <TableRow key={r.id} className="border-line hover:bg-plaster/50">
                        <TableCell>
                          <p className="text-[13px] font-semibold text-pine">{r.staff.name}</p>
                          <p className="text-[11px] text-muted-ink">{r.staff.designation || DEPT_LABELS[r.staff.department] || "—"}</p>
                        </TableCell>
                        <TableCell className="text-center text-[12px] text-muted-ink">
                          {r.presentDays}P · {r.halfDays}H · {r.leaveDays}L · {r.absentDays}A
                        </TableCell>
                        <TableCell className="text-right text-[13px] text-ink">{inr(r.baseSalary)}</TableCell>
                        <TableCell className="text-right text-[13px] text-ink">{inr(r.allowances)}</TableCell>
                        <TableCell className="text-right text-[13px] text-ink">{inr(r.bonus)}</TableCell>
                        <TableCell className="text-right text-[13px] text-danger">{inr(r.deductions)}</TableCell>
                        <TableCell className="text-right text-[13px] text-danger">{inr(r.advance)}</TableCell>
                        <TableCell className="text-right text-[13px] font-bold text-pine">{inr(r.netPay)}</TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn("border", PAY_BADGE[r.status])}>{r.status}</Badge>
                          {r.status === "paid" && r.paidAt && (
                            <p className="mt-0.5 text-[10px] text-muted-ink">
                              {fmtDate(r.paidAt)} · {r.paidMethod.toUpperCase()}
                            </p>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex justify-end gap-2">
                            {r.status !== "paid" && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-11 gap-1 border-line bg-panel px-2.5 text-[12px] text-pine hover:bg-plaster sm:h-9"
                                onClick={() => openPayEdit(r)}
                                aria-label={`Edit payroll for ${r.staff.name}`}
                              >
                                <Pencil className="h-3.5 w-3.5" /> Edit
                              </Button>
                            )}
                            {r.status !== "paid" && (
                              <Button
                                size="sm"
                                className="h-11 gap-1 bg-ok px-2.5 text-[12px] text-plaster hover:bg-ok/90 sm:h-9"
                                onClick={() => { setPaidFor(r); setPaidMethod("cash"); }}
                                aria-label={`Mark salary paid for ${r.staff.name}`}
                              >
                                <BadgeCheck className="h-3.5 w-3.5" /> Paid
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* ─── Directory edit dialog ────────────────────────────────────────── */}
      <Dialog open={!!editing} onOpenChange={(o) => { if (!o) setEditing(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Edit HR profile</DialogTitle>
            <DialogDescription>
              {editing?.name} · {editing?.email}
              {editing?.phone ? ` · ☎ ${editing.phone}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="ed-designation" className="field-label">Designation</Label>
              <Input
                id="ed-designation"
                value={editForm.designation}
                onChange={(e) => setEditForm((f) => ({ ...f, designation: e.target.value }))}
                placeholder="Front Desk Executive"
                className="h-11 bg-panel"
                maxLength={80}
              />
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="ed-dept" className="field-label">Department</Label>
                <Select value={editForm.department} onValueChange={(v) => setEditForm((f) => ({ ...f, department: v }))}>
                  <SelectTrigger id="ed-dept" className="h-11 bg-panel"><SelectValue placeholder="Select department" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not assigned</SelectItem>
                    {DEPARTMENTS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="ed-salary" className="field-label">Monthly salary (₹)</Label>
                <Input
                  id="ed-salary"
                  type="number"
                  min={0}
                  step={100}
                  value={editForm.salary}
                  onChange={(e) => setEditForm((f) => ({ ...f, salary: e.target.value }))}
                  placeholder="18000"
                  className="h-11 bg-panel"
                />
              </div>
            </div>
            <div>
              <Label htmlFor="ed-join" className="field-label">Join date</Label>
              <Input
                id="ed-join"
                type="date"
                value={editForm.joinDate}
                onChange={(e) => setEditForm((f) => ({ ...f, joinDate: e.target.value }))}
                className="h-11 bg-panel"
              />
            </div>
            <p className="text-[11px] text-muted-ink">
              Name, email, role and login status are managed in Settings → Team &amp; Roles.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" className="h-11 flex-1 border-line bg-panel text-pine hover:bg-plaster sm:flex-none" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button className="h-11 flex-1 gap-1.5 bg-pine text-plaster hover:bg-pine-700 sm:flex-none" onClick={() => void saveDirEdit()} disabled={savingDir}>
              {savingDir ? <Loader2 className="h-4 w-4 animate-spin" /> : <Pencil className="h-4 w-4" />} Save profile
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Payroll edit dialog ──────────────────────────────────────────── */}
      <Dialog open={!!editRec} onOpenChange={(o) => { if (!o) setEditRec(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Adjust payroll</DialogTitle>
            <DialogDescription>
              {editRec?.staff.name} · {editRec ? `${MONTH_NAMES[editRec.month - 1]} ${editRec.year}` : ""} · base {inr(editRec?.baseSalary ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                { key: "allowances" as const, label: "Allowances (₹)" },
                { key: "bonus" as const, label: "Bonus (₹)" },
                { key: "deductions" as const, label: "Deductions (₹)" },
                { key: "advance" as const, label: "Advance recovered (₹)" },
              ]
            ).map((f) => (
              <div key={f.key}>
                <Label htmlFor={`pay-${f.key}`} className="field-label">{f.label}</Label>
                <Input
                  id={`pay-${f.key}`}
                  type="number"
                  min={0}
                  step={50}
                  value={payForm[f.key]}
                  onChange={(e) => setPayForm((p) => ({ ...p, [f.key]: e.target.value }))}
                  className="h-11 bg-panel"
                />
              </div>
            ))}
          </div>
          <div>
            <Label htmlFor="pay-notes" className="field-label">Notes</Label>
            <Textarea
              id="pay-notes"
              rows={2}
              value={payForm.notes}
              onChange={(e) => setPayForm((p) => ({ ...p, notes: e.target.value }))}
              placeholder="e.g. Diwali bonus approved by GM"
              className="bg-plaster/60"
            />
          </div>
          <p className="text-[12px] text-muted-ink">
            Net pay recalculates as Base + Allowances + Bonus − Deductions − Advance.
          </p>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" className="h-11 flex-1 border-line bg-panel text-pine hover:bg-plaster sm:flex-none" onClick={() => setEditRec(null)}>
              Cancel
            </Button>
            <Button className="h-11 flex-1 gap-1.5 bg-pine text-plaster hover:bg-pine-700 sm:flex-none" onClick={() => void savePayEdit()} disabled={savingPay}>
              {savingPay ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Save payroll
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Mark paid dialog ─────────────────────────────────────────────── */}
      <Dialog open={!!paidFor} onOpenChange={(o) => { if (!o) setPaidFor(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Mark salary paid</DialogTitle>
            <DialogDescription>
              {paidFor?.staff.name} · {paidFor ? `${MONTH_NAMES[paidFor.month - 1]} ${paidFor.year}` : ""} · {inr(paidFor?.netPay ?? 0)}
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="paid-method" className="field-label">Payment method</Label>
            <Select value={paidMethod} onValueChange={setPaidMethod}>
              <SelectTrigger id="paid-method" className="h-11 bg-panel"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="bank">Bank transfer</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
              </SelectContent>
            </Select>
            <p className="mt-2 text-[11px] text-muted-ink">
              Paid records are frozen — the amount can no longer be edited and drafts will not regenerate over it.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button variant="outline" className="h-11 flex-1 border-line bg-panel text-pine hover:bg-plaster sm:flex-none" onClick={() => setPaidFor(null)}>
              Cancel
            </Button>
            <Button className="h-11 flex-1 gap-1.5 bg-ok text-plaster hover:bg-ok/90 sm:flex-none" onClick={() => void markPaid()} disabled={paying}>
              {paying ? <Loader2 className="h-4 w-4 animate-spin" /> : <BadgeCheck className="h-4 w-4" />} Confirm paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
