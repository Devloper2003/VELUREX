"use client";

import { create } from "zustand";

/**
 * Tenant-side entitlements snapshot (fetched from /api/subscription) — used by
 * the AppShell for lock icons, warning banners and the upgrade dialog.
 */
export interface SubscriptionSnapshot {
  plan: { id: string; code: string; name: string; monthlyPrice: number } | null;
  subscription: {
    cycle: string; status: string; renewalAt: string | null; trialEndsAt: string | null;
    autoRenew: boolean; pendingPlanId?: string | null;
  } | null;
  features: Record<string, boolean | number | string>;
  limits: Record<string, number>;
  warning: string | null;
  writable: boolean;
  plans: { id: string; code: string; name: string; description: string; monthlyPrice: number; features: Record<string, unknown> }[];
}

interface EntitlementsState {
  data: SubscriptionSnapshot | null;
  loaded: boolean;
  load: (token: string) => Promise<void>;
  clear: () => void;
}

export const useEntitlements = create<EntitlementsState>()((set) => ({
  data: null,
  loaded: false,
  load: async (token) => {
    try {
      const res = await fetch("/api/subscription", { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const data = (await res.json()) as SubscriptionSnapshot;
      set({ data, loaded: true });
    } catch {
      /* offline — keep last snapshot */
    }
  },
  clear: () => set({ data: null, loaded: false }),
}));

/** Feature-flag helpers shared by the shell. */
export const LOCKABLE_VIEWS: Record<string, string> = {
  pos: "pos",
  kitchen: "pos",
  "night-audit": "night_audit",
  pricing: "dynamic_pricing",
  whatsapp: "whatsapp_automation",
};
