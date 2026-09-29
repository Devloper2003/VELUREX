"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type Role =
  | "hotel_admin" | "front_desk" | "housekeeping" | "restaurant_staff"
  | "software_owner" | "platform_admin" | "platform_support" | "platform_finance";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  propertyId: string;
  propertyName: string;
}

interface SessionState {
  token: string | null;
  user: SessionUser | null;
  hydrated: boolean;
  setSession: (token: string, user: SessionUser) => void;
  clear: () => void;
  markHydrated: () => void;
}

/**
 * SECURITY: the JWT is NOT persisted anymore. It lives only in this in-memory
 * store for the tab's lifetime; across refreshes the session survives through
 * the HttpOnly session cookie (unreachable from JavaScript). Only the
 * non-sensitive user profile is persisted for instant UI boot.
 */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      hydrated: false,
      setSession: (token, user) => {
        set({ token, user });
      },
      clear: () => {
        // Server side: expire the HttpOnly session cookie.
        void fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
        // Legacy cleanup: drop any token a pre-hardening version stored.
        if (typeof window !== "undefined") localStorage.removeItem("velurex_token");
        set({ token: null, user: null });
      },
      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: "velurex-session",
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ user: state.user }) as unknown as SessionState,
      onRehydrateStorage: () => (state) => {
        state?.markHydrated();
      },
    }
  )
);

/** In-memory token for API helpers (cookie is the real persistent transport). */
export function getStoredToken(): string | null {
  return useSession.getState().token;
}

/** View keys shared between shell nav and views. */
export type ViewKey =
  | "dashboard"
  | "reservations"
  | "calendar"
  | "guests"
  | "rooms"
  | "rate-plans"
  | "pos"
  | "kitchen"
  | "billing"
  | "housekeeping"
  | "maintenance"
  | "night-audit"
  | "reports"
  | "booking-engine"
  | "channel-inventory"
  | "channels"
  | "whatsapp"
  | "pricing"
  | "settings"
  | "subscription";

export const ROLE_VIEWS: Record<Role, ViewKey[]> = {
  software_owner: [], // the owner gets a dedicated shell, not hotel views
  hotel_admin: [
    "dashboard", "reservations", "calendar", "guests", "rooms", "rate-plans",
    "pos", "kitchen", "billing", "housekeeping", "maintenance", "night-audit",
    "reports", "booking-engine", "channel-inventory", "channels", "whatsapp", "pricing", "settings",
    "subscription",
  ],
  front_desk: [
    "dashboard", "reservations", "calendar", "guests", "rooms", "rate-plans",
    "billing", "housekeeping", "maintenance", "night-audit", "reports",
    "booking-engine", "channel-inventory", "whatsapp",
  ],
  housekeeping: ["housekeeping", "maintenance"],
  restaurant_staff: ["pos", "kitchen"],
  // Platform team roles get the dedicated owner console, not hotel views
  platform_admin: [],
  platform_support: [],
  platform_finance: [],
};

export const DEFAULT_VIEW: Record<Role, ViewKey> = {
  software_owner: "dashboard",
  hotel_admin: "dashboard",
  front_desk: "dashboard",
  housekeeping: "housekeeping",
  restaurant_staff: "pos",
  platform_admin: "dashboard",
  platform_support: "dashboard",
  platform_finance: "dashboard",
};
