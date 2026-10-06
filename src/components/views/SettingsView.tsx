"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { fmtDate, fmtDateTime, inr } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import WhatsAppConnectPanel from "@/components/views/WhatsAppConnectPanel";
import TwoFactorCard from "@/components/auth/TwoFactorCard";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import {
  Loader2, Save, UserPlus, Pencil, Building2, CalendarClock, ShieldCheck, ScrollText, RefreshCw,
  Copy, Check, CheckCircle2, MapPin, FileText, ImageIcon, BedDouble, KeyRound, Clock3,
  Globe, Eye, ExternalLink, Camera, Store,
  ChevronRight, Unlink,
  Search, MoreVertical, Users, UserCheck, UserX, TrendingUp, LogIn, LogOut,
  IndianRupee, Wallet, ArrowUpRight, ArrowDownRight, ConciergeBell, UtensilsCrossed,
  Sparkles, CalendarDays, ReceiptIndianRupee,
} from "lucide-react";
import { getStoredToken } from "@/lib/store";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GoogleProfile {
  connected: boolean;
  accountEmail?: string;
  profileName?: string;
  lastSyncedAt?: string | null;
}

/** Provider key → display label (mirrors the payment gateway catalogue). */
const GATEWAY_LABELS: Record<string, string> = {
  razorpay: "Razorpay",
  cashfree: "Cashfree",
  payu: "PayU",
  paytm: "Paytm",
  phonepe: "PhonePe",
  stripe: "Stripe",
  upi_qr: "UPI QR",
  bank_transfer: "Bank transfer",
  custom: "Custom",
};

interface PropertyConfig {
  id: string;
  name: string;
  address: string;
  city: string;
  gstin: string;
  phone: string;
  email: string;
  propertyType: string;
  businessCategory: string;
  photoUrl: string;
  googleProfile: GoogleProfile | null;
  noShowPercent: number;
  auditCutoffHour: number;
  pricingEnabled: boolean;
  occupancyThreshold: number;
  rateIncreasePercent: number;
  businessDate: string;
}

interface StaffMember {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  phone: string;
  googleEmail: string | null;
  createdAt: string;
}

interface SettingsData {
  property: PropertyConfig;
  staff: StaffMember[];
  canManageStaff: boolean;
}

interface ActivityEntry {
  id: string;
  staffName: string;
  action: string;
  entity: string;
  entityId: string;
  details: string;
  createdAt: string;
}

/** Live operations pulse from /api/dashboard — the working widgets on the Property tab. */
interface DashboardPulse {
  businessDate: string;
  kpis: { occupancy: number; occupancyDelta: number; adr: number; adrDelta: number; revpar: number; revparDelta: number; revenueToday: number; revenueDelta: number; outstanding: number };
  checkIns: { id: string; guestName: string; roomNumber: string; checkIn: string; status: string; totalAmount: number }[];
  checkOuts: { id: string; guestName: string; roomNumber: string; checkOut: string; status: string; balance: number }[];
  counts: { totalRooms: number; occupied: number; vacant: number; dirty: number; outOfOrder: number; inHouse: number; arrivals: number; departures: number };
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  hotel_admin: "Hotel Admin",
  front_desk: "Front Desk",
  housekeeping: "Housekeeping",
  restaurant_staff: "Restaurant Staff",
};

const DEPARTMENTS = [
  { value: "front_office", label: "Front Office" },
  { value: "housekeeping", label: "Housekeeping" },
  { value: "fnb", label: "F&B" },
  { value: "maintenance", label: "Maintenance" },
  { value: "accounts", label: "Accounts" },
  { value: "other", label: "Other" },
] as const;

const ROLE_BADGE: Record<string, string> = {
  hotel_admin: "border-brass/40 bg-brass-50 text-brass",
  front_desk: "border-pine-700/30 bg-pine-100 text-pine-700",
  housekeeping: "border-ok/40 bg-ok/10 text-ok",
  restaurant_staff: "border-warn/40 bg-warn/10 text-warn",
};

/** Role definitions for the Role Permissions rail — icon, scope description, tint. */
const ROLE_DEFS: {
  key: string; label: string; desc: string;
  icon: React.ComponentType<{ className?: string }>;
  chip: string; avatar: string;
}[] = [
  { key: "hotel_admin", label: "Hotel Admin", desc: "Full access to property settings, staff, PMS, reports", icon: ShieldCheck, chip: "border-brass/40 bg-brass-50 text-brass", avatar: "bg-brass-50 text-brass" },
  { key: "front_desk", label: "Front Desk", desc: "Reservations, check-in/out, billing", icon: ConciergeBell, chip: "border-pine-700/30 bg-pine-100 text-pine-700", avatar: "bg-pine-100 text-pine-700" },
  { key: "housekeeping", label: "Housekeeping", desc: "Room status, task management", icon: Sparkles, chip: "border-ok/40 bg-ok/10 text-ok", avatar: "bg-ok/10 text-ok" },
  { key: "restaurant_staff", label: "Restaurant Staff", desc: "F&B POS, menu, kitchen orders", icon: UtensilsCrossed, chip: "border-warn/40 bg-warn/10 text-warn", avatar: "bg-warn/10 text-warn" },
];

/** Two-letter initials for staff avatars ("Vikram Singh" → "VS"). */
function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
}

function actionBadge(action: string): string {
  if (/(VOID|DELETE|CANCEL|REJECT|DISCONNECT)/.test(action)) return "border-danger/30 bg-danger/10 text-danger";
  if (/(CREATE|CHECKIN|LOGIN|CONNECT|SYNC)/.test(action)) return "border-ok/40 bg-ok/10 text-ok";
  if (/(UPDATE|SETTINGS|ROOM_STATUS)/.test(action)) return "border-pine-700/30 bg-pine-100 text-pine-700";
  return "border-warn/40 bg-warn/10 text-warn";
}

const PROPERTY_TYPES = ["Hotel", "Resort", "Serviced Apartments", "Boutique Stay", "Guest House", "Hostel"];
const BUSINESS_CATEGORIES = ["Luxury Hotel", "Premium Hotel", "Midscale Hotel", "Economy Hotel", "Heritage Property", "Boutique Property"];

const emptyProperty: PropertyConfig = {
  id: "", name: "", address: "", city: "", gstin: "", phone: "", email: "",
  propertyType: "Hotel", businessCategory: "Luxury Hotel", photoUrl: "", googleProfile: null,
  noShowPercent: 100, auditCutoffHour: 14, pricingEnabled: true,
  occupancyThreshold: 80, rateIncreasePercent: 10, businessDate: "",
};

