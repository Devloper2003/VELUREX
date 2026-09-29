/**
 * Velurex HMS — Flag all existing seed/demo data as `isDemo` (idempotent, additive).
 * Run: bun prisma/seed-flag-demo.ts
 *
 * ⚠️  HARD GUARD: demo-data script — never runs against the live PostgreSQL DB.
 */
import "./env-guard-demo";
/*
 * The real software owner (owner@velurexhms.in) must see a CLEAN platform with
 * zero demo businesses / coupons / leads / announcements so real clients can be
 * assigned. This script marks everything that existed before the platform went
 * live as demo — nothing is deleted; the demo owner (owner@velurex.in) and the
 * "Show demo data" toggle still expose it.
 *
 * Safe to re-run at any time BEFORE real clients are onboarded: it only flags
 * rows that are not yet flagged. NEVER run it after real tenants exist — new
 * rows created through the console default to isDemo=false and are untouched.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const DEMO_OWNER_EMAIL = "owner@velurex.in";

async function main() {
  // ── 1. Tenants: every property that exists today is seed/demo data
  const props = await db.property.updateMany({
    where: { isDemo: false },
    data: { isDemo: true },
  });
  console.log(`Properties flagged demo: ${props.count}`);

  // ── 2. Platform accounts: the demo owner keeps full demo visibility
  const owners = await db.platformUser.updateMany({
    where: { email: DEMO_OWNER_EMAIL, isDemo: false },
    data: { isDemo: true },
  });
  console.log(`Demo platform owner flagged: ${owners.count}`);

  // ── 3. Platform-level seed data (coupons / leads / announcements)
  const coupons = await db.coupon.updateMany({ where: { isDemo: false }, data: { isDemo: true } });
  const leads = await db.lead.updateMany({ where: { isDemo: false }, data: { isDemo: true } });
  const announcements = await db.announcement.updateMany({ where: { isDemo: false }, data: { isDemo: true } });
  console.log(`Coupons flagged: ${coupons.count} · Leads flagged: ${leads.count} · Announcements flagged: ${announcements.count}`);

  const real = await db.platformUser.findUnique({ where: { email: "owner@velurexhms.in" } });
  console.log(
    real
      ? `Real owner verified clean: owner@velurexhms.in (isDemo=${real.isDemo})`
      : "WARNING: real owner owner@velurexhms.in not found — run bun prisma/seed-real-account.ts"
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
