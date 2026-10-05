/**
 * Velurex HMS — Subscription feature catalog (single source of truth for UI).
 *
 * The AUTHORITATIVE entitlement data always lives in Plan.features JSON +
 * AddonCatalog.grants JSON in the database (owner-editable). This module only
 * describes WHAT the keys mean so that both the tenant pricing page and the
 * owner plan/add-on editors can render them consistently without hard-coding.
 *
 * Feature types:
 *   limit   — numeric cap; -1 = unlimited (rooms, staff, …)
 *   boolean — on/off module flag (pos, night_audit, …)
 *   enum    — tier picker (support, backup)
 */

export type FeatureType = "limit" | "boolean" | "enum";

export interface FeatureDef {
  key: string;
  label: string;
  icon: string; // lucide icon key (mapped in IconFor helper)
  type: FeatureType;
  group: "capacity" | "modules" | "growth" | "platform" | "service";
  options?: string[]; // enum only
  unit?: string; // limit only — e.g. "rooms"
  premium?: boolean; // flagship feature → highlighted on pricing pages
  description?: string;
  order: number;
}

export const FEATURE_GROUPS: { id: FeatureDef["group"]; label: string }[] = [
  { id: "capacity", label: "Capacity" },
  { id: "modules", label: "Core modules" },
  { id: "growth", label: "Growth & automation" },
  { id: "platform", label: "Platform" },
  { id: "service", label: "Service levels" },
];

export const FEATURES: FeatureDef[] = [
  // ── capacity (limits) ────────────────────────────────────────────────────
  { key: "rooms", label: "Rooms", icon: "bed-double", type: "limit", unit: "rooms", group: "capacity", order: 1, description: "Total rooms you can manage" },
  { key: "staff", label: "Staff seats", icon: "users", type: "limit", unit: "seats", group: "capacity", order: 2, description: "Login accounts for your team" },
  { key: "properties", label: "Properties", icon: "building-2", type: "limit", unit: "properties", group: "capacity", order: 3, description: "Hotels under this account" },
  { key: "ota_channels", label: "OTA channels", icon: "network", type: "limit", unit: "channels", group: "capacity", order: 4, description: "Booking.com / Airbnb / MakeMyTrip etc." },
  { key: "whatsapp_msgs", label: "WhatsApp messages", icon: "message-circle", type: "limit", unit: "msgs/mo", group: "capacity", order: 5, description: "Outbound guest messages per month" },

  // ── core modules (booleans) ──────────────────────────────────────────────
  { key: "pos", label: "Restaurant POS", icon: "chef-hat", type: "boolean", group: "modules", order: 10, description: "Order taking, KOT and restaurant billing" },
  { key: "night_audit", label: "Night Audit", icon: "moon-star", type: "boolean", group: "modules", order: 11, premium: true, description: "End-of-day close, business date roll-over and no-show automation" },

  // ── growth & automation ─────────────────────────────────────────────────
  { key: "whatsapp_automation", label: "WhatsApp Automation", icon: "message-circle", type: "boolean", group: "growth", order: 20, premium: true, description: "Booking confirmations, pre-arrival, review requests on autopilot" },
  { key: "dynamic_pricing", label: "Dynamic Pricing", icon: "trending-up", type: "boolean", group: "growth", order: 21, premium: true, description: "Occupancy & demand driven auto rate suggestions" },
  { key: "advanced_reports", label: "Advanced Reports", icon: "file-bar-chart", type: "boolean", group: "growth", order: 22, description: "ARR, RevPAR, channel mix and 20+ reports" },

  // ── platform ─────────────────────────────────────────────────────────────
  { key: "excel_export", label: "Excel / CSV export", icon: "file-down", type: "boolean", group: "platform", order: 30, description: "Download any register as spreadsheet" },
  { key: "api_access", label: "API & Webhooks", icon: "code", type: "boolean", group: "platform", order: 31, premium: true, description: "REST API access and event webhooks for custom integrations" },
  { key: "white_label", label: "White-label", icon: "paintbrush", type: "boolean", group: "platform", order: 32, premium: true, description: "Your logo, colours and custom booking domain" },
  { key: "multi_property", label: "Multi-property console", icon: "building-2", type: "boolean", group: "platform", order: 33, description: "Switch between hotels in one login" },

  // ── service levels (enums) ───────────────────────────────────────────────
  { key: "support", label: "Support", icon: "life-buoy", type: "enum", group: "service", order: 40, options: ["email", "email_chat", "priority", "dedicated"], description: "Helpdesk response channel" },
  { key: "backup", label: "Data backups", icon: "database-backup", type: "enum", group: "service", order: 41, options: ["weekly", "daily", "realtime", "daily_on_demand"], description: "How often your data is backed up" },
];

