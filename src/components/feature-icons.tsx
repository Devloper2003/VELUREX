"use client";

/**
 * Client-only icon registry for feature/add-on lucide keys.
 * Catalog rows store a string `icon` key — this maps it to a component.
 */
import {
  BedDouble, Building2, ChefHat, Code, DatabaseBackup, FileBarChart, FileDown,
  LifeBuoy, MessageCircle, MoonStar, Network, Paintbrush, Puzzle, TrendingUp,
  Users, Wrench, BadgeCheck, Coins, Zap, ShieldCheck, Sparkles,
} from "lucide-react";

export const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  puzzle: Puzzle,
  "chef-hat": ChefHat,
  "moon-star": MoonStar,
  "message-circle": MessageCircle,
  "trending-up": TrendingUp,
  "file-bar-chart": FileBarChart,
  "file-down": FileDown,
  code: Code,
  paintbrush: Paintbrush,
  "life-buoy": LifeBuoy,
  "bed-double": BedDouble,
  users: Users,
  network: Network,
  "building-2": Building2,
  wrench: Wrench,
  "database-backup": DatabaseBackup,
  "badge-check": BadgeCheck,
  coins: Coins,
  zap: Zap,
  "shield-check": ShieldCheck,
  sparkles: Sparkles,
};

export function IconFor({ name, className }: { name: string; className?: string }) {
  const Cmp = ICONS[name] ?? Puzzle;
  return <Cmp className={className} />;
}

export const FEATURE_ICON_KEYS = Object.keys(ICONS);
