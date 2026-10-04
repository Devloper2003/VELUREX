"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Bell, Search, LogOut, LogIn, ChevronDown, ChevronRight, Wifi, WifiOff,
  ChefHat, ReceiptIndianRupee, MoonStar, CalendarRange, Globe, Menu, X, Printer,
  Building2, Keyboard, ShieldCheck,
} from "lucide-react";
import { useSession, ViewKey, ROLE_VIEWS } from "@/lib/store";
import { connectRealtime, useRealtime, type RealtimeStatus } from "@/lib/realtime";
import { useToast } from "@/hooks/use-toast";
import { BrandMark } from "@/components/auth/LoginScreen";
import { cn } from "@/lib/utils";
import { NAV, VIEW_TITLES, GO_KEYS, isGroup } from "./nav-config";
import { CommandPalette, ShortcutsDialog } from "./CommandPalette";
import { VersionBadge } from "./VersionBadge";
import { APP_NAME, APP_VERSION_TAG } from "@/lib/version";

import DashboardView from "@/components/views/DashboardView";
import ReservationsView from "@/components/views/ReservationsView";
import CalendarView from "@/components/views/CalendarView";
import GuestsView from "@/components/views/GuestsView";
import RoomsView from "@/components/views/RoomsView";
import RatePlansView from "@/components/views/RatePlansView";
import BillingView from "@/components/views/BillingView";
import HousekeepingView from "@/components/views/HousekeepingView";
import MaintenanceView from "@/components/views/MaintenanceView";
import PosView from "@/components/views/PosView";
import KitchenView from "@/components/views/KitchenView";
import NightAuditView from "@/components/views/NightAuditView";
import ReportsView from "@/components/views/ReportsView";
import StaffView from "@/components/views/StaffView";
import GrowthView from "@/components/views/GrowthView";
import BookingEngineView from "@/components/views/BookingEngineView";
import InventoryControlView from "@/components/views/InventoryControlView";
import ChannelsView from "@/components/views/ChannelsView";
import WhatsAppView from "@/components/views/WhatsAppView";
import PricingView from "@/components/views/PricingView";
import SettingsView from "@/components/views/SettingsView";
import SubscriptionView from "@/components/views/SubscriptionView";
import { useEntitlements, LOCKABLE_VIEWS } from "@/lib/entitlements-store";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Megaphone, Lock, CreditCard, AlertTriangle } from "lucide-react";

const VIEW_COMPONENTS: Record<ViewKey, React.ComponentType> = {
  dashboard: DashboardView,
  reservations: ReservationsView,
  calendar: CalendarView,
  guests: GuestsView,
  rooms: RoomsView,
  "rate-plans": RatePlansView,
  billing: BillingView,
  housekeeping: HousekeepingView,
  maintenance: MaintenanceView,
  pos: PosView,
  kitchen: KitchenView,
  "night-audit": NightAuditView,
  reports: ReportsView,
  staff: StaffView,
  growth: GrowthView,
  "booking-engine": BookingEngineView,
  "channel-inventory": InventoryControlView,
  channels: ChannelsView,
  whatsapp: WhatsAppView,
  pricing: PricingView,
  settings: SettingsView,
  subscription: SubscriptionView,
};

