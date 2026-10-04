import {
  LayoutDashboard, CalendarRange, Users, DoorOpen, Tag, BedDouble,
  ConciergeBell, ChefHat, ReceiptIndianRupee, BrushCleaning, Wrench,
  MoonStar, BarChart3, Globe, MessageCircle, TrendingUp, Settings2,
  Network, Grid3X3, Link2, CreditCard, UserRoundCheck, Rocket,
} from "lucide-react";
import type { ViewKey } from "@/lib/store";

export interface NavItem {
  key: ViewKey;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}
export interface NavGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  items: NavItem[];
}
export type NavEntry = NavItem | NavGroup;

export function isGroup(e: NavEntry): e is NavGroup {
  return "items" in e;
}

/** Sidebar + command-palette navigation model (single source of truth). */
export const NAV: NavEntry[] = [
  { key: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  {
    label: "PMS",
    icon: CalendarRange,
    items: [
      { key: "reservations", label: "Reservations", icon: CalendarRange },
      { key: "calendar", label: "Availability Calendar", icon: BedDouble },
      { key: "guests", label: "Guests", icon: Users },
      { key: "rooms", label: "Rooms", icon: DoorOpen },
      { key: "rate-plans", label: "Rate Plans", icon: Tag },
    ],
  },
  {
    label: "F&B / POS",
    icon: ConciergeBell,
    items: [
      { key: "pos", label: "POS Terminal", icon: ConciergeBell },
      { key: "kitchen", label: "Kitchen (KOT)", icon: ChefHat },
    ],
  },
  { key: "billing", label: "Billing & Folio", icon: ReceiptIndianRupee },
  { key: "housekeeping", label: "Housekeeping", icon: BrushCleaning },
  { key: "maintenance", label: "Maintenance", icon: Wrench },
  { key: "night-audit", label: "Night Audit", icon: MoonStar },
  { key: "reports", label: "Reports", icon: BarChart3 },
  { key: "staff", label: "Staff & Payroll", icon: UserRoundCheck },
  { key: "growth", label: "Growth & Revenue", icon: Rocket },
  { key: "booking-engine", label: "Booking Engine", icon: Globe },
  {
    label: "Distribution",
    icon: Network,
    items: [
      { key: "channel-inventory", label: "Inventory Control", icon: Grid3X3 },
      { key: "channels", label: "Channels & OTAs", icon: Link2 },
    ],
  },
  { key: "whatsapp", label: "WhatsApp Integration", icon: MessageCircle },
  { key: "pricing", label: "Dynamic Pricing", icon: TrendingUp },
  { key: "settings", label: "Settings", icon: Settings2 },
  { key: "subscription", label: "My Subscription", icon: CreditCard },
];

export const VIEW_TITLES: Record<ViewKey, string> = {
  dashboard: "Dashboard",
  reservations: "Reservations",
  calendar: "Availability Calendar",
  guests: "Guest Profiles",
  rooms: "Room Inventory",
  "rate-plans": "Rate Plans",
  pos: "Restaurant POS",
  kitchen: "Kitchen Display — KOT",
  billing: "Billing & Folio",
  housekeeping: "Housekeeping",
  maintenance: "Maintenance",
  "night-audit": "Night Audit",
  reports: "Reports & Analytics",
  staff: "Staff & Payroll Management",
  growth: "Growth & Revenue Studio",
  "booking-engine": "Booking Engine",
  "channel-inventory": "Inventory Control — Unified Availability",
  channels: "Channels & OTAs",
  whatsapp: "WhatsApp Business",
  pricing: "Dynamic Pricing",
  settings: "Settings",
  subscription: "My Subscription",
};

/** Optional single-key jump target for the palette (g + key sequence). */
export const GO_KEYS: Partial<Record<string, ViewKey>> = {
  d: "dashboard",
  r: "reservations",
  c: "calendar",
  g: "guests",
  m: "rooms",
  b: "billing",
  h: "housekeeping",
  k: "kitchen",
  n: "night-audit",
  p: "pos",
  i: "channel-inventory",
  o: "channels",
  t: "staff",
  w: "growth",
  s: "settings",
};
