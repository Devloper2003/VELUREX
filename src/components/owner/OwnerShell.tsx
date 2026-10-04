"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard, BarChart3, Building2, UserPlus, Users, Route,
  CreditCard, ReceiptIndianRupee, TicketPercent, LifeBuoy, Megaphone,
  ScrollText, Network, Settings2, Activity, UserCog, LogOut, Menu, X,
  ChevronDown, ShieldCheck, Search, Command, CornerDownLeft, FlaskConical,
} from "lucide-react";
import { useSession } from "@/lib/store";
import { useOwner, type OwnerViewKey } from "@/lib/owner-store";
import {
  isPlatformRole, PLATFORM_ROLE_LABELS, canReadView,
  type PlatformRole,
} from "@/lib/owner-roles";
import { BrandMark } from "@/components/auth/LoginScreen";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { VersionBadge } from "@/components/shell/VersionBadge";

import OwnerDashboardView from "./views/DashboardView";
import OwnerAnalyticsView from "./views/AnalyticsView";
import OwnerBusinessesView from "./views/BusinessesView";
import OwnerAddBusinessView from "./views/AddBusinessView";
import OwnerUsersView from "./views/UsersView";
import OwnerOnboardingView from "./views/OnboardingView";
import OwnerSubscriptionsView from "./views/SubscriptionsView";
import OwnerBillingView from "./views/BillingView";
import OwnerCouponsView from "./views/CouponsView";
import OwnerTicketsView from "./views/TicketsView";
import OwnerAnnouncementsView from "./views/AnnouncementsView";
import OwnerAuditView from "./views/AuditView";
import OwnerIntegrationsView from "./views/IntegrationsView";
import OwnerSettingsView from "./views/SettingsView";
import OwnerHealthView from "./views/HealthView";
import OwnerTeamView from "./views/TeamView";

const VIEW_TITLES: Record<OwnerViewKey, { title: string; sub: string }> = {
  dashboard: { title: "Platform Dashboard", sub: "Velurex HMS · business health at a glance" },
  analytics: { title: "Analytics", sub: "MRR, churn, ARPU, LTV, conversion & usage" },
  businesses: { title: "Businesses", sub: "Every property on the platform" },
  "add-business": { title: "Add Business", sub: "Onboard a new hotel in one flow" },
  users: { title: "Users", sub: "All staff accounts across businesses" },
  onboarding: { title: "Onboarding", sub: "Leads pipeline & activation checklists" },
  subscriptions: { title: "Subscriptions", sub: "Plans, renewals, add-ons & overrides" },
  billing: { title: "Billing & Invoices", sub: "GST invoices, payments & revenue export" },
  coupons: { title: "Coupons & Offers", sub: "Discount and trial-extension codes" },
  tickets: { title: "Support Tickets", sub: "Tenant issues, replies & internal notes" },
  announcements: { title: "Announcements", sub: "In-app banners by audience" },
  audit: { title: "Audit Logs", sub: "Every sensitive platform action" },
  integrations: { title: "Integrations", sub: "OTA connections across tenants" },
  settings: { title: "Platform Settings", sub: "Keys, templates, billing defaults" },
  health: { title: "System Health", sub: "Jobs, queue & backups" },
  team: { title: "Team & Roles", sub: "Platform staff administration" },
};

