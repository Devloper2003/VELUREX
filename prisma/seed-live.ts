/**
 * Velurex HMS — LIVE database seed (Neon PostgreSQL, idempotent).
 * Run: bun prisma/seed-live.ts
 *
 * Purpose: initialise a CLEAN production database with ZERO demo data.
 *
 * Creates ONLY:
 *   1. The three subscription plans (Basic / Pro / Enterprise) — pricing and
 *      limits live in the plan.features JSON (single source of truth).
 *   2. ONE software-owner account: Sujeet Sharma (the live human owner).
 *      His account starts on a GENERATED TEMPORARY PASSWORD (format
 *      `Vlx@XXXXXXXX`, mustChangePassword=true) — he sets his own permanent
 *      password on first login. The temp value is printed ONCE below and
 *      only its scrypt hash is stored.
 *   3. Platform setting defaults (trial 14 days, grace 7 days, GST 18, …).
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
    pos: false, night_audit: false, whatsapp_automation: false, dynamic_pricing: false,
    advanced_reports: false, excel_export: false, api_access: false, white_label: false,
    multi_property: false, support: "email", backup: "weekly",
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

async function main() {
  // ── 1. Plans ──────────────────────────────────────────────────────────────
  const plans = [
    {
      code: "basic", name: "Basic", sortOrder: 1, monthlyPrice: 4999,
      description: "Everything a small hotel needs to go digital.",
      features: planFeatures({ support: "email", backup: "weekly" }),
    },
    {
      code: "pro", name: "Pro", sortOrder: 2, monthlyPrice: 9999,
      description: "POS, night audit, WhatsApp automation and advanced reports.",
      features: planFeatures({
        rooms: 60, staff: 15, properties: 5, ota_channels: 5, whatsapp_msgs: 500,
        pos: true, night_audit: true, whatsapp_automation: true, advanced_reports: true,
        excel_export: true, support: "email_chat", backup: "daily",
      }),
    },
    {
      code: "enterprise", name: "Enterprise", sortOrder: 3, monthlyPrice: 19999,
      description: "Unlimited scale, dynamic pricing, white-label and API access.",
      features: planFeatures({
        rooms: -1, staff: -1, properties: -1, ota_channels: -1, whatsapp_msgs: 2000,
        pos: true, night_audit: true, whatsapp_automation: true, dynamic_pricing: true,
        advanced_reports: true, excel_export: true, api_access: true, white_label: true,
        multi_property: true, support: "priority", backup: "daily_on_demand",
      }),
    },
  ];
  for (const p of plans) {
    await db.plan.upsert({
      where: { code: p.code },
      create: p,
      update: {
        name: p.name, description: p.description, monthlyPrice: p.monthlyPrice,
        features: p.features, sortOrder: p.sortOrder, active: true,
      },
    });
  }
  console.log(`Plans ensured: ${plans.map((p) => `${p.name} ₹${p.monthlyPrice}/mo`).join(" · ")}`);

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