export const FEATURE_MAP: Record<string, FeatureDef> = Object.fromEntries(FEATURES.map((f) => [f.key, f]));

/** Ordered features grouped for editors / pricing tables. */
export function featuresByGroup(): { group: FeatureDef["group"]; label: string; items: FeatureDef[] }[] {
  return FEATURE_GROUPS.map((g) => ({
    group: g.id,
    label: g.label,
    items: FEATURES.filter((f) => f.group === g.id).sort((a, b) => a.order - b.order),
  })).filter((g) => g.items.length > 0);
}

/** Human value for a feature in a plan's features record. */
export function formatFeatureValue(key: string, value: unknown): string {
  const def = FEATURE_MAP[key];
  if (value === true) return "Included";
  if (value === false || value === undefined || value === null) return "—";
  if (typeof value === "number") {
    if (value === -1) return "Unlimited";
    const unit = def?.unit ?? "";
    return `${value}${unit ? ` ${unit}` : ""}`;
  }
  if (def?.type === "enum") {
    if (key === "support") {
      const map: Record<string, string> = { email: "Email", email_chat: "Email + Chat", priority: "Priority", dedicated: "Dedicated manager" };
      return map[String(value)] ?? String(value);
    }
    if (key === "backup") {
      const map: Record<string, string> = { weekly: "Weekly", daily: "Daily", realtime: "Realtime", daily_on_demand: "Daily + on demand" };
      return map[String(value)] ?? String(value);
    }
  }
  return String(value);
}

/** Default starter features for a brand-new plan (owner editor template). */
export function defaultPlanFeatures(): Record<string, unknown> {
  return {
    rooms: 20, staff: 5, properties: 1, ota_channels: 2, whatsapp_msgs: 0,
    pos: false, night_audit: false,
    whatsapp_automation: false, dynamic_pricing: false, advanced_reports: false,
    excel_export: false, api_access: false, white_label: false, multi_property: false,
    support: "email", backup: "weekly",
  };
}

/* ─── add-on grants helpers ─────────────────────────────────────────────── */

export interface AddonGrant {
  key: string;
  kind: "flag" | "limit" | "tier";
  value: unknown; // true | +N | "tier string"
}

/** Parse an AddonCatalog.grants JSON string into typed grants. */
export function parseGrants(grantsJson: string | null | undefined): AddonGrant[] {
  if (!grantsJson) return [];
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(grantsJson) as Record<string, unknown>; } catch { return []; }
  return Object.entries(raw)
    .filter(([key]) => FEATURE_MAP[key])
    .map(([key, value]) => ({
      key,
      kind: typeof value === "number" ? "limit" : typeof value === "string" ? "tier" : "flag",
      value,
    }));
}

/** Serialize a grants record from the owner editor (drops unknown keys). */
export function stringifyGrants(grants: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(grants)) {
    if (!FEATURE_MAP[k]) continue;
    if (FEATURE_MAP[k].type === "limit" && typeof v === "number" && v !== 0) out[k] = v;
    else if (FEATURE_MAP[k].type === "boolean") out[k] = v === true;
    else if (FEATURE_MAP[k].type === "enum" && typeof v === "string" && v) out[k] = v;
  }
  return JSON.stringify(out);
}

/** One-line description of what an add-on grants, e.g. "Unlocks POS · +10 rooms". */
export function describeGrants(grantsJson: string | null | undefined): string {
  const grants = parseGrants(grantsJson);
  if (grants.length === 0) return "Service / one-time";
  return grants
    .map((g) => {
      const def = FEATURE_MAP[g.key];
      if (g.kind === "limit") {
        const n = g.value as number;
        return `+${n} ${def?.unit ?? def?.label?.toLowerCase() ?? g.key}`;
      }
      if (g.kind === "tier") return `${def?.label ?? g.key}: ${formatFeatureValue(g.key, g.value)}`;
      return `Unlocks ${def?.label ?? g.key}`;
    })
    .join(" · ");
}

/** Plan badges the owner can assign (marketing highlights). */
export const PLAN_BADGES = ["", "Most Popular", "Best Value", "New", "Recommended"] as const;
/** Add-on badges. */
export const ADDON_BADGES = ["", "Best Seller", "Most Popular", "Revenue Booster", "Developer Favorite", "One-time"] as const;