const NAV: { group: string; items: { key: OwnerViewKey; label: string; icon: React.ComponentType<{ className?: string }> }[] }[] = [
  {
    group: "Overview",
    items: [
      { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { key: "analytics", label: "Analytics", icon: BarChart3 },
    ],
  },
  {
    group: "Clients",
    items: [
      { key: "businesses", label: "Businesses", icon: Building2 },
      { key: "add-business", label: "Add Business", icon: UserPlus },
      { key: "users", label: "Users", icon: Users },
      { key: "onboarding", label: "Onboarding", icon: Route },
    ],
  },
  {
    group: "Revenue",
    items: [
      { key: "subscriptions", label: "Subscriptions", icon: CreditCard },
      { key: "billing", label: "Billing & Invoices", icon: ReceiptIndianRupee },
      { key: "coupons", label: "Coupons & Offers", icon: TicketPercent },
    ],
  },
  {
    group: "Support",
    items: [
      { key: "tickets", label: "Support Tickets", icon: LifeBuoy },
      { key: "announcements", label: "Announcements", icon: Megaphone },
    ],
  },
  {
    group: "System",
    items: [
      { key: "audit", label: "Audit Logs", icon: ScrollText },
      { key: "integrations", label: "Integrations", icon: Network },
      { key: "settings", label: "Platform Settings", icon: Settings2 },
      { key: "health", label: "System Health", icon: Activity },
      { key: "team", label: "Team & Roles", icon: UserCog },
    ],
  },
];

const VIEW_COMPONENTS: Record<OwnerViewKey, React.ComponentType> = {
  dashboard: OwnerDashboardView,
  analytics: OwnerAnalyticsView,
  businesses: OwnerBusinessesView,
  "add-business": OwnerAddBusinessView,
  users: OwnerUsersView,
  onboarding: OwnerOnboardingView,
  subscriptions: OwnerSubscriptionsView,
  billing: OwnerBillingView,
  coupons: OwnerCouponsView,
  tickets: OwnerTicketsView,
  announcements: OwnerAnnouncementsView,
  audit: OwnerAuditView,
  integrations: OwnerIntegrationsView,
  settings: OwnerSettingsView,
  health: OwnerHealthView,
  team: OwnerTeamView,
};

/** Persisted collapsible group state. */
const GROUPS_KEY = "velurex-owner-groups";
function loadOpenGroups(): string[] {
  if (typeof window === "undefined") return NAV.map((g) => g.group);
  try {
    const raw = window.localStorage.getItem(GROUPS_KEY);
    if (!raw) return NAV.map((g) => g.group);
    const parsed = JSON.parse(raw) as string[];
    return Array.isArray(parsed) ? parsed : NAV.map((g) => g.group);
  } catch {
    return NAV.map((g) => g.group);
  }
}

export function OwnerShell() {
  const { user, clear, token } = useSession();
  const { view, setView } = useOwner();
  const router = useRouter();
  const [navOpen, setNavOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const setViewRaw = useOwner((s) => s.setView);
  const role = isPlatformRole(user?.role ?? "") ? (user!.role as PlatformRole) : "software_owner";
  const roleLabel = PLATFORM_ROLE_LABELS[role];
  const meta = VIEW_TITLES[view];
  const ActiveView = useMemo(() => VIEW_COMPONENTS[view], [view]);
  const initials = user?.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase() ?? "PO";

  return (
    <div className="min-h-screen flex bg-plaster">
      {/* Desktop sidebar */}
      <div className="hidden md:block sticky top-0 h-screen">
        <OwnerSidebar view={view} setView={(v) => setView(v)} role={role} />
      </div>

      {/* Mobile drawer */}
      <AnimatePresence>
        {navOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 bg-pine/60 z-40 md:hidden"
              onClick={() => setNavOpen(false)}
            />
            <motion.div
              initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }}
              transition={{ type: "tween", duration: 0.22 }}
              className="fixed inset-y-0 left-0 z-50 md:hidden"
            >
              <OwnerSidebar view={view} setView={(v) => { setView(v); setNavOpen(false); }} role={role} />
            </motion.div>
          </>
        )}
      </AnimatePresence>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="sticky top-0 z-30 bg-panel border-b border-line-strong">
          <div className="h-16 flex items-center gap-3 px-4 lg:px-6">
            <button className="btn-ghost -ml-2 px-2 md:hidden" onClick={() => setNavOpen(true)} aria-label="Open navigation">
              {navOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <div className="md:hidden"><BrandMark size={34} /></div>
            <div className="hidden md:block min-w-0">
              <h2 className="font-display text-[15px] font-semibold text-pine tracking-tight leading-tight truncate">
                {meta.title}
              </h2>
              <p className="text-[11px] text-muted-ink leading-tight truncate">{meta.sub}</p>
            </div>
            <div className="hidden md:flex items-center gap-1.5 ml-1 shrink-0" title="Every sensitive owner action is written to the platform audit trail">
              <span className="badge border-ok/30 bg-ok/10 text-ok"><ShieldCheck className="h-3 w-3" /> Audited</span>
            </div>
            <div className="flex-1" />
            {role === "software_owner" && <DemoToggle />}
            <QuickJump view={view} setView={setViewRaw} role={role} />
            <p className="hidden lg:block text-[11px] text-muted-ink whitespace-nowrap" aria-hidden>
              {new Date().toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
            </p>
            <div className="relative">
              <button
                className={cn("flex items-center gap-2.5 h-10 pl-1.5 pr-2 rounded-full transition", userMenuOpen ? "bg-plaster-deep/70" : "hover:bg-plaster-deep/60")}
                onClick={() => setUserMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label="Account menu"
              >
                <span className="h-9 w-9 rounded-full bg-pine-700 text-panel text-[13px] font-semibold flex items-center justify-center ring-2 ring-transparent hover:ring-brass/40 transition">
                  {initials}
                </span>
                <span className="hidden lg:block text-left leading-tight">
                  <span className="block text-[13px] font-medium text-pine">{user?.name}</span>
                  <span className="block text-[11px] text-brass font-medium">{roleLabel}</span>
                </span>
                <ChevronDown className={cn("hidden lg:block h-4 w-4 text-muted-ink transition-transform duration-200", userMenuOpen && "rotate-180")} aria-hidden />
              </button>
              <AnimatePresence>
                {userMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                    className="absolute right-0 mt-2 w-72 panel border-line-strong shadow-lg z-50 overflow-hidden"
                    role="menu"
                    aria-label="Account"
                  >
                    <div className="pine-texture bg-pine text-panel px-4 py-3.5 flex items-center gap-3">
                      <span className="h-10 w-10 rounded-full bg-pine-700 ring-1 ring-brass-light/30 text-panel text-sm font-semibold flex items-center justify-center">
                        {initials}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{user?.name}</p>
                        <p className="text-[11px] text-panel/60 truncate">{user?.email}</p>
                      </div>
                    </div>
                    <div className="px-4 py-3 space-y-2 border-b border-line">
                      <div className="flex items-center gap-2.5 text-[13px] text-ink">
                        <ShieldCheck className="h-4 w-4 text-brass shrink-0" />
                        <span>
                          {role === "software_owner"
                            ? "Platform owner — full access"
                            : `${roleLabel} — scoped access`}
                        </span>
                      </div>
                      <div className="flex items-center gap-2.5 text-[13px] text-ink">
                        <ScrollText className="h-4 w-4 text-muted-ink shrink-0" />
                        <span>All actions audited</span>
                        <span className="badge border-brass/40 bg-brass/10 text-brass ml-auto">16 modules</span>
                      </div>
                    </div>
                    <div className="py-1.5">
                      <button
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-danger hover:bg-danger/10 transition"
                        role="menuitem"
                        onClick={async () => {
                          setUserMenuOpen(false);
                          await fetch("/api/auth/logout", { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
                          clear();
                          router.refresh();
                        }}
                      >
                        <LogOut className="h-4 w-4" />
                        Sign out
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 px-4 lg:px-6 py-5 min-w-0">
          <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
            <ActiveView />
          </motion.div>
        </main>

        <footer className="mt-auto border-t border-line bg-panel/70 px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-ink">
          <span>© {new Date().getFullYear()} Velurex Technologies · Platform Console</span>
          <span className="flex items-center gap-2">
            <VersionBadge variant="light" />
            <span className="text-brass">·</span>
            <span className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-brass" aria-hidden />
              Owner access · all actions audited
            </span>
          </span>
        </footer>
      </div>
    </div>
  );
}

/**
 * "Demo data" visibility toggle (real owner only) — seed/demo tenants stay in
 * the DB for the demo logins, but the real owner's console is clean by default.
 * Flipping the switch sets the `vx_show_demo` cookie (picked up by the proxy,
 * which appends includeDemo=1 to owner API calls) and reloads for a clean refetch.
 */
function DemoToggle() {
  const [state, setState] = useState<{ hasDemoData: boolean; showing: boolean; canToggle: boolean } | null>(null);

  useEffect(() => {
    api<{ hasDemoData: boolean; showing: boolean; canToggle: boolean }>("/api/owner/demo-state")
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state || !state.hasDemoData || !state.canToggle) return null;
  const showing = state.showing;

  const flip = () => {
    document.cookie = showing
      ? "vx_show_demo=; Path=/; Max-Age=0"
      : "vx_show_demo=1; Path=/; Max-Age=31536000; SameSite=Lax";
    window.location.reload();
  };

  return (
    <button
      type="button"
      onClick={flip}
      title={showing ? "Demo tenants are visible — click to hide them again" : "Your console is clean — click to preview the built-in demo tenants"}
      aria-pressed={showing}
      className={cn(
        "flex items-center gap-1.5 h-9 px-2.5 sm:px-3 rounded-full border text-[12px] font-medium transition shrink-0",
        showing
          ? "border-brass/50 bg-brass/10 text-brass hover:bg-brass/15"
          : "border-line bg-plaster/60 text-muted-ink hover:border-line-strong hover:text-ink"
      )}
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden />
      <span className="hidden lg:inline">Demo data</span>
      <span className={cn("h-1.5 w-1.5 rounded-full", showing ? "bg-brass" : "bg-muted-ink/40")} aria-hidden />
      <span className="hidden sm:inline">{showing ? "Shown" : "Hidden"}</span>
    </button>
  );
}

/** Owner-scoped quick jump — fuzzy-matches views, Ctrl/⌘+K focuses, arrows navigate, Enter selects. */
function QuickJump({ view, setView, role }: { view: OwnerViewKey; setView: (v: OwnerViewKey) => void; role: PlatformRole }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const all = useMemo(
    () =>
      NAV.flatMap((g) => g.items)
        .filter((i) => canReadView(role, i.key))
        .map((i) => ({ ...i, group: NAV.find((g) => g.items.includes(i))?.group ?? "" })),
    [role]
  );
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all.slice(0, 8);
    return all
      .filter((i) => `${i.group} ${i.label}`.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [q, all]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setTimeout(() => inputRef.current?.focus(), 30);
      }
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, []);

  const pick = (key: OwnerViewKey) => {
    setView(key);
    setOpen(false);
    setQ("");
    setIdx(0);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => { setOpen(true); setTimeout(() => inputRef.current?.focus(), 30); }}
        className="hidden sm:flex items-center gap-2 h-9 w-56 lg:w-72 rounded-md border border-line bg-plaster/60 px-3 text-[13px] text-muted-ink hover:border-line-strong hover:bg-panel transition"
        aria-label="Quick jump (Ctrl+K)"
        aria-expanded={open}
      >
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 text-left truncate">Jump to…</span>
        <kbd className="cmd-kbd"><Command className="h-2.5 w-2.5" /> K</kbd>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
            className="absolute right-0 lg:left-0 mt-2 w-80 panel border-line-strong shadow-xl z-50 overflow-hidden"
            role="dialog"
            aria-label="Quick jump"
          >
            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-line">
              <Search className="h-4 w-4 text-muted-ink shrink-0" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => { setQ(e.target.value); setIdx(0); }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(i + 1, results.length - 1)); }
                  if (e.key === "ArrowUp") { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
                  if (e.key === "Enter" && results[idx]) pick(results[idx].key);
                }}
                className="flex-1 bg-transparent text-sm text-ink placeholder:text-muted-ink/60 focus:outline-none"
                placeholder="Search modules…"
                aria-label="Search modules"
              />
              <kbd className="cmd-kbd">Esc</kbd>
            </div>
            <div className="py-1.5 max-h-72 overflow-y-auto scroll-slim">
              {results.length === 0 && (
                <p className="px-4 py-6 text-center text-[13px] text-muted-ink">No modules match “{q}”</p>
              )}
              {results.map((r, i) => (
                <button
                  key={r.key}
                  onClick={() => pick(r.key)}
                  onMouseEnter={() => setIdx(i)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3.5 py-2 text-[13px] transition",
                    i === idx ? "bg-brass-50 text-pine" : "text-ink"
                  )}
                  role="option"
                  aria-selected={i === idx}
                >
                  <r.icon className={cn("h-4 w-4 shrink-0", i === idx ? "text-brass" : "text-muted-ink")} />
                  <span className="flex-1 text-left">{r.label}</span>
                  <span className="text-[10px] uppercase tracking-wider text-muted-ink">{r.group}</span>
                  {i === idx && <CornerDownLeft className="h-3 w-3 text-brass" />}
                </button>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function OwnerSidebar({ view, setView, role }: { view: OwnerViewKey; setView: (v: OwnerViewKey) => void; role: PlatformRole }) {
  const { user } = useSession();
  const [openGroups, setOpenGroups] = useState<string[]>(loadOpenGroups);

  useEffect(() => {
    try { window.localStorage.setItem(GROUPS_KEY, JSON.stringify(openGroups)); } catch { /* ignore */ }
  }, [openGroups]);

  const toggleGroup = (g: string) =>
    setOpenGroups((groups) => (groups.includes(g) ? groups.filter((x) => x !== g) : [...groups, g]));

  const activeLabel = NAV.flatMap((g) => g.items).find((i) => i.key === view)?.label ?? "Dashboard";

  // Role-aware nav: views the member cannot read are hidden entirely.
  const nav = useMemo(
    () =>
      NAV.map((g) => ({ ...g, items: g.items.filter((i) => canReadView(role, i.key)) })).filter(
        (g) => g.items.length > 0
      ),
    [role]
  );

  return (
    <aside className="h-full w-64 pine-texture bg-pine text-panel flex flex-col shrink-0" aria-label="Platform navigation">
      <div className="px-5 pt-6 pb-4 relative">
        <BrandMark size={46} />
      </div>
      <div className="px-5 pb-3 flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-brass animate-pulse" aria-hidden />
        <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-brass-light/90">Platform Console</p>
      </div>

      {/* Active page breadcrumb on pine */}
      <div className="mx-3 mb-2 rounded-md bg-pine-800/50 border border-pine-700/50 px-3 py-2">
        <p className="text-[9px] uppercase tracking-[0.14em] text-panel/40 font-semibold">Active</p>
        <p className="text-[13px] font-medium text-brass-light truncate">{activeLabel}</p>
      </div>

      <nav className="flex-1 overflow-y-auto scroll-slim-pine px-3 pb-4 space-y-2.5">
        {nav.map((group) => {
          const open = openGroups.includes(group.group);
          return (
            <div key={group.group}>
              <button
                type="button"
                onClick={() => toggleGroup(group.group)}
                className="w-full flex items-center justify-between px-3 py-1.5 rounded-md text-[10px] font-semibold uppercase tracking-[0.12em] text-panel/40 hover:text-panel/70 transition"
                aria-expanded={open}
              >
                <span className="flex items-center gap-1.5">
                  {group.group}
                  <span className="text-panel/30 font-normal tracking-normal">{group.items.length}</span>
                </span>
                <ChevronDown className={cn("h-3 w-3 transition-transform duration-200", !open && "-rotate-90")} aria-hidden />
              </button>
              <AnimatePresence initial={false}>
                {open && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="ml-3 pl-3 border-l border-pine-700/50 space-y-0.5 mt-0.5">
                      {group.items.map((item) => {
                        const active = view === item.key;
                        return (
                          <button
                            key={item.key}
                            onClick={() => setView(item.key)}
                            className={cn(
                              "relative w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition",
                              active
                                ? "bg-pine-700 text-white font-medium"
                                : "text-panel/60 hover:text-panel hover:bg-pine-800/60"
                            )}
                            aria-current={active ? "page" : undefined}
                          >
                            {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4.5 w-0.5 rounded-full bg-brass" aria-hidden style={{ height: 18 }} />}
                            <item.icon className={cn("h-4 w-4 shrink-0", active ? "text-brass-light" : "text-brass/70")} />
                            <span className="truncate">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          );
        })}
      </nav>

      {/* Owner identity card */}
      <div className="border-t pine-hairline px-4 py-3.5 mx-2 mb-3 rounded-lg bg-pine-800/40 border border-pine-700/40">
        <div className="flex items-center gap-2.5">
          <span className="h-8 w-8 rounded-full bg-pine-700 ring-1 ring-brass-light/30 text-panel text-[11px] font-semibold flex items-center justify-center shrink-0">
            {(user?.name ?? "Platform Owner").split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="text-[12px] font-medium truncate">{user?.name ?? "Platform Owner"}</p>
            <p className="text-[10px] text-brass-light/80 truncate">{user?.email ?? "owner@velurex.in"}</p>
          </div>
        </div>
        <div className="mt-2.5 pt-2.5 border-t border-pine-700/40">
          <p className="text-[10px] text-panel/45 leading-relaxed flex items-start gap-1.5">
            <ShieldCheck className="h-3 w-3 text-brass shrink-0 mt-0.5" />
            Every sensitive action here is written to the platform audit trail.
          </p>
        </div>
      </div>
    </aside>
  );
}

// Re-export for views that import misc helpers from the shell module
export { inr } from "./shared";
