/**
 * Platform (Software Owner console) roles — CLIENT-SAFE constants.
 *
 * `software_owner` remains the single super-admin account (Sujeet Sharma).
 * Team & Roles invites carry one of the granular roles below; the server
 * enforces capabilities centrally in `requireOwner` (403 on denied writes),
 * this module mirrors the matrix for client-side navigation/UI.
 */

export type PlatformRole = "software_owner" | "platform_admin" | "platform_support" | "platform_finance";

export const PLATFORM_ROLES: readonly PlatformRole[] = [
  "software_owner",
  "platform_admin",
  "platform_support",
  "platform_finance",
] as const;

export function isPlatformRole(role: string): role is PlatformRole {
  return (PLATFORM_ROLES as readonly string[]).includes(role);
}

export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  software_owner: "Software Owner",
  platform_admin: "Platform Admin",
  platform_support: "Platform Support",
  platform_finance: "Platform Finance",
};

/** Roles that can be invited / changed via Team & Roles (never software_owner — single-owner invariant). */
export const TEAM_INVITABLE_ROLES: readonly PlatformRole[] = [
  "platform_admin",
  "platform_support",
  "platform_finance",
] as const;

export const PLATFORM_ROLE_DESCRIPTIONS: Record<PlatformRole, string> = {
  software_owner: "Full platform access — the account holder. Cannot be created, edited or revoked from Team & Roles.",
  platform_admin: "Runs the platform day-to-day: businesses, users, onboarding, subscriptions, billing, coupons, tickets and announcements. Cannot manage team members or platform API keys.",
  platform_support: "Handles tenant support: replies to tickets, publishes announcements. Read-only everywhere else.",
  platform_finance: "Owns revenue: subscriptions, plans, invoices, payments and coupons. Read-only everywhere else.",
};

/** Views each non-owner role can WRITE in (server mirrors this in requireOwner). */
export const ROLE_WRITE_VIEWS: Record<Exclude<PlatformRole, "software_owner">, readonly string[]> = {
  platform_admin: [
    "businesses", "add-business", "users", "onboarding",
    "subscriptions", "billing", "coupons",
    "tickets", "announcements",
    "integrations", "health",
  ],
  platform_support: ["tickets", "announcements"],
  platform_finance: ["subscriptions", "billing", "coupons"],
};

/** Views hidden from the sidebar entirely (no read access worth showing). */
export const ROLE_HIDDEN_VIEWS: Record<Exclude<PlatformRole, "software_owner">, readonly string[]> = {
  platform_admin: ["team"],
  platform_support: ["team", "settings"],
  platform_finance: ["team", "settings"],
};

export function canWriteView(role: string, view: string): boolean {
  if (role === "software_owner") return true;
  const writes = ROLE_WRITE_VIEWS[role as Exclude<PlatformRole, "software_owner">];
  return writes?.includes(view) ?? false;
}

export function canReadView(role: string, view: string): boolean {
  if (role === "software_owner") return true;
  if (view === "dashboard" || view === "analytics" || view === "audit") return true; // read-only visibility
  const hidden = ROLE_HIDDEN_VIEWS[role as Exclude<PlatformRole, "software_owner">];
  return !hidden?.includes(view);
}