/** Official four-colour Google "G" mark (inline, no external asset). */
function GoogleG({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.57 5.57 0 0 1-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09A11.99 11.99 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.27 14.29A7.2 7.2 0 0 1 4.89 12c0-.8.14-1.57.38-2.29V6.62H1.29a12 12 0 0 0 0 10.76l3.98-3.09Z" />
      <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42A11.97 11.97 0 0 0 12 0 11.99 11.99 0 0 0 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75Z" />
    </svg>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function SettingsView() {
  const { toast } = useToast();
  const user = useSession((s) => s.user);
  const isAdmin = user?.role === "hotel_admin";

  const [data, setData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<PropertyConfig>(emptyProperty);
  const [saved, setSaved] = useState<PropertyConfig>(emptyProperty); // last persisted snapshot (dirty tracking)
  const [saving, setSaving] = useState(false);

  // Photo upload
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);

  // Google Business Profile
  const [googleBusy, setGoogleBusy] = useState<"" | "connect" | "sync" | "disconnect">("");
  const [googleOpen, setGoogleOpen] = useState(false);
  const [googleEmail, setGoogleEmail] = useState("");

  // Online payment gateways assigned by the platform owner (read-only for tenants)
  const [payGateways, setPayGateways] = useState<{ id: string; provider: string; label: string; mode: string; isDefault: boolean }[]>([]);

  // Staff dialogs
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({
    name: "", email: "", role: "front_desk", phone: "", googleEmail: "",
    designation: "", department: "none", salary: "", joinDate: "",
  });
  const [adding, setAdding] = useState(false);
  // One-time credential reveal after creating a staff account — the temp password
  // is never stored client-side and cannot be shown again once dismissed.
  const [credShown, setCredShown] = useState<{ name: string; email: string; role: string; tempPassword: string } | null>(null);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  const [editForm, setEditForm] = useState({ name: "", phone: "", role: "front_desk", active: true, password: "", googleEmail: "" });
  const [savingEdit, setSavingEdit] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Staff directory: search + role filter (reference layout)
  const [staffQuery, setStaffQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");

  // Today at a Glance — live operations pulse
  const [pulse, setPulse] = useState<DashboardPulse | null>(null);
  const [pulseLoading, setPulseLoading] = useState(false);

  // Audit trail
  const [activities, setActivities] = useState<ActivityEntry[] | null>(null);
  const [activitiesLoading, setActivitiesLoading] = useState(false);

  // Top-level settings navigation (Property / Staff / Audit Trail)
  const [topTab, setTopTab] = useState<"property" | "staff" | "whatsapp" | "audit">("property");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<SettingsData>("/api/settings");
      setData(d);
      setForm({ ...emptyProperty, ...d.property });
      setSaved({ ...emptyProperty, ...d.property });
      setGoogleEmail(d.property.googleProfile?.accountEmail ?? d.property.email ?? "");
    } catch {
      /* keep stale */
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActivities = useCallback(async () => {
    setActivitiesLoading(true);
    try {
      const d = await api<{ activities: ActivityEntry[] }>("/api/settings/activity?limit=50");
      setActivities(d.activities);
    } catch {
      /* keep stale */
    } finally {
      setActivitiesLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    loadActivities();
  }, [load, loadActivities]);

  /** Today at a Glance — real numbers from /api/dashboard, auto-refreshed every 30s. */
  const loadPulse = useCallback(async () => {
    setPulseLoading(true);
    try {
      setPulse(await api<DashboardPulse>("/api/dashboard"));
    } catch {
      /* keep stale */
    } finally {
      setPulseLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadPulse();
  }, [loadPulse]);

  // Online payment gateways — assigned by the platform owner, read-only here.
  useEffect(() => {
    let cancelled = false;
    api<{ gateways: { id: string; provider: string; label: string; mode: string; isDefault: boolean }[] }>("/api/payments/gateways")
      .then((d) => {
        if (!cancelled) setPayGateways(d.gateways ?? []);
      })
      .catch(() => {
        /* optional feature — stay quiet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => { void loadPulse(); }, 30000);
    return () => window.clearInterval(t);
  }, [loadPulse]);

  const dirty = JSON.stringify({ ...form, businessDate: undefined }) !== JSON.stringify({ ...saved, businessDate: undefined });

  const saveProperty = async () => {
    if (!form.name.trim()) {
      toast({ title: "Property name is required", variant: "destructive" });
      return;
    }
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      toast({ title: "Invalid email address", variant: "destructive" });
      return;
    }
    const noShow = Number(form.noShowPercent);
    if (!Number.isFinite(noShow) || noShow < 0 || noShow > 100) {
      toast({ title: "No-show percent must be 0–100", variant: "destructive" });
      return;
    }
    const cutoff = Number(form.auditCutoffHour);
    if (!Number.isInteger(cutoff) || cutoff < 0 || cutoff > 23) {
      toast({ title: "Audit cutoff hour must be 0–23", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const res = await api<{ property: PropertyConfig }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          name: form.name,
          address: form.address,
          city: form.city,
          gstin: form.gstin,
          phone: form.phone,
          email: form.email,
          propertyType: form.propertyType,
          businessCategory: form.businessCategory,
          photoUrl: form.photoUrl,
          noShowPercent: noShow,
          auditCutoffHour: cutoff,
        }),
      });
      const next = { ...form, ...res.property };
      setForm(next);
      setSaved(next);
      if (data) setData({ ...data, property: { ...data.property, ...res.property } });
      toast({ title: "Settings saved", description: "Property configuration updated" });
    } catch (e) {
      toast({ title: "Could not save settings", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ─── Photo upload ────────────────────────────────────────────────────────
  const onPickPhoto = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Images only", description: "Pick a JPG, PNG or WebP photo.", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Photo too large", description: "Maximum size is 5MB.", variant: "destructive" });
      return;
    }
    setPhotoUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = getStoredToken();
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const d = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !d.url) throw new Error(d.error || `Upload failed (${res.status})`);
      // Persist immediately so the new photo survives navigation.
      const put = await api<{ property: PropertyConfig }>("/api/settings", {
        method: "PUT",
        body: JSON.stringify({ photoUrl: d.url }),
      });
      const next = { ...form, ...put.property };
      setForm(next);
      setSaved(next);
      if (data) setData({ ...data, property: { ...data.property, ...put.property } });
      toast({ title: "Photo updated" });
    } catch (e) {
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  // ─── Google Business Profile ─────────────────────────────────────────────
  const googleAction = async (action: "connect" | "disconnect" | "sync", accountEmail?: string) => {
    setGoogleBusy(action);
    try {
      const res = await api<{ googleProfile: GoogleProfile }>("/api/settings/google", {
        method: "POST",
        body: JSON.stringify({ action, accountEmail }),
      });
      const next = { ...form, googleProfile: res.googleProfile };
      setForm(next);
      setSaved((s) => ({ ...s, googleProfile: res.googleProfile }));
      if (data) setData({ ...data, property: { ...data.property, googleProfile: res.googleProfile } });
      if (action === "connect") {
        setGoogleOpen(false);
        toast({ title: "Google Business Profile connected", description: res.googleProfile.accountEmail });
      } else if (action === "sync") {
        toast({ title: "Profile synced", description: "Listing details pushed to Google" });
      } else {
        toast({ title: "Google Business Profile disconnected" });
      }
      // Staff Google-account links change on connect/disconnect — refresh the directory.
      void load();
    } catch (e) {
      toast({ title: "Google action failed", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setGoogleBusy("");
    }
  };

  const copyTenantId = async () => {
    try {
      await navigator.clipboard.writeText(form.id);
      toast({ title: "Tenant ID copied" });
    } catch {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  };

  const addStaff = async () => {
    if (!addForm.name.trim()) return toast({ title: "Name is required", variant: "destructive" });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addForm.email.trim())) {
      return toast({ title: "A valid email is required", variant: "destructive" });
    }
    setAdding(true);
    try {
      // The server ALWAYS generates a temporary password (Vlx@XXXXXXXX) — no
      // password is sent from this form. It is revealed once in the credential
      // dialog; the staff member sets their own permanent password on first login.
      const res = await api<{ staff: StaffMember; tempPassword: string }>("/api/settings/staff", {
        method: "POST",
        body: JSON.stringify({
          ...addForm,
          department: addForm.department === "none" ? "" : addForm.department,
          salary: addForm.salary.trim() === "" ? undefined : Number(addForm.salary),
          joinDate: addForm.joinDate || undefined,
        }),
      });
      if (data) setData({ ...data, staff: [...data.staff, res.staff] });
      setAddOpen(false);
      setCredShown({ name: res.staff.name, email: res.staff.email, role: res.staff.role, tempPassword: res.tempPassword });
      setAddForm({
        name: "", email: "", role: "front_desk", phone: "", googleEmail: "",
        designation: "", department: "none", salary: "", joinDate: "",
      });
      toast({
        title: "Staff added",
        description: `${res.staff.name} · ${ROLE_LABELS[res.staff.role] ?? res.staff.role} · payroll draft created`,
      });
      void load(); // refresh the directory from the server
    } catch (e) {
      toast({ title: "Could not add staff", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setAdding(false);
    }
  };

  const copyTempPassword = async () => {
    if (!credShown) return;
    try {
      await navigator.clipboard.writeText(credShown.tempPassword);
      toast({ title: "Copied", description: "Temporary password is on your clipboard." });
    } catch {
      toast({ title: "Copy failed", description: "Select the password text and copy manually.", variant: "destructive" });
    }
  };

  const openEdit = (s: StaffMember) => {
    setEditing(s);
    setEditForm({ name: s.name, phone: s.phone, role: s.role, active: s.active, password: "", googleEmail: s.googleEmail ?? "" });
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editForm.name.trim()) return toast({ title: "Name is required", variant: "destructive" });
    if (editForm.password && editForm.password.length < 6) {
      return toast({ title: "New password must be at least 6 characters", variant: "destructive" });
    }
    setSavingEdit(true);
    try {
      const res = await api<{ staff: StaffMember }>(`/api/settings/staff/${editing.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editForm.name,
          phone: editForm.phone,
          role: editForm.role,
          active: editForm.active,
          googleEmail: editForm.googleEmail.trim(),
          ...(editForm.password ? { password: editForm.password } : {}),
        }),
      });
      if (data) setData({ ...data, staff: data.staff.map((s) => (s.id === res.staff.id ? res.staff : s)) });
      setEditing(null);
      toast({ title: "Staff updated", description: res.staff.name });
    } catch (e) {
      toast({ title: "Could not update staff", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setSavingEdit(false);
    }
  };

  const toggleActive = async (s: StaffMember) => {
    if (user && s.id === user.id) {
      toast({ title: "You cannot deactivate your own account", variant: "destructive" });
      return;
    }
    setTogglingId(s.id);
    // optimistic
    if (data) setData({ ...data, staff: data.staff.map((x) => (x.id === s.id ? { ...x, active: !s.active } : x)) });
    try {
      await api<{ staff: StaffMember }>(`/api/settings/staff/${s.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !s.active }),
      });
      toast({ title: s.active ? `${s.name} deactivated` : `${s.name} activated` });
    } catch (e) {
      // rollback
      if (data) setData({ ...data, staff: data.staff.map((x) => (x.id === s.id ? { ...x, active: s.active } : x)) });
      toast({ title: "Could not update staff", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setTogglingId(null);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <div className="panel p-5"><div className="skeleton h-40 rounded" /></div>
        <div className="panel p-5"><div className="skeleton h-64 rounded" /></div>
      </div>
    );
  }
  if (!data) {
    return <div className="panel p-6 text-sm text-danger">Could not load settings. Check your connection.</div>;
  }

  const gp = form.googleProfile ?? { connected: false };

  const TOP_TITLES: Record<"property" | "staff" | "whatsapp" | "audit", { title: string; sub: string }> = {
    property: {
      title: "Property Configuration",
      sub: "Manage your hotel's basic information, address, GST details and other essential settings.",
    },
    staff: { title: "Staff Accounts", sub: "Team access, roles and account status." },
    whatsapp: { title: "WhatsApp Cloud API", sub: "Connect your own WhatsApp Business number for guest messaging." },
    audit: { title: "Audit Trail", sub: "Every action across the property, logged." },
  };
  const topTitle = TOP_TITLES[topTab];

  // ─── Staff directory derived state (Staff Accounts tab) ──────────────────
  const staffTotal = data.staff.length;
  const staffActive = data.staff.filter((s) => s.active).length;
  const staffInactive = staffTotal - staffActive;
  const staffGoogle = data.staff.filter((s) => s.googleEmail).length;
  const activePct = staffTotal ? Math.round((staffActive / staffTotal) * 100) : 0;
  const inactivePct = staffTotal ? Math.round((staffInactive / staffTotal) * 100) : 0;
  const staffQueryLc = staffQuery.trim().toLowerCase();
  const filteredStaff = data.staff.filter((s) => {
    if (roleFilter !== "all" && s.role !== roleFilter) return false;
    if (!staffQueryLc) return true;
    return `${s.name} ${s.email} ${ROLE_LABELS[s.role] ?? s.role}`.toLowerCase().includes(staffQueryLc);
  });

  return (
    <div className="space-y-4">
      {/* ── Header + top nav + Tenant ID ───────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-[22px] font-semibold text-pine tracking-tight leading-tight">{topTitle.title}</h1>
          <p className="text-[12.5px] text-muted-ink mt-0.5">{topTitle.sub}</p>
          <div className="inline-flex rounded-lg border border-line-strong bg-plaster-deep/50 p-1 gap-1 mt-3" role="tablist" aria-label="Settings sections">
            {([
              ["property", "Property"],
              ...(data.canManageStaff ? [["staff", "Staff"]] : []),
              ...(isAdmin ? [["whatsapp", "WhatsApp API"]] : []),
              ["audit", "Audit Trail"],
            ] as [string, string][]).map(([key, label]) => (
              <button
                key={key}
                role="tab"
                aria-selected={topTab === key}
                onClick={() => setTopTab(key as "property" | "staff" | "whatsapp" | "audit")}
                className={cn(
                  "h-7 px-3 rounded-md text-[12px] font-medium transition",
                  topTab === key ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="panel px-3.5 py-2.5 min-w-[190px]">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Tenant ID</p>
              <p className="font-display text-[17px] font-semibold text-pine leading-tight mt-0.5" title={form.id}>
                {form.id ? form.id.slice(0, 12) : "—"}
              </p>
            </div>
            <button
              type="button"
              className="btn-ghost h-8 w-8 p-0 shrink-0"
              onClick={copyTenantId}
              aria-label="Copy tenant ID"
              title="Copy tenant ID"
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {topTab === "property" && (
      <>
      <div className="space-y-4">
        <div className="panel">
          <Tabs defaultValue="general">
            <div className="px-4 pt-4 pb-1 border-b border-line">
              <TabsList className="bg-plaster-deep/50 border border-line-strong h-auto rounded-lg p-1 gap-1 w-full sm:w-auto justify-start flex-wrap">
                <TabsTrigger value="general" className="gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium data-[state=active]:bg-pine-700 data-[state=active]:text-panel">
                  <Building2 className="h-3.5 w-3.5" /> General Information
                </TabsTrigger>
                <TabsTrigger value="address" className="gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium data-[state=active]:bg-pine-700 data-[state=active]:text-panel">
                  <MapPin className="h-3.5 w-3.5" /> Address &amp; Contact
                </TabsTrigger>
                <TabsTrigger value="gst" className="gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium data-[state=active]:bg-pine-700 data-[state=active]:text-panel">
                  <FileText className="h-3.5 w-3.5" /> GST &amp; Legal
                </TabsTrigger>
                <TabsTrigger value="branding" className="gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium data-[state=active]:bg-pine-700 data-[state=active]:text-panel">
                  <ImageIcon className="h-3.5 w-3.5" /> Branding &amp; Media
                </TabsTrigger>
              </TabsList>
            </div>

            {/* ── General Information ─────────────────────────────────── */}
            <TabsContent value="general" className="p-4 space-y-4 mt-0">
              <div className="flex flex-col sm:flex-row gap-4 lg:max-w-4xl">
                {/* Photo */}
                <div className="relative shrink-0 w-full sm:w-[190px]">
                  <div className="relative h-[132px] rounded-xl overflow-hidden border border-line bg-plaster-deep/40">
                    {form.photoUrl ? (
                       
                      <img src={form.photoUrl} alt={`${form.name} photo`} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Building2 className="h-8 w-8 text-muted-ink/50" />
                      </div>
                    )}
                    {photoUploading && (
                      <div className="absolute inset-0 bg-pine/50 flex items-center justify-center">
                        <Loader2 className="h-5 w-5 animate-spin text-panel" />
                      </div>
                    )}
                    <button
                      type="button"
                      disabled={!isAdmin || photoUploading}
                      onClick={() => photoInputRef.current?.click()}
                      className="absolute left-2 bottom-2 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-panel/95 text-[11px] font-medium text-pine shadow-sm hover:bg-panel transition disabled:opacity-60"
                    >
                      <Camera className="h-3 w-3" /> Change Photo
                    </button>
                  </div>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => onPickPhoto(e.target.files?.[0])}
                  />
                </div>

                {/* Core fields */}
                <div className="grid sm:grid-cols-2 gap-3 flex-1">
                  <div className="sm:col-span-2">
                    <label className="field-label">Property Name <span className="text-danger">*</span></label>
                    <input className="field" value={form.name} disabled={!isAdmin} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                  </div>
                  <div>
                    <label className="field-label">Property Type</label>
                    <Select value={form.propertyType} onValueChange={(v) => setForm({ ...form, propertyType: v })} disabled={!isAdmin}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {PROPERTY_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="field-label">Business Category</label>
                    <Select value={form.businessCategory} onValueChange={(v) => setForm({ ...form, businessCategory: v })} disabled={!isAdmin}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {BUSINESS_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <label className="field-label">Contact Email <span className="text-danger">*</span></label>
                    <input className="field" type="email" value={form.email} disabled={!isAdmin} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                  </div>
                  <div>
                    <label className="field-label">Contact Phone <span className="text-danger">*</span></label>
                    <input className="field" value={form.phone} disabled={!isAdmin} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                  </div>
                </div>
              </div>

              {/* Google Business Profile — connection card */}
              {isAdmin ? (
                gp.connected ? (
                  <div className="rounded-lg border border-ok/30 bg-ok/8 px-4 py-3 flex flex-wrap items-center gap-4">
                    <div className="flex items-start gap-3 min-w-[220px] flex-1">
                      <span className="h-9 w-9 rounded-full bg-ok/15 flex items-center justify-center shrink-0 mt-0.5">
                        <CheckCircle2 className="h-5 w-5 text-ok" />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13.5px] font-semibold text-ink leading-tight">Google Profile Connected</p>
                        <p className="text-[11.5px] text-muted-ink mt-0.5 truncate">Business Profile: {gp.profileName || form.name}</p>
                        <p className="text-[11.5px] text-muted-ink truncate">Connected as: {gp.accountEmail}</p>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-outline h-9 bg-panel gap-2"
                      onClick={() => setGoogleOpen(true)}
                      disabled={googleBusy !== ""}
                    >
                      <GoogleG className="h-4 w-4" /> Manage Google Profile
                    </button>
                    <div className="flex items-center gap-2">
                      <div className="text-right leading-tight">
                        <p className="text-[10px] uppercase tracking-wider text-muted-ink">Last synced</p>
                        <p className="text-[11.5px] text-ink font-medium">{gp.lastSyncedAt ? fmtDateTime(gp.lastSyncedAt) : "—"}</p>
                      </div>
                      <button
                        type="button"
                        className="btn-ghost h-8 w-8 p-0"
                        onClick={() => googleAction("sync")}
                        disabled={googleBusy === "sync"}
                        aria-label="Sync Google profile now"
                        title="Sync now"
                      >
                        <RefreshCw className={cn("h-3.5 w-3.5", googleBusy === "sync" && "animate-spin")} />
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-lg border border-line bg-plaster/50 px-4 py-3 flex flex-wrap items-center gap-4">
                    <div className="flex items-start gap-3 flex-1 min-w-[220px]">
                      <span className="h-9 w-9 rounded-full bg-plaster-deep flex items-center justify-center shrink-0 mt-0.5">
                        <Store className="h-4.5 w-4.5 text-muted-ink" />
                      </span>
                      <div>
                        <p className="text-[13.5px] font-semibold text-ink leading-tight">Google Business Profile</p>
                        <p className="text-[11.5px] text-muted-ink mt-0.5">Connect to keep your listing fresh on Google Search &amp; Maps.</p>
                      </div>
                    </div>
                    <button type="button" className="btn-pine h-9" onClick={() => { setGoogleEmail(form.email); setGoogleOpen(true); }} disabled={googleBusy !== ""}>
                      Connect
                    </button>
                  </div>
                )
              ) : null}

              {/* Online payment gateways — assigned by the platform owner */}
              <div className="rounded-lg border border-line bg-plaster/50 px-4 py-3 flex flex-wrap items-center gap-4">
                <div className="flex items-start gap-3 flex-1 min-w-[220px]">
                  <span className="h-9 w-9 rounded-full bg-pine-100 flex items-center justify-center shrink-0 mt-0.5">
                    <Wallet className="h-4.5 w-4.5 text-pine-700" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13.5px] font-semibold text-ink leading-tight">Online Payments</p>
                    {payGateways.length === 0 ? (
                      <p className="text-[11.5px] text-muted-ink mt-0.5">
                        No payment gateway assigned yet — the Velurex platform team can connect Razorpay, Cashfree, PayU &amp; more for you.
                      </p>
                    ) : (
                      <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                        {payGateways.map((g) => (
                          <span key={g.id} className="badge border-line-strong bg-panel text-ink">
                            {g.label || GATEWAY_LABELS[g.provider] || g.provider}
                            <span className={cn("ml-1 text-[10px] font-semibold", g.mode === "live" ? "text-ok" : "text-warn")}>
                              {g.mode.toUpperCase()}
                            </span>
                            {g.isDefault && <span className="ml-1 text-[10px] text-brass">· default</span>}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <span className="text-[11px] text-muted-ink max-w-[240px] leading-snug">
                  Configured by the platform team. Gateways appear on POS settle &amp; folio payment screens.
                </span>
              </div>
            </TabsContent>

            {/* ── Address & Contact ───────────────────────────────────── */}
            <TabsContent value="address" className="p-4 space-y-3 mt-0 lg:max-w-3xl">
              <div>
                <label className="field-label">Street Address</label>
                <input className="field" value={form.address} disabled={!isAdmin} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="field-label">City</label>
                  <input className="field" value={form.city} disabled={!isAdmin} onChange={(e) => setForm({ ...form, city: e.target.value })} />
                </div>
                <div>
                  <label className="field-label">Contact Phone</label>
                  <input className="field" value={form.phone} disabled={!isAdmin} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
                </div>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="sm:col-span-2">
                  <label className="field-label">Contact Email</label>
                  <input className="field" type="email" value={form.email} disabled={!isAdmin} onChange={(e) => setForm({ ...form, email: e.target.value })} />
                </div>
              </div>
              <p className="text-[11.5px] text-muted-ink">
                This address appears on GST invoices, booking confirmations and your public booking page.
              </p>
            </TabsContent>

            {/* ── GST & Legal ─────────────────────────────────────────── */}
            <TabsContent value="gst" className="p-4 space-y-3 mt-0 lg:max-w-3xl">
              <div>
                <label className="field-label">GSTIN</label>
                <input className="field uppercase" value={form.gstin} disabled={!isAdmin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="field-label">No-show charge (% of first night)</label>
                  <input
                    type="number" min={0} max={100} className="field" value={form.noShowPercent} disabled={!isAdmin}
                    onChange={(e) => setForm({ ...form, noShowPercent: Number(e.target.value) })}
                  />
                </div>
                <div>
                  <label className="field-label">Night audit cutoff hour (0–23)</label>
                  <input
                    type="number" min={0} max={23} className="field" value={form.auditCutoffHour} disabled={!isAdmin}
                    onChange={(e) => setForm({ ...form, auditCutoffHour: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5 text-[11.5px] text-muted-ink flex items-center gap-2">
                <CalendarClock className="h-3.5 w-3.5 text-brass shrink-0" />
                Business date: <span className="font-medium text-ink">{fmtDate(form.businessDate)}</span> — rolled automatically by the night audit.
              </div>
            </TabsContent>

            {/* ── Branding & Media ────────────────────────────────────── */}
            <TabsContent value="branding" className="p-4 space-y-3 mt-0">
              <div className="flex flex-wrap items-center gap-4">
                <div className="relative h-24 w-36 rounded-lg overflow-hidden border border-line bg-plaster-deep/40 shrink-0">
                  {form.photoUrl ? (
                     
                    <img src={form.photoUrl} alt={`${form.name} photo`} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center"><ImageIcon className="h-6 w-6 text-muted-ink/50" /></div>
                  )}
                </div>
                <div className="space-y-2">
                  <p className="text-[13px] font-medium text-ink">Property photo</p>
                  <p className="text-[11.5px] text-muted-ink max-w-sm">Shown on the booking engine, confirmations and OTA listing previews. JPG/PNG/WebP up to 5MB.</p>
                  <button type="button" className="btn-outline h-8 text-[12px]" disabled={!isAdmin || photoUploading} onClick={() => photoInputRef.current?.click()}>
                    {photoUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImageIcon className="h-3.5 w-3.5" />}
                    Upload photo
                  </button>
                </div>
              </div>
              <div className="border-t border-line pt-3 flex flex-wrap gap-2">
                <a className="btn-outline h-8 text-[12px]" href="/book" target="_blank" rel="noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" /> Open public listing
                </a>
                <a className="btn-outline h-8 text-[12px]" href="/book" target="_blank" rel="noreferrer">
                  <Eye className="h-3.5 w-3.5" /> Preview booking engine
                </a>
              </div>
            </TabsContent>

            {/* ── Save bar (shared across tabs) ───────────────────────── */}
            <div className="px-4 py-3 border-t border-line flex flex-wrap items-center justify-between gap-2">
              {!isAdmin ? (
                <p className="text-xs text-muted-ink">Read-only — only the Hotel Admin can change property settings.</p>
              ) : dirty ? (
                <p className="text-xs font-medium text-brass flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-brass animate-pulse" /> Unsaved changes
                </p>
              ) : (
                <p className="text-xs text-muted-ink">
                  Pricing: {data.property.pricingEnabled ? "enabled" : "disabled"} · occupancy threshold {data.property.occupancyThreshold}% · suggested increase +{data.property.rateIncreasePercent}%
                </p>
              )}
              {isAdmin && (
                <button className="btn-pine" onClick={saveProperty} disabled={saving || !dirty}>
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  Save
                </button>
              )}
            </div>
          </Tabs>
        </div>

        {/* ── Today at a Glance — live operations pulse (fills the space beside Live Activity) ── */}
        <div className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <div className="flex items-center gap-2 flex-wrap">
              <TrendingUp className="h-4 w-4 text-brass" />
              <p className="text-[13px] font-semibold text-pine">Today at a Glance</p>
              <span className="badge border-line-strong bg-plaster text-muted-ink text-[9.5px]">
                <CalendarDays className="h-3 w-3 mr-1" /> Business date {fmtDate(pulse?.businessDate)}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-ink">auto 30s</span>
              <button className="btn-ghost h-7 w-7 p-0" onClick={loadPulse} disabled={pulseLoading} aria-label="Refresh operations pulse" title="Refresh now">
                <RefreshCw className={cn("h-3.5 w-3.5", pulseLoading && "animate-spin")} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5">
            <GlanceTile icon={BedDouble} label="Occupancy" value={pulse ? `${pulse.kpis.occupancy}%` : "—"} delta={pulse?.kpis.occupancyDelta} sub={pulse ? `${pulse.counts.occupied}/${pulse.counts.totalRooms} rooms` : undefined} />
            <GlanceTile icon={IndianRupee} label="ADR" value={pulse ? inr(pulse.kpis.adr) : "—"} delta={pulse?.kpis.adrDelta} />
            <GlanceTile icon={TrendingUp} label="RevPAR" value={pulse ? inr(pulse.kpis.revpar) : "—"} />
            <GlanceTile icon={Wallet} label="Revenue" value={pulse ? inr(pulse.kpis.revenueToday) : "—"} delta={pulse?.kpis.revenueDelta} />
            <GlanceTile icon={LogIn} label="In-House" value={pulse ? String(pulse.counts.inHouse) : "—"} sub={pulse ? `${pulse.counts.arrivals} arr · ${pulse.counts.departures} dep` : undefined} />
            <GlanceTile icon={ReceiptIndianRupee} label="Balance" value={pulse ? inr(pulse.kpis.outstanding) : "—"} tone="brass" />
          </div>

          {/* Room status — segmented live bar */}
          <div className="mt-4">
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-muted-ink">Room status</p>
              <p className="text-[10.5px] text-muted-ink">{pulse ? `${pulse.counts.totalRooms} rooms` : "…"}</p>
            </div>
            <div className="flex h-2.5 rounded-full overflow-hidden bg-plaster-deep/60" role="img" aria-label="Room status breakdown">
              {pulse && (
                <>
                  <div className="h-full bg-pine-700 transition-all duration-500" style={{ width: `${(pulse.counts.occupied / Math.max(1, pulse.counts.totalRooms)) * 100}%` }} title={`Occupied: ${pulse.counts.occupied}`} />
                  <div className="h-full bg-ok/70 transition-all duration-500" style={{ width: `${(pulse.counts.vacant / Math.max(1, pulse.counts.totalRooms)) * 100}%` }} title={`Vacant / clean: ${pulse.counts.vacant}`} />
                  <div className="h-full bg-warn/80 transition-all duration-500" style={{ width: `${(pulse.counts.dirty / Math.max(1, pulse.counts.totalRooms)) * 100}%` }} title={`Dirty: ${pulse.counts.dirty}`} />
                  <div className="h-full bg-danger/80 transition-all duration-500" style={{ width: `${(pulse.counts.outOfOrder / Math.max(1, pulse.counts.totalRooms)) * 100}%` }} title={`Out of order: ${pulse.counts.outOfOrder}`} />
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
              {pulse && (
                <>
                  <GlanceLegend dot="bg-pine-700" label="Occupied" n={pulse.counts.occupied} />
                  <GlanceLegend dot="bg-ok/70" label="Vacant / clean" n={pulse.counts.vacant} />
                  <GlanceLegend dot="bg-warn/80" label="Dirty" n={pulse.counts.dirty} />
                  <GlanceLegend dot="bg-danger/80" label="Out of order" n={pulse.counts.outOfOrder} />
                </>
              )}
            </div>
          </div>
        </div>

        {/* ── Arrivals & Departures today ──────────────────────────────── */}
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="panel p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <LogIn className="h-4 w-4 text-ok" />
                <p className="text-[13px] font-semibold text-pine">Arrivals Today</p>
              </div>
              <span className="badge border-ok/40 bg-ok/10 text-ok">{pulse ? pulse.counts.arrivals : "—"}</span>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto scroll-slim">
              {(pulse?.checkIns ?? []).slice(0, 6).map((c) => (
                <div key={c.id} className="flex items-center gap-2.5 rounded-md border border-line/60 bg-plaster/30 px-2.5 py-2">
                  <span className="h-7 w-7 rounded-full bg-pine-100/70 text-pine-700 text-[10px] font-semibold flex items-center justify-center shrink-0" aria-hidden>{initials(c.guestName)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-ink leading-tight truncate">{c.guestName}</p>
                    <p className="text-[10px] text-muted-ink">Room {c.roomNumber} · {inr(c.totalAmount)}</p>
                  </div>
                  <span className={cn("badge text-[9px] shrink-0", c.status === "checked_in" ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn")}>
                    {c.status === "checked_in" ? "in-house" : "expected"}
                  </span>
                </div>
              ))}
              {pulse && pulse.checkIns.length === 0 && <p className="text-[11.5px] text-muted-ink py-3 text-center">No arrivals scheduled today</p>}
              {!pulse && <p className="text-[11.5px] text-muted-ink py-3 text-center">Loading…</p>}
            </div>
          </div>

          <div className="panel p-4">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <LogOut className="h-4 w-4 text-brass" />
                <p className="text-[13px] font-semibold text-pine">Departures Today</p>
              </div>
              <span className="badge border-brass/40 bg-brass-50 text-brass">{pulse ? pulse.counts.departures : "—"}</span>
            </div>
            <div className="space-y-1.5 max-h-56 overflow-y-auto scroll-slim">
              {(pulse?.checkOuts ?? []).slice(0, 6).map((c) => (
                <div key={c.id} className="flex items-center gap-2.5 rounded-md border border-line/60 bg-plaster/30 px-2.5 py-2">
                  <span className="h-7 w-7 rounded-full bg-brass-50 text-brass text-[10px] font-semibold flex items-center justify-center shrink-0" aria-hidden>{initials(c.guestName)}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] font-medium text-ink leading-tight truncate">{c.guestName}</p>
                    <p className="text-[10px] text-muted-ink">Room {c.roomNumber} · {fmtDate(c.checkOut)}</p>
                  </div>
                  <span className={cn("badge text-[9px] shrink-0", c.balance > 0 ? "border-danger/40 bg-danger/10 text-danger" : "border-ok/40 bg-ok/10 text-ok")}>
                    {c.balance > 0 ? `${inr(c.balance)} due` : "settled"}
                  </span>
                </div>
              ))}
              {pulse && pulse.checkOuts.length === 0 && <p className="text-[11.5px] text-muted-ink py-3 text-center">No departures scheduled today</p>}
              {!pulse && <p className="text-[11.5px] text-muted-ink py-3 text-center">Loading…</p>}
            </div>
          </div>
        </div>

        {/* ── Quick Actions — the only side panel kept in this tab ────── */}
        <div className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <p className="text-[13px] font-semibold text-pine">Quick Actions</p>
            <p className="text-[11px] text-muted-ink">Public site &amp; booking engine, one click away</p>
          </div>
          <div className="grid sm:grid-cols-2 gap-2.5">
            <a className="btn-outline justify-between h-10 px-4" href="/book" target="_blank" rel="noreferrer">
              <span className="inline-flex items-center gap-2"><Globe className="h-4 w-4 text-brass" /> View Public Listing</span>
              <ExternalLink className="h-4 w-4 text-muted-ink" />
            </a>
            <a className="btn-outline justify-between h-10 px-4" href="/book" target="_blank" rel="noreferrer">
              <span className="inline-flex items-center gap-2"><Eye className="h-4 w-4 text-brass" /> Preview Booking Engine</span>
              <ChevronRight className="h-4 w-4 text-muted-ink" />
            </a>
          </div>
        </div>
      </div>
      </>
      )}

      {topTab === "staff" && data.canManageStaff && (
        <div className="space-y-4">
          {/* KPI summary — reference layout */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
            <div className="panel p-4 flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-pine-100/70 flex items-center justify-center shrink-0"><Users className="h-4.5 w-4.5 text-pine-700" /></span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink leading-none">Total Staff</p>
                <p className="font-display text-[22px] font-semibold text-pine leading-tight mt-1">{staffTotal}</p>
                <p className="text-[10.5px] text-muted-ink mt-0.5">Across all roles</p>
              </div>
            </div>
            <div className="panel p-4 flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-ok/10 flex items-center justify-center shrink-0"><UserCheck className="h-4.5 w-4.5 text-ok" /></span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink leading-none">Active</p>
                <p className="font-display text-[22px] font-semibold text-ok leading-tight mt-1">{staffActive}</p>
                <p className="text-[10.5px] text-muted-ink mt-0.5">{activePct}% active</p>
              </div>
            </div>
            <div className="panel p-4 flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-danger/10 flex items-center justify-center shrink-0"><UserX className="h-4.5 w-4.5 text-danger" /></span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink leading-none">Inactive</p>
                <p className="font-display text-[22px] font-semibold text-danger leading-tight mt-1">{staffInactive}</p>
                <p className="text-[10.5px] text-muted-ink mt-0.5">{inactivePct}% inactive</p>
              </div>
            </div>
            <div className="panel p-4 flex items-start gap-3">
              <span className="h-9 w-9 rounded-lg bg-plaster-deep flex items-center justify-center shrink-0"><GoogleG className="h-4 w-4" /></span>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink leading-none">Google Accounts</p>
                <p className="font-display text-[22px] font-semibold text-pine leading-tight mt-1">{staffGoogle}</p>
                <p className={cn("text-[10.5px] mt-0.5", gp.connected ? "text-ok font-medium" : "text-muted-ink")}>
                  {gp.connected ? "Workspace connected" : "Workspace off"}
                </p>
              </div>
            </div>
          </div>

          <div className="grid lg:grid-cols-3 gap-4 items-start">
            {/* Directory: search / filter / table */}
            <div className="lg:col-span-2 panel">
              <div className="p-4 border-b border-line flex flex-wrap items-center gap-2.5">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink/70 pointer-events-none" />
                  <input
                    className="field pl-9"
                    placeholder="Search staff by name, email, or role…"
                    value={staffQuery}
                    onChange={(e) => setStaffQuery(e.target.value)}
                    aria-label="Search staff"
                  />
                </div>
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="w-[150px]" aria-label="Filter by role"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Roles</SelectItem>
                    {ROLE_DEFS.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <button className="btn-pine" onClick={() => setAddOpen(true)}>
                  <UserPlus className="h-4 w-4" />
                  Add Staff
                </button>
              </div>
              <div className="overflow-x-auto scroll-slim">
                <table className="w-full min-w-[900px]">
                  <thead>
                    <tr>
                      <th className="th sticky left-0 z-10 bg-panel">Name</th>
                      <th className="th">Email</th>
                      <th className="th">Role</th>
                      <th className="th">Phone</th>
                      <th className="th">Status</th>
                      <th className="th">Google Account</th>
                      <th className="th">Joined</th>
                      <th className="th text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStaff.map((s) => (
                      <tr key={s.id} className={cn("group hover:bg-plaster/50", !s.active && "opacity-60")}>
                        <td className="td sticky left-0 z-10 bg-panel group-hover:bg-plaster/50 transition-colors">
                          <div className="flex items-center gap-2.5 min-w-0">
                            <span
                              className={cn("h-8 w-8 rounded-full flex items-center justify-center text-[10.5px] font-semibold shrink-0", ROLE_DEFS.find((r) => r.key === s.role)?.avatar ?? "bg-plaster-deep text-muted-ink")}
                              aria-hidden
                            >
                              {initials(s.name)}
                            </span>
                            <div className="min-w-0">
                              <p className="font-medium text-pine leading-tight truncate">
                                {s.name}
                                {s.id === user?.id && <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wider text-brass">(you)</span>}
                              </p>
                              <p className="text-[10px] text-muted-ink leading-tight">{ROLE_LABELS[s.role] ?? s.role}</p>
                            </div>
                          </div>
                        </td>
                        <td className="td text-muted-ink">{s.email}</td>
                        <td className="td">
                          <span className={cn("badge", ROLE_BADGE[s.role] ?? "border-line-strong bg-plaster text-muted-ink")}>
                            {ROLE_LABELS[s.role] ?? s.role}
                          </span>
                        </td>
                        <td className="td whitespace-nowrap">{s.phone || "—"}</td>
                        <td className="td">
                          <span className={cn("badge", s.active ? "border-ok/40 bg-ok/10 text-ok" : "border-danger/40 bg-danger/10 text-danger")}>
                            <span className={cn("h-1.5 w-1.5 rounded-full mr-1", s.active ? "bg-ok" : "bg-danger")} />
                            {s.active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="td">
                          {s.googleEmail ? (
                            <span className="inline-flex items-center gap-1.5 text-ok text-[12px] font-medium" title={`Signs in with ${s.googleEmail}`}>
                              <GoogleG className="h-3.5 w-3.5" /> Connected
                            </span>
                          ) : (
                            <span className="text-muted-ink">—</span>
                          )}
                        </td>
                        <td className="td whitespace-nowrap text-muted-ink">{fmtDate(s.createdAt)}</td>
                        <td className="td">
                          <div className="flex items-center justify-end gap-1">
                            <button className="btn-ghost h-8 w-8 p-0" onClick={() => openEdit(s)} aria-label={`Edit ${s.name}`} title="Edit staff">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button className="btn-ghost h-8 w-8 p-0" aria-label={`More actions for ${s.name}`} title="More actions" disabled={togglingId === s.id}>
                                  <MoreVertical className="h-3.5 w-3.5" />
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-48">
                                <DropdownMenuItem onClick={() => openEdit(s)}>
                                  <Pencil className="h-3.5 w-3.5 mr-2" /> Edit details
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  disabled={s.id === user?.id}
                                  onClick={() => toggleActive(s)}
                                  className={s.active ? "text-danger focus:text-danger" : "text-ok focus:text-ok"}
                                >
                                  {s.active
                                    ? <><UserX className="h-3.5 w-3.5 mr-2" /> Deactivate account</>
                                    : <><UserCheck className="h-3.5 w-3.5 mr-2" /> Activate account</>}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {filteredStaff.length === 0 && (
                      <tr>
                        <td className="td text-center text-muted-ink" colSpan={8}>
                          {staffTotal === 0 ? "No staff accounts yet — add your first team member" : "No staff match your search"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 border-t border-line flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-ink">Showing {filteredStaff.length} of {staffTotal} team members</p>
                <p className="text-[11px] text-muted-ink">{staffGoogle} linked to Google</p>
              </div>
            </div>

            {/* Right rail — Role Permissions + Google Integration */}
            <div className="space-y-4">
              <div className="panel p-4">
                <div className="flex items-center gap-2 mb-3">
                  <ShieldCheck className="h-4 w-4 text-brass" />
                  <p className="text-[13px] font-semibold text-pine">Role Permissions</p>
                </div>
                <div className="space-y-2.5">
                  {ROLE_DEFS.map((r) => {
                    const count = data.staff.filter((s) => s.role === r.key).length;
                    const Icon = r.icon;
                    return (
                      <div key={r.key} className="flex items-start gap-2.5 rounded-md border border-line/60 bg-plaster/30 px-2.5 py-2">
                        <span className={cn("h-8 w-8 rounded-full flex items-center justify-center shrink-0", r.avatar)} aria-hidden>
                          <Icon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[12.5px] font-semibold text-ink leading-tight">{r.label}</p>
                          <p className="text-[10.5px] text-muted-ink leading-snug mt-0.5">{r.desc}</p>
                        </div>
                        <span className={cn("badge shrink-0 text-[9.5px] px-1.5", r.chip)}>
                          {count} {count === 1 ? "member" : "members"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="panel p-4">
                <div className="flex items-start gap-2.5">
                  <span className="h-9 w-9 rounded-full bg-plaster-deep flex items-center justify-center shrink-0"><GoogleG className="h-4 w-4" /></span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-pine">Google Integration</p>
                    <p className="text-[11px] text-muted-ink leading-snug mt-0.5">
                      {gp.connected
                        ? "Google Workspace is connected. Staff can sign in with their Google accounts."
                        : "Connect Google Workspace to let staff sign in with their Google accounts."}
                    </p>
                    <p className={cn("text-[10.5px] font-medium mt-1.5", gp.connected ? "text-ok" : "text-muted-ink")}>
                      {staffGoogle} of {staffTotal} linked · workspace {gp.connected ? "live" : "off"}
                    </p>
                  </div>
                </div>
                <button className="btn-outline w-full mt-3" onClick={() => setGoogleOpen(true)}>
                  Manage Integration
                </button>
              </div>

              {/* Account security — 2FA for the signed-in user */}
              <TwoFactorCard />
            </div>
          </div>
        </div>
      )}

      {/* ── WhatsApp Cloud API self-service connect ─────────────────── */}
      {topTab === "whatsapp" && isAdmin && <WhatsAppConnectPanel isAdmin={isAdmin} />}

      {/* ── Audit trail ──────────────────────────────────────────────── */}
      {topTab === "audit" && (
        <div className="space-y-4">
          <div className="panel">
            <div className="panel-header">
              <div className="flex items-center gap-2">
                <ScrollText className="h-4 w-4 text-brass" />
                <p className="panel-title">Activity Log</p>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-ink">{activities?.length ?? 0} recent entries</span>
                <button className="btn-outline h-8" onClick={loadActivities} disabled={activitiesLoading}>
                  <RefreshCw className={cn("h-3.5 w-3.5", activitiesLoading && "animate-spin")} />
                  Refresh
                </button>
              </div>
            </div>
            <div className="overflow-y-auto max-h-96 scroll-slim">
              <table className="w-full min-w-[720px]">
                <thead className="sticky top-0">
                  <tr>
                    <th className="th">Time</th>
                    <th className="th">Staff</th>
                    <th className="th">Action</th>
                    <th className="th">Entity</th>
                    <th className="th">Details</th>
                  </tr>
                </thead>
                <tbody>
                  {(activities ?? []).map((a) => (
                    <tr key={a.id} className="hover:bg-plaster/50">
                      <td className="td whitespace-nowrap text-muted-ink">{fmtDateTime(a.createdAt)}</td>
                      <td className="td font-medium text-pine">{a.staffName || "System"}</td>
                      <td className="td">
                        <span className={cn("badge", actionBadge(a.action))}>{a.action.replace(/_/g, " ")}</span>
                      </td>
                      <td className="td text-muted-ink">{a.entity || "—"}</td>
                      <td className="td text-muted-ink max-w-[340px] truncate" title={a.details}>{a.details || "—"}</td>
                    </tr>
                  ))}
                  {activities && activities.length === 0 && (
                    <tr><td className="td text-center text-muted-ink" colSpan={5}>No activity recorded yet</td></tr>
                  )}
                  {!activities && activitiesLoading && (
                    <tr><td className="td text-center text-muted-ink" colSpan={5}>Loading…</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Google connect / manage dialog ─────────────────────────────── */}
      <Dialog open={googleOpen} onOpenChange={setGoogleOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GoogleG className="h-4 w-4" /> Google Business Profile
            </DialogTitle>
            <DialogDescription>
              {gp.connected
                ? "Your listing stays fresh on Google Search & Maps. Sync pushes name, category, photo and contact details."
                : "Connect your Google account to keep the hotel's listing synced with Search & Maps."}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <label className="field-label">Google account email</label>
              <input
                className="field"
                type="email"
                value={googleEmail}
                disabled={gp.connected}
                onChange={(e) => setGoogleEmail(e.target.value)}
                placeholder="owner@royalgrand.in"
              />
            </div>
            {gp.connected && (
              <div className="rounded-md border border-ok/30 bg-ok/8 px-3 py-2.5 text-[12px] space-y-1">
                <p className="flex items-center gap-1.5 text-ok font-medium"><CheckCircle2 className="h-3.5 w-3.5" /> Connected</p>
                <p className="text-muted-ink">Business Profile: {gp.profileName || form.name}</p>
                <p className="text-muted-ink">Last synced: {gp.lastSyncedAt ? fmtDateTime(gp.lastSyncedAt) : "—"}</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            {gp.connected && (
              <button
                className="btn-danger mr-auto"
                onClick={() => googleAction("disconnect")}
                disabled={googleBusy !== ""}
              >
                {googleBusy === "disconnect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unlink className="h-4 w-4" />}
                Disconnect
              </button>
            )}
            <button className="btn-outline" onClick={() => setGoogleOpen(false)} disabled={googleBusy !== ""}>Close</button>
            {gp.connected ? (
              <button className="btn-pine" onClick={() => googleAction("sync")} disabled={googleBusy !== ""}>
                {googleBusy === "sync" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Sync now
              </button>
            ) : (
              <button className="btn-pine" onClick={() => googleAction("connect", googleEmail)} disabled={googleBusy !== ""}>
                {googleBusy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleG className="h-4 w-4" />}
                Connect
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Add Staff dialog ───────────────────────────────────────────── */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Staff</DialogTitle>
            <DialogDescription>Create a staff account with role-based access and HR profile.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <label className="field-label">Full name</label>
              <input className="field" value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })} placeholder="e.g. Anita Rao" />
            </div>
            <div>
              <label className="field-label">Email (login)</label>
              <input className="field" type="email" value={addForm.email} onChange={(e) => setAddForm({ ...addForm, email: e.target.value })} placeholder="anita@velurex.in" />
            </div>
            <div>
              <label className="field-label">Role</label>
              <Select value={addForm.role} onValueChange={(v) => setAddForm({ ...addForm, role: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border border-brass/35 bg-brass-50 px-3 py-2.5 flex items-start gap-2.5">
              <KeyRound className="h-4 w-4 text-brass shrink-0 mt-0.5" />
              <p className="text-[12.5px] leading-snug text-pine">
                A <span className="font-semibold">temporary password</span> is generated automatically — the staff
                member sets their own password on first login.
              </p>
            </div>
            <div>
              <label className="field-label">Phone (optional)</label>
              <input className="field" value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })} placeholder="+91 …" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Designation (optional)</label>
                <input
                  className="field" value={addForm.designation}
                  onChange={(e) => setAddForm({ ...addForm, designation: e.target.value })}
                  placeholder="e.g. Housekeeper"
                />
              </div>
              <div>
                <label className="field-label">Department (optional)</label>
                <Select value={addForm.department} onValueChange={(v) => setAddForm({ ...addForm, department: v })}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">— None —</SelectItem>
                    {DEPARTMENTS.map((d) => (
                      <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Monthly salary ₹ (optional)</label>
                <input
                  className="field" type="number" min="0" step="100"
                  value={addForm.salary}
                  onChange={(e) => setAddForm({ ...addForm, salary: e.target.value })}
                  placeholder="e.g. 18000"
                />
              </div>
              <div>
                <label className="field-label">Join date (optional)</label>
                <input
                  className="field" type="date"
                  value={addForm.joinDate}
                  onChange={(e) => setAddForm({ ...addForm, joinDate: e.target.value })}
                />
              </div>
            </div>
            <div className="rounded-md border border-ok/40 bg-ok/10 px-3 py-2.5 flex items-start gap-2.5">
              <Wallet className="h-4 w-4 text-ok shrink-0 mt-0.5" />
              <p className="text-[12.5px] leading-snug text-pine">
                A <span className="font-semibold">payroll draft</span> for this month is created automatically — the new
                staff member appears in the payroll register instantly.
              </p>
            </div>
            <div>
              <label className="field-label">Google account (optional)</label>
              <input
                className="field" type="email" value={addForm.googleEmail}
                onChange={(e) => setAddForm({ ...addForm, googleEmail: e.target.value })}
                placeholder="staff@gmail.com — enables Google sign-in"
              />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setAddOpen(false)} disabled={adding}>Cancel</button>
            <button className="btn-pine" onClick={addStaff} disabled={adding}>
              {adding && <Loader2 className="h-4 w-4 animate-spin" />}
              Create account
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── One-time temporary password reveal (after staff create) ───── */}
      <Dialog open={credShown !== null} onOpenChange={(o) => { if (!o) setCredShown(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Temporary password for {credShown?.name}</DialogTitle>
            <DialogDescription>
              {credShown?.email}{credShown ? ` · ${ROLE_LABELS[credShown.role] ?? credShown.role}` : ""} · share it with the staff member over a secure channel.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 flex items-start gap-2 text-[13px] text-warn">
            <Clock3 className="h-4 w-4 shrink-0 mt-0.5" />
            <span>This password is shown only once. The staff member must set a permanent password on first login.</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-md border border-line bg-plaster px-3 py-2 font-mono text-[15px] tracking-widest text-pine select-all">
              {credShown?.tempPassword}
            </code>
            <button className="btn-outline" onClick={() => void copyTempPassword()}>
              <Copy className="h-4 w-4" /> Copy
            </button>
          </div>
          <DialogFooter>
            <button className="btn-pine" onClick={() => setCredShown(null)}>Done</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Edit Staff dialog ──────────────────────────────────────────── */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Staff</DialogTitle>
            <DialogDescription>
              {editing?.email} · role & access changes apply on next login for password resets.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-2">
            <div>
              <label className="field-label">Full name</label>
              <input className="field" value={editForm.name} onChange={(e) => setEditForm({ ...editForm, name: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Phone</label>
              <input className="field" value={editForm.phone} onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Google account (link for Google sign-in)</label>
              <input
                className="field" type="email" value={editForm.googleEmail}
                onChange={(e) => setEditForm({ ...editForm, googleEmail: e.target.value })}
                placeholder="Leave empty to unlink"
              />
            </div>
            <div>
              <label className="field-label">Role</label>
              <Select value={editForm.role} onValueChange={(v) => setEditForm({ ...editForm, role: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(ROLE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between rounded-md border border-line px-3 py-2.5">
              <div>
                <p className="text-sm font-medium text-ink">Account active</p>
                <p className="text-[11px] text-muted-ink">Deactivated accounts cannot sign in</p>
              </div>
              <Switch checked={editForm.active} onCheckedChange={(v) => setEditForm({ ...editForm, active: v })} />
            </div>
            <div>
              <label className="field-label">Reset password (optional, min 6)</label>
              <input
                className="field" type="password" value={editForm.password}
                onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                placeholder="Leave blank to keep current password"
              />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setEditing(null)} disabled={savingEdit}>Cancel</button>
            <button className="btn-pine" onClick={saveEdit} disabled={savingEdit}>
              {savingEdit && <Loader2 className="h-4 w-4 animate-spin" />}
              Save changes
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Live connection row ───────────────────────────────────────────────────────

// ─── Today-at-a-Glance tiles ───────────────────────────────────────────────────

function GlanceTile({
  icon: Icon, label, value, sub, delta, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  delta?: number;
  tone?: "brass";
}) {
  return (
    <div className="rounded-lg border border-line bg-plaster/30 px-3 py-2.5 min-w-0">
      <div className="flex items-center justify-between gap-1">
        <p className="text-[9.5px] font-semibold uppercase tracking-[0.05em] text-muted-ink truncate">{label}</p>
        <Icon className="h-3.5 w-3.5 text-muted-ink/70 shrink-0" />
      </div>
      <p className={cn("font-display text-[19px] font-semibold leading-tight mt-1 truncate", tone === "brass" ? "text-brass" : "text-pine")}>
        {value}
      </p>
      {typeof delta === "number" && (
        <p className={cn("text-[10px] font-medium flex items-center gap-0.5 mt-0.5", delta >= 0 ? "text-ok" : "text-danger")}>
          {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
          {Math.abs(delta)}% vs last week
        </p>
      )}
      {sub && <p className="text-[10px] text-muted-ink mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

function GlanceLegend({ dot, label, n }: { dot: string; label: string; n: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[10.5px] text-muted-ink">
      <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
      {label} <span className="font-semibold text-ink tabular-nums">{n}</span>
    </span>
  );
}