export function AppShell() {
  const { user, clear, token } = useSession();
  const router = useRouter();
  const { toast } = useToast();
  const allowed = useMemo(() => (user ? ROLE_VIEWS[user.role] : []), [user]);
  const ent = useEntitlements();
  const [requestedView, setRequestedView] = useState<ViewKey>("dashboard");
  const [openGroups, setOpenGroups] = useState<string[]>(["PMS"]);
  const [navOpen, setNavOpen] = useState(false); // mobile drawer
  const [notifOpen, setNotifOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [live, setLive] = useState<RealtimeStatus>("connecting");
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [upgradeFeature, setUpgradeFeature] = useState<{ key: string; label: string } | null>(null);
  const [banners, setBanners] = useState<{ id: string; title: string; body: string }[]>([]);

  // Online status via external store (no effect needed)
  const online = useSyncExternalStore(
    (cb) => {
      window.addEventListener("online", cb);
      window.addEventListener("offline", cb);
      return () => {
        window.removeEventListener("online", cb);
        window.removeEventListener("offline", cb);
      };
    },
    () => navigator.onLine,
    () => true
  );

  // Role-scoped view: fall back to the first allowed view during render
  const view: ViewKey = allowed.includes(requestedView) ? requestedView : allowed[0] ?? "dashboard";

  // Validate session against the server on mount (stale token after reseed/expiry → logout)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/auth/me", { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok && !cancelled) {
          clear();
        }
      } catch {
        /* offline — keep current session */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Plan entitlements + in-app announcements (tenant sessions only)
  const isTenant = !!user && user.role !== "software_owner";
  useEffect(() => {
    if (isTenant && token) {
      ent.load(token);
      fetch("/api/announcements/active", { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : { announcements: [] }))
        .then((j) => setBanners(j.announcements ?? []))
        .catch(() => {});
    }
  }, [isTenant, token]);

  const dismissBanner = async (id: string) => {
    setBanners((b) => b.filter((x) => x.id !== id));
    if (token) {
      await fetch("/api/announcements/active", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ announcementId: id }),
      }).catch(() => {});
    }
  };

  /** Feature gate: locked views open the upgrade dialog instead of the view. */
  const featureFor = (key: ViewKey): string | null => {
    const fk = LOCKABLE_VIEWS[key];
    if (!fk || !ent.data?.features) return null;
    return ent.data.features[fk] === true ? null : fk;
  };
  const handleNav = (key: ViewKey) => {
    const fk = featureFor(key);
    if (fk) {
      const label = key === "kitchen" ? "Kitchen (KOT)" : key.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      setUpgradeFeature({ key: fk, label });
      return;
    }
    setRequestedView(key);
    setNavOpen(false);
  };

  // Cross-view navigation events (quick actions on dashboard etc.)
  useEffect(() => {
    const onNavigate = (e: Event) => {
      const key = (e as CustomEvent<ViewKey>).detail;
      if (typeof key === "string" && allowed.includes(key)) setRequestedView(key);
    };
    window.addEventListener("velurex:navigate", onNavigate);
    return () => window.removeEventListener("velurex:navigate", onNavigate);
  }, [allowed]);

  // Open the shortcuts cheat-sheet from anywhere (palette Help group)
  useEffect(() => {
    const onHelp = () => setShortcutsOpen(true);
    window.addEventListener("velurex:shortcuts-help", onHelp);
    return () => window.removeEventListener("velurex:shortcuts-help", onHelp);
  }, []);

  // ── Keyboard shortcuts: Ctrl/⌘+K palette · ? help · g→key module jumps · N new reservation ──
  const goTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (!user) return;
    const isTypingTarget = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.matches("input, textarea, select, [contenteditable=true]") || t.isContentEditable);

    const jumpTo = (key: ViewKey) => {
      if (allowed.includes(key)) setRequestedView(key);
    };
    const newReservation = () => {
      if (!allowed.includes("reservations")) return;
      jumpTo("reservations");
      window.setTimeout(() => window.dispatchEvent(new CustomEvent("velurex:open-dialog", { detail: "new-reservation" })), 420);
    };

    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        setShortcutsOpen(false);
        return;
      }
      if (e.key === "Escape") {
        setPaletteOpen(false);
        setShortcutsOpen(false);
        return;
      }
      if (isTypingTarget(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "?") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // pending g-sequence → module jump
      if (goTimerRef.current !== null) {
        window.clearTimeout(goTimerRef.current);
        goTimerRef.current = null;
        const target = GO_KEYS[e.key.toLowerCase()];
        if (target) {
          e.preventDefault();
          jumpTo(target);
        }
        return;
      }

      if (e.key.toLowerCase() === "g") {
        goTimerRef.current = window.setTimeout(() => { goTimerRef.current = null; }, 1200);
        return;
      }

      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        newReservation();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (goTimerRef.current !== null) window.clearTimeout(goTimerRef.current);
    };
  }, [user, allowed]);

  // Track the panel-open state in a ref so the realtime callback stays stable
  const notifOpenRef = useRef(notifOpen);
  useEffect(() => {
    notifOpenRef.current = notifOpen;
  }, [notifOpen]);

  // Open the panel and clear the unread counter in the same event (no effect needed)
  const toggleNotifications = () => {
    const next = !notifOpen;
    setNotifOpen(next);
    if (next) setUnread(0);
  };

  // Close on outside click / Escape — a plain dropdown needs manual dismissal
  const notifRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!notifOpen) return;
    const onDown = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNotifOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [notifOpen]);

  // User menu — outside click + Escape dismissal
  const userMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!userMenuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setUserMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [userMenuOpen]);

  // Realtime push: unread badge + live status + night-audit toast
  useRealtime(
    (event, data) => {
      setSyncedAt(new Date());
      if (event === "night-audit:done") {
        const d = data as { totalRevenue?: number; occupancyPercent?: number; noShowCount?: number } | null;
        toast({
          title: "Night audit completed",
          description: `Revenue ₹${(d?.totalRevenue ?? 0).toLocaleString("en-IN")} · occupancy ${d?.occupancyPercent ?? "—"}% · no-shows ${d?.noShowCount ?? 0}`,
        });
        setUnread((u) => u + 1);
      } else if (event === "activity:new" || event === "folio:update" || event === "kot:update") {
        setUnread((u) => (notifOpenRef.current ? 0 : u + 1));
      }
    },
    (status) => setLive(status)
  );

  if (!user) return null;

  const visibleNav = NAV.filter((e) => (isGroup(e) ? e.items.some((i) => allowed.includes(i.key)) : allowed.includes(e.key)));
  const ActiveView = VIEW_COMPONENTS[view] ?? DashboardView;
  const initials = user.name.split(" ").map((p) => p[0]).slice(0, 2).join("");

  const sidebar = (
    <aside className="h-full w-64 bg-pine text-panel flex flex-col shrink-0">
      <div className="px-5 pt-6 pb-5">
        <BrandMark size={46} />
      </div>
      <nav className="flex-1 overflow-y-auto scroll-slim px-3 pb-4 space-y-0.5" aria-label="Main navigation">
        {visibleNav.map((entry) =>
          isGroup(entry) ? (
            <div key={entry.label}>
              <button
                onClick={() => setOpenGroups((g) => (g.includes(entry.label) ? g.filter((x) => x !== entry.label) : [...g, entry.label]))}
                className="w-full flex items-center justify-between px-3 py-2 rounded-md text-[13px] font-medium text-panel/70 hover:text-panel hover:bg-pine-800/60 transition"
              >
                <span className="flex items-center gap-2.5">
                  <entry.icon className="h-4 w-4 text-brass" />
                  {entry.label}
                </span>
                {openGroups.includes(entry.label) ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
              <AnimatePresence initial={false}>
                {openGroups.includes(entry.label) && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.18 }}
                    className="overflow-hidden"
                  >
                    <div className="ml-4 pl-3 border-l border-pine-700/60 space-y-0.5 mt-0.5">
                      {entry.items.filter((i) => allowed.includes(i.key)).map((item) => {
                        const locked = isTenant && !!featureFor(item.key);
                        return (
                          <button
                            key={item.key}
                            onClick={() => handleNav(item.key)}
                            className={cn(
                              "w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-[13px] transition",
                              view === item.key
                                ? "bg-pine-700 text-white font-medium"
                                : "text-panel/60 hover:text-panel hover:bg-pine-800/60"
                            )}
                          >
                            <item.icon className={cn("h-4 w-4", view === item.key ? "text-brass-light" : "text-panel/40")} />
                            <span className="flex-1 text-left truncate">{item.label}</span>
                            {locked && <Lock className="h-3 w-3 text-brass" aria-hidden />}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ) : (
            (() => {
              const locked = isTenant && !!featureFor(entry.key);
              return (
                <button
                  key={entry.key}
                  onClick={() => handleNav(entry.key)}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-[13px] transition",
                    view === entry.key
                      ? "bg-pine-700 text-white font-medium"
                      : "text-panel/70 hover:text-panel hover:bg-pine-800/60"
                  )}
                >
                  <entry.icon className={cn("h-4 w-4", view === entry.key ? "text-brass-light" : "text-brass")} />
                  <span className="flex-1 text-left">{entry.label}</span>
                  {locked && <Lock className="h-3 w-3 text-brass" aria-hidden />}
                </button>
              );
            })()
          )
        )}
      </nav>
      <div className="border-t border-pine-700/60 px-5 py-4">
        <p className="text-[13px] font-medium truncate">{user.propertyName}</p>
        <div className="mt-0.5 flex items-center gap-1.5">
          <span className="text-[11px] text-panel/50">{APP_NAME}</span>
          <VersionBadge variant="dark" />
        </div>
      </div>
    </aside>
  );

  return (
    <div className="min-h-screen flex bg-plaster">
      {/* Desktop sidebar */}
      <div className="hidden md:block sticky top-0 h-screen">{sidebar}</div>

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
              {sidebar}
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

            {/* Global search */}
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
              <input
                className="field pl-9 pr-16 bg-plaster/50 border-line focus:bg-panel"
                placeholder="Search guests, reservations, rooms…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && allowed.includes("reservations")) {
                    setRequestedView("reservations");
                    window.dispatchEvent(new CustomEvent("velurex:search", { detail: (e.target as HTMLInputElement).value }));
                  }
                }}
                aria-label="Global search"
              />
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="absolute right-2 top-1/2 -translate-y-1/2"
                aria-label="Open command palette (Ctrl+K)"
                title="Command palette — Ctrl+K"
              >
                <kbd className="cmd-kbd">⌘ K</kbd>
              </button>
            </div>

            <div className="flex-1" />

            {/* Connection status — single segmented pill (network + realtime) */}
            <div
              className={cn(
                "hidden sm:inline-flex items-center h-8 rounded-full border px-2.5 gap-2 text-[11.5px] font-medium",
                online
                  ? "border-line-strong bg-panel text-ink"
                  : "border-warn/40 bg-warn/10 text-warn"
              )}
              title={
                online
                  ? live === "online"
                    ? "Network online · realtime push connected — updates arrive instantly"
                    : "Network online · realtime unavailable — polling every few seconds"
                  : "You are offline — changes are queued locally and sync automatically"
              }
            >
              <span className="inline-flex items-center gap-1.5">
                {online ? <Wifi className="h-3.5 w-3.5 text-ok" /> : <WifiOff className="h-3.5 w-3.5 text-warn" />}
                {online ? "Online" : "Offline · will sync"}
              </span>
              {online && (
                <>
                  <span className="h-3.5 w-px bg-line-strong" aria-hidden />
                  <span className="inline-flex items-center gap-1.5 text-muted-ink">
                    <span className="relative flex h-2 w-2" aria-hidden>
                      {live === "online" && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ok opacity-60" />}
                      <span className={cn("relative inline-flex rounded-full h-2 w-2", live === "online" ? "bg-ok" : "bg-warn")} />
                    </span>
                    {live === "online" ? "Live" : "Polling"}
                  </span>
                </>
              )}
            </div>

            <div className="h-6 w-px bg-line hidden sm:block" aria-hidden />

            {/* Notifications */}
            <div className="relative" ref={notifRef}>
              <button
                className="relative h-9 w-9 rounded-full flex items-center justify-center text-pine-700 hover:bg-plaster-deep/60 transition"
                onClick={toggleNotifications}
                aria-label={`Notifications${unread > 0 ? ` — ${unread} unread` : ""}`}
                aria-expanded={notifOpen}
              >
                <Bell className="h-[18px] w-[18px]" />
                {unread > 0 ? (
                  <span className="absolute top-0.5 right-0.5 min-w-4 h-4 px-1 rounded-full bg-brass text-pine text-[10px] font-bold flex items-center justify-center ring-2 ring-panel">
                    {unread > 9 ? "9+" : unread}
                  </span>
                ) : (
                  <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-line-strong ring-2 ring-panel" />
                )}
              </button>
              <AnimatePresence>
                {notifOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                    className="absolute right-0 mt-2 w-80 panel border-line-strong shadow-lg z-50"
                    role="dialog"
                    aria-label="Recent activity"
                  >
                    <div className="panel-header">
                      <p className="panel-title">Activity</p>
                      <button className="btn-ghost px-1.5 h-6" onClick={() => setNotifOpen(false)} aria-label="Close activity panel">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <NotificationList />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            <div className="h-6 w-px bg-line" aria-hidden />

            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                className={cn(
                  "flex items-center gap-2.5 h-10 pl-1.5 pr-2 rounded-full transition",
                  userMenuOpen ? "bg-plaster-deep/70" : "hover:bg-plaster-deep/60"
                )}
                onClick={() => setUserMenuOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label="Account menu"
              >
                <span className="h-9 w-9 rounded-full bg-pine-700 text-panel text-[13px] font-semibold flex items-center justify-center ring-2 ring-transparent hover:ring-brass/40 transition">
                  {initials}
                </span>
                <span className="hidden lg:block text-left leading-tight">
                  <span className="block text-[13px] font-medium text-pine">{user.name}</span>
                  <span className="block text-[11px] text-brass font-medium capitalize">{user.role.replace("_", " ")}</span>
                </span>
                <ChevronDown className={cn("h-4 w-4 text-muted-ink transition-transform duration-200", userMenuOpen && "rotate-180")} aria-hidden />
              </button>

              <AnimatePresence>
                {userMenuOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                    className="absolute right-0 mt-2 w-72 panel border-line-strong shadow-lg z-50 overflow-hidden"
                    role="menu"
                    aria-label="Account"
                  >
                    <div className="bg-pine text-panel px-4 py-3.5 flex items-center gap-3">
                      <span className="h-10 w-10 rounded-full bg-pine-700 ring-1 ring-panel/20 text-panel text-sm font-semibold flex items-center justify-center">
                        {initials}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{user.name}</p>
                        <p className="text-[11px] text-panel/60 truncate">{user.email}</p>
                      </div>
                    </div>
                    <div className="px-4 py-3 space-y-2.5 border-b border-line">
                      <div className="flex items-center gap-2.5 text-[13px] text-ink">
                        <Building2 className="h-4 w-4 text-muted-ink shrink-0" />
                        <span className="truncate">{user.propertyName}</span>
                      </div>
                      <div className="flex items-center gap-2.5 text-[13px] text-ink">
                        <ShieldCheck className="h-4 w-4 text-muted-ink shrink-0" />
                        <span className="capitalize">{user.role.replace("_", " ")} access</span>
                        <span className="badge border-brass/40 bg-brass/10 text-brass ml-auto">{allowed.length} modules</span>
                      </div>
                    </div>
                    <div className="py-1.5">
                      <button
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-ink hover:bg-plaster-deep/60 transition"
                        role="menuitem"
                        onClick={() => { setUserMenuOpen(false); setShortcutsOpen(true); }}
                      >
                        <Keyboard className="h-4 w-4 text-muted-ink" />
                        Keyboard shortcuts
                        <kbd className="cmd-kbd ml-auto">?</kbd>
                      </button>
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

        {/* Platform banners: subscription warnings + in-app announcements */}
        {(isTenant && (ent.data?.warning || ent.data?.writable === false)) || banners.length > 0 ? (
          <div className="px-4 lg:px-6 pt-3 space-y-2" role="region" aria-label="Platform notices">
            {isTenant && ent.data?.warning && (
              <div className="flex items-start gap-2.5 rounded-lg border border-warn/40 bg-warn/10 px-3.5 py-2.5">
                <AlertTriangle className="h-4 w-4 text-warn shrink-0 mt-0.5" />
                <p className="text-[13px] text-ink flex-1">{ent.data.warning}</p>
                {user?.role === "hotel_admin" && (
                  <button className="btn-brass h-7 text-[12px] shrink-0" onClick={() => setRequestedView("subscription")}>
                    <CreditCard className="h-3.5 w-3.5" /> Pay now
                  </button>
                )}
              </div>
            )}
            {banners.map((b) => (
              <div key={b.id} className="flex items-start gap-2.5 rounded-lg border border-brass/40 bg-brass-50 px-3.5 py-2.5">
                <Megaphone className="h-4 w-4 text-brass shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium text-pine">{b.title}</p>
                  <p className="text-[12px] text-ink/80 mt-0.5">{b.body}</p>
                </div>
                <button
                  className="h-6 w-6 rounded-full flex items-center justify-center text-muted-ink hover:bg-plaster-deep/70 transition shrink-0"
                  onClick={() => dismissBanner(b.id)}
                  aria-label={`Dismiss: ${b.title}`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* Content */}
        <main className="flex-1 px-4 lg:px-6 py-5 min-w-0" id="main-content">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h1 className="section-title">{VIEW_TITLES[view]}</h1>
              <p className="text-xs text-muted-ink mt-0.5">{user.propertyName} · {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "2-digit", month: "short", year: "numeric" })}</p>
            </div>
            <div className="text-xs text-muted-ink hidden sm:flex items-center gap-1.5">
              <span className={cn("h-1.5 w-1.5 rounded-full", live === "online" ? "bg-ok" : "bg-warn animate-pulse")} />
              {live === "online" ? "Live" : "Polling"}
              {syncedAt && ` · synced ${syncedAt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
            </div>
          </div>
          <motion.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
            <ActiveView />
          </motion.div>
        </main>

        <footer className="mt-auto border-t border-line bg-panel/70 px-6 py-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-ink">
          <span>© {new Date().getFullYear()} Velurex HMS · {user?.propertyName || "Velurex HMS"}</span>
          <span className="flex items-center gap-3">
            <VersionBadge variant="light" />
            <span className="text-brass">·</span>
            <button type="button" className="hover:text-pine transition" onClick={() => setShortcutsOpen(true)}>
              <kbd className="cmd-kbd">?</kbd> shortcuts
            </button>
            <span className="text-brass">·</span>
            <span>{APP_VERSION_TAG} — works offline (PWA)</span>
          </span>
        </footer>
      </div>

      {/* Command palette + shortcut cheat-sheet */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        allowed={allowed}
        view={view}
        onNavigate={(key) => setRequestedView(key)}
        onNewReservation={() => {
          if (!allowed.includes("reservations")) return;
          setRequestedView("reservations");
          window.setTimeout(() => window.dispatchEvent(new CustomEvent("velurex:open-dialog", { detail: "new-reservation" })), 300);
        }}
      />
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Upgrade-required dialog (locked module tapped) */}
      <Dialog open={!!upgradeFeature} onOpenChange={(o) => !o && setUpgradeFeature(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Lock className="h-4 w-4 text-brass" /> Available in a higher plan
            </DialogTitle>
            <DialogDescription>
              {upgradeFeature?.label} isn&apos;t included in {ent.data?.plan?.name ?? "your current plan"}. Upgrade to unlock it — your data stays exactly as it is.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setUpgradeFeature(null)}>Not now</button>
            {user?.role === "hotel_admin" && (
              <button
                className="btn-brass"
                onClick={() => {
                  setUpgradeFeature(null);
                  setRequestedView("subscription");
                }}
              >
                <CreditCard className="h-4 w-4" /> View plans
              </button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ActivityEntry {
  id: string;
  action: string;
  details: string;
  createdAt: string;
  staffName: string;
}

/** Icon + tone for each activity action family. */
function activityVisual(action: string): { icon: React.ComponentType<{ className?: string }>; cls: string } {
  if (action.startsWith("CHECK_IN")) return { icon: LogIn, cls: "bg-ok/15 text-ok" };
  if (action.startsWith("CHECK_OUT")) return { icon: LogOut, cls: "bg-warn/15 text-warn" };
  if (action.startsWith("POS_")) return { icon: ChefHat, cls: "bg-brass/15 text-brass" };
  if (action.startsWith("FOLIO") || action.startsWith("PAYMENT")) return { icon: ReceiptIndianRupee, cls: "bg-brass/15 text-brass" };
  if (action.startsWith("NIGHT_AUDIT")) return { icon: MoonStar, cls: "bg-pine-100 text-pine-700" };
  if (action.startsWith("BOOKING")) return { icon: Globe, cls: "bg-brass/15 text-brass" };
  if (action.startsWith("RESERVATION")) return { icon: CalendarRange, cls: "bg-pine-100 text-pine-700" };
  if (action.startsWith("REGCARD")) return { icon: Printer, cls: "bg-pine-100 text-pine-700" };
  if (action.startsWith("LOGIN")) return { icon: LogIn, cls: "bg-plaster text-muted-ink" };
  if (action.startsWith("LOGOUT")) return { icon: LogOut, cls: "bg-plaster text-muted-ink" };
  return { icon: Bell, cls: "bg-plaster text-muted-ink" };
}

function NotificationList() {
  const [items, setItems] = useState<ActivityEntry[]>([]);
  const token = useSession((s) => s.token);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notifications", { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) {
          const fetched = ((await res.json()).items ?? []) as ActivityEntry[];
          // Merge: keep live-prepended entries the DB snapshot may not include yet
          setItems((prev) => {
            const have = new Set(fetched.map((f) => f.id));
            const localOnly = prev.filter((p) => !have.has(p.id));
            return [...localOnly, ...fetched].slice(0, 12);
          });
        }
      } catch { /* offline */ }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // Live prepend — dedupe by id, cap the panel at 12 entries
  useEffect(() => {
    return connectRealtime({
      token,
      onEvent: (event, data) => {
        if (event !== "activity:new") return;
        const entry = data as ActivityEntry;
        if (!entry?.id) return;
        setItems((prev) => (prev.some((p) => p.id === entry.id) ? prev : [entry, ...prev].slice(0, 12)));
      },
    });
  }, [token]);

  if (items.length === 0) return <div className="px-4 py-6 text-sm text-muted-ink text-center">No recent activity</div>;
  return (
    <div className="max-h-80 overflow-y-auto scroll-slim divide-y divide-line/70">
      {items.map((i) => {
        const visual = activityVisual(i.action);
        return (
          <div key={i.id} className="px-3.5 py-2.5 flex items-start gap-2.5 hover:bg-plaster/50 transition">
            <span className={cn("mt-0.5 h-7 w-7 shrink-0 rounded-md flex items-center justify-center", visual.cls)} aria-hidden>
              <visual.icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0">
              <p className="text-[13px] text-ink leading-snug">{i.details || i.action}</p>
              <p className="text-[11px] text-muted-ink mt-0.5">
                {i.staffName} · {new Date(i.createdAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
