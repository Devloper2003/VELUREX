/**
 * Velurex HMS — Real account seed (idempotent, non-destructive).
 * Run: bun prisma/seed-real-account.ts
 *
 * Creates ONE real production-style software-owner account for day-to-day use.
 * Demo accounts (owner@velurex.in / admin@velurex.in / …) remain in the DB but
 * are no longer shown on the login page — this real account is the documented
 * way in. Safe to re-run: it only upserts this single record.
 */
import "./env-guard-demo"; // live DB must only ever carry the ONE real owner (seed-live.ts)
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/password";

const db = new PrismaClient();

const REAL_OWNER = {
  name: "Velurex Owner",
  email: "owner@velurexhms.in",
  password: "Velurex@2025",
  role: "software_owner",
};

async function main() {
  const existing = await db.platformUser.findUnique({ where: { email: REAL_OWNER.email } });
  if (existing) {
    // Keep the existing record (never clobber a changed password) — just make
    // sure the account is active and carries the owner role.
    await db.platformUser.update({
      where: { email: REAL_OWNER.email },
      data: { active: true, role: "software_owner" },
    });
    console.log(`Real account already exists — ensured active: ${REAL_OWNER.email}`);
    return;
  }
  await db.platformUser.create({
    data: {
      name: REAL_OWNER.name,
      email: REAL_OWNER.email,
      passwordHash: hashPassword(REAL_OWNER.password),
      role: REAL_OWNER.role,
    },
  });
  console.log(`Real account created: ${REAL_OWNER.email} / ${REAL_OWNER.password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
