"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

/** Owner dashboard view keys — sidebar groups per the platform spec. */
export type OwnerViewKey =
  | "dashboard" | "analytics"
  | "businesses" | "add-business" | "users" | "onboarding"
  | "subscriptions" | "addons" | "billing" | "coupons"
  | "tickets" | "announcements"
  | "audit" | "integrations" | "settings" | "health" | "team";

interface OwnerState {
  view: OwnerViewKey;
  selectedBusinessId: string | null;
  setView: (v: OwnerViewKey) => void;
  selectBusiness: (id: string | null) => void;
}

export const useOwner = create<OwnerState>()((set) => ({
  view: "dashboard",
  selectedBusinessId: null,
  setView: (v) => set({ view: v, ...(v === "add-business" ? {} : {}) }),
  selectBusiness: (id) => set({ selectedBusinessId: id }),
}));

/**
 * Impersonation store — the owner session is parked here while the SPA renders
 * the tenant workspace as the impersonated admin. Exit restores the owner.
 */
interface ImpersonationState {
  active: boolean;
  ownerToken: string | null;
  ownerUser: { id: string; name: string; email: string } | null;
  tenantName: string | null;
  start: (o: { ownerToken: string; ownerUser: { id: string; name: string; email: string }; tenantName: string }) => void;
  end: () => void;
}

export const useImpersonation = create<ImpersonationState>()(
  persist(
    (set) => ({
      active: false,
      ownerToken: null,
      ownerUser: null,
      tenantName: null,
      start: ({ ownerToken, ownerUser, tenantName }) =>
        set({ active: true, ownerToken, ownerUser, tenantName }),
      end: () => set({ active: false, ownerToken: null, ownerUser: null, tenantName: null }),
    }),
    { name: "velurex-impersonation", storage: createJSONStorage(() => localStorage) }
  )
);
