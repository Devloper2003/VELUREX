/**
 * Velurex HMS — LIVE database seed (Neon PostgreSQL, idempotent).
 * Run: bun prisma/seed-live.ts
 *
 * Purpose: initialise a CLEAN production database with ZERO demo data.
 *
 * Creates ONLY:
 *   1. The FOUR subscription plans (Starter / Basic / Pro / Enterprise) —
 *      pricing and limits live in the plan.features JSON (single source of truth).
 *   2. The add-on catalogue (feature unlocks + capacity packs + services) that
 *      the software owner manages from the platform console.
 *   3. ONE software-owner account: Sujeet Sharma (the live human owner).
 *      His account starts on a GENERATED TEMPORARY PASSWORD (format
 *      `Vlx@XXXXXXXX`, mustChangePassword=true) — he sets his own permanent
 *      password on first login. The temp value is printed ONCE below and
 *      only its scrypt hash is stored.
 *   4. Platform setting defaults (trial 14 days, grace 7 days, GST 18, …).
 *
 * It never creates tenants, invoices, coupons, tickets, staff or any other
 * sample/demo rows — real businesses are added by the owner via Add Business.
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword, generateTempPassword } from "../src/lib/password";
import "../src/lib/env"; // canonical .env (fixes stale shell-level DATABASE_URL)

const db = new PrismaClient();

const LIVE_OWNER = {
  name: "Sujeet Sharma",
  email: "sujeet@velurexhms.in",
  role: "software_owner",
};

function planFeatures(o: Record<string, unknown>) {
  return JSON.stringify({
    rooms: 20, staff: 5, properties: 1, ota_channels: 2, whatsapp_msgs: 0,
    pos: false, night_audit: false,
    whatsapp_automation: false, dynamic_pricing: false, advanced_reports: false,
    excel_export: false, api_access: false, white_label: false, multi_property: false,
    support: "email", backup: "weekly",
    ...o,
  });
}

const DEFAULT_SETTINGS: Array<{ key: string; value: string }> = [
  { key: "default_trial_days", value: "14" },
  { key: "grace_days", value: "7" },
  { key: "suspend_retention_days", value: "60" },
  { key: "gst_rate", value: "18" },
  { key: "yearly_discount_percent", value: "10" },
  { key: "quarterly_discount_percent", value: "5" },
  { key: "company_name", value: "Velurex Hospitality Technologies" },
];

// ── Four-tier plan matrix (v2.1) ─────────────────────────────────────────────
const PLANS = [
  {
    code: "starter", name: "Starter", sortOrder: 1, monthlyPrice: 1999,
    tagline: "For guesthouses & small B&Bs going digital",
    badge: "",
    description: "Front desk, room master, simple reservations and daily handover — everything a small property needs to leave the register behind.",
    features: planFeatures({
      rooms: 10, staff: 3, properties: 1, ota_channels: 1, whatsapp_msgs: 50,
      support: "email", backup: "weekly",
    }),
  },
  {
    code: "basic", name: "Basic", sortOrder: 2, monthlyPrice: 4999,
    tagline: "For growing hotels with a restaurant",
    badge: "",
    description: "Adds restaurant POS, housekeeping workflows, Excel exports and OTA sync so your whole operation runs from one screen.",
    features: planFeatures({
      rooms: 25, staff: 10, properties: 1, ota_channels: 3, whatsapp_msgs: 200,
      pos: true, excel_export: true,
      support: "email_chat", backup: "daily",
    }),
  },
  {
    code: "pro", name: "Pro", sortOrder: 3, monthlyPrice: 9999,
    tagline: "Automation-first for serious operators",
    badge: "Most Popular",
    description: "Night audit, WhatsApp automation on autopilot, advanced reports and multi-property switching — the complete growth stack.",
    features: planFeatures({
      rooms: 75, staff: 30, properties: 3, ota_channels: 6, whatsapp_msgs: 1000,
      pos: true, night_audit: true, whatsapp_automation: true, advanced_reports: true, excel_export: true,
      multi_property: true,
      support: "priority", backup: "daily",
    }),
  },
  {
    code: "enterprise", name: "Enterprise", sortOrder: 4, monthlyPrice: 19999,
    tagline: "Unlimited scale, API and white-label",
    badge: "Best Value",
    description: "Unlimited rooms, staff and channels, dynamic pricing, REST API + webhooks, white-label booking domain and a dedicated success manager.",
    features: planFeatures({
      rooms: -1, staff: -1, properties: -1, ota_channels: -1, whatsapp_msgs: 5000,
      pos: true, night_audit: true, whatsapp_automation: true, dynamic_pricing: true,
      advanced_reports: true, excel_export: true, api_access: true, white_label: true, multi_property: true,
      support: "dedicated", backup: "daily_on_demand",
    }),
  },
];

// ── Add-on catalogue (v2.1) — feature unlocks + capacity packs + services ────
// grants: { featureKey: true } unlocks a flag; { limitKey: N } ADDS N to that cap;
// { support: "priority" } style entries set an enum tier.
const ADDONS = [
  // feature unlocks — the "best features" of the platform, sellable standalone
  { key: "pos_pack", name: "Restaurant POS", category: "feature", price: 1499, badge: "Best Seller", icon: "chef-hat", sortOrder: 1,
    description: "Order taking, KOT printing and restaurant billing with room-posting.",
    grants: JSON.stringify({ pos: true }) },
  { key: "night_audit_pack", name: "Night Audit & Business Date", category: "feature", price: 999, badge: "", icon: "moon-star", sortOrder: 2,
    description: "Automated end-of-day close, no-show handling and business date roll-over.",
    grants: JSON.stringify({ night_audit: true }) },
  { key: "whatsapp_automation_pack", name: "WhatsApp Automation Suite", category: "feature", price: 1499, badge: "Most Popular", icon: "message-circle", sortOrder: 3,
    description: "Booking confirmations, pre-arrival notes and review requests on autopilot.",
    grants: JSON.stringify({ whatsapp_automation: true }) },
  { key: "dynamic_pricing_pack", name: "Dynamic Pricing Engine", category: "feature", price: 1999, badge: "Revenue Booster", icon: "trending-up", sortOrder: 4,
    description: "Occupancy and demand driven rate suggestions, synced to your channels.",
    grants: JSON.stringify({ dynamic_pricing: true }) },
  { key: "advanced_reports_pack", name: "Advanced Reports & Analytics", category: "feature", price: 999, badge: "", icon: "file-bar-chart", sortOrder: 5,
    description: "ARR, RevPAR, channel mix, source analysis and 20+ operational reports.",
    grants: JSON.stringify({ advanced_reports: true }) },
  { key: "excel_export_pack", name: "Excel & CSV Export", category: "feature", price: 499, badge: "", icon: "file-down", sortOrder: 6,
    description: "Download any register — folios, ledger, occupancy — as spreadsheets.",
    grants: JSON.stringify({ excel_export: true }) },
  { key: "api_access_pack", name: "API & Webhooks Access", category: "feature", price: 2499, badge: "Developer Favorite", icon: "code", sortOrder: 7,
    description: "REST API keys and event webhooks to wire Velurex into your own tools.",
    grants: JSON.stringify({ api_access: true }) },
  { key: "white_label_pack", name: "White-label & Custom Domain", category: "feature", price: 2999, badge: "", icon: "paintbrush", sortOrder: 8,
    description: "Your logo, colours and booking engine on your own domain.",
    grants: JSON.stringify({ white_label: true }) },
  { key: "priority_support_pack", name: "Priority Support Upgrade", category: "feature", price: 1499, badge: "", icon: "life-buoy", sortOrder: 9,
    description: "Jump the queue — priority chat and call-back support for your team.",
    grants: JSON.stringify({ support: "priority" }) },

  // capacity packs — stackable
  { key: "rooms_pack", name: "Extra Rooms Pack (+10)", category: "capacity", price: 999, badge: "", icon: "bed-double", sortOrder: 20,
    description: "Raise your room cap by 10. Stack multiple packs.",
    grants: JSON.stringify({ rooms: 10 }) },
  { key: "staff_pack", name: "Extra Staff Seats (+5)", category: "capacity", price: 499, badge: "", icon: "users", sortOrder: 21,
    description: "Five more login seats for your team. Stackable.",
    grants: JSON.stringify({ staff: 5 }) },
  { key: "whatsapp_msgs_pack", name: "WhatsApp Messages (+500/mo)", category: "capacity", price: 799, badge: "", icon: "message-circle", sortOrder: 22,
    description: "500 extra outbound guest messages every month.",
    grants: JSON.stringify({ whatsapp_msgs: 500 }) },
  { key: "ota_pack", name: "Extra OTA Channel (+1)", category: "capacity", price: 799, badge: "", icon: "network", sortOrder: 23,
    description: "Connect one more OTA — Booking.com, Airbnb, MakeMyTrip, GoMMT…",
    grants: JSON.stringify({ ota_channels: 1 }) },
  { key: "properties_pack", name: "Extra Property (+1)", category: "capacity", price: 1499, badge: "", icon: "building-2", sortOrder: 24,
    description: "Add one more hotel to your account with its own console.",
    grants: JSON.stringify({ properties: 1 }) },

  // services — one-off
  { key: "setup_fee", name: "Assisted Onboarding & Data Setup", category: "service", price: 4999, oneOff: true, badge: "One-time", icon: "wrench", sortOrder: 40,
    description: "We import your rooms, rates, taxes and open folios and train your team.",
    grants: JSON.stringify({}) },
];

async function main() {
  // ── 1. Plans ──────────────────────────────────────────────────────────────
  for (const p of PLANS) {
    await db.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code, name: p.name, description: p.description, tagline: p.tagline,
        badge: p.badge, monthlyPrice: p.monthlyPrice, features: p.features,
        sortOrder: p.sortOrder, active: true,
      },
      update: {
        name: p.name, description: p.description, tagline: p.tagline, badge: p.badge,
        monthlyPrice: p.monthlyPrice, features: p.features, sortOrder: p.sortOrder, active: true,
      },
    });
  }
  console.log(`Plans ensured: ${PLANS.map((p) => `${p.name} ₹${p.monthlyPrice}/mo`).join(" · ")}`);

  // ── 1b. Add-on catalogue ──────────────────────────────────────────────────
  for (const a of ADDONS) {
    const { key, name, category, price, oneOff = false, badge, icon, sortOrder, description, grants } = a;
    await db.addonCatalog.upsert({
      where: { key },
      create: { key, name, category, price, oneOff, badge, icon, sortOrder, description, grants, active: true },
      update: { name, category, price, oneOff, badge, icon, sortOrder, description, grants, active: true },
    });
  }
  console.log(`Add-on catalogue ensured: ${ADDONS.length} items`);

  // ── 2. The ONE live software owner (Sujeet Sharma) ────────────────────────
  const existing = await db.platformUser.findUnique({ where: { email: LIVE_OWNER.email } });
  if (existing) {
    await db.platformUser.update({
      where: { email: LIVE_OWNER.email },
      data: { name: LIVE_OWNER.name, role: LIVE_OWNER.role, active: true },
    });
    console.log(`Live owner already exists (password untouched): ${LIVE_OWNER.email}`);
  } else {
    const temp = generateTempPassword();
    await db.platformUser.create({
      data: {
        name: LIVE_OWNER.name,
        email: LIVE_OWNER.email,
        passwordHash: hashPassword(temp),
        role: LIVE_OWNER.role,
        mustChangePassword: true,
      },
    });
    console.log("══════════════════════════════════════════════════════════");
    console.log("  LIVE SOFTWARE OWNER CREATED (share securely, shown once)");
    console.log(`  Name     : ${LIVE_OWNER.name}`);
    console.log(`  Email    : ${LIVE_OWNER.email}`);
    console.log(`  Temp pass: ${temp}`);
    console.log("  He must set a permanent password on first login.");
    console.log("══════════════════════════════════════════════════════════");
  }

  // ── 3. Platform setting defaults (never overwrite existing values) ───────
  for (const s of DEFAULT_SETTINGS) {
    const row = await db.platformSetting.findUnique({ where: { key: s.key } });
    if (!row) {
      await db.platformSetting.create({ data: { key: s.key, value: s.value, encrypted: false } });
    }
  }
  console.log(`Platform setting defaults ensured: ${DEFAULT_SETTINGS.map((s) => s.key).join(", ")}`);

  // ── Sanity report ─────────────────────────────────────────────────────────
  const [planCount, ownerCount, propertyCount, staffCount, demoCount] = await Promise.all([
    db.plan.count(),
    db.platformUser.count(),
    db.property.count(),
    db.staff.count(),
    db.property.count({ where: { isDemo: true } }),
  ]);
  console.log(`Sanity — plans:${planCount} platformUsers:${ownerCount} businesses:${propertyCount} staff:${staffCount} demoTenants:${demoCount}`);
  if (propertyCount > 0 || staffCount > 0) {
    console.log("WARNING: live DB should have ZERO businesses/staff at seed time.");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
