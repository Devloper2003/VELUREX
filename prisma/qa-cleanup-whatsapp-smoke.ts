/**
 * Velurex HMS — QA cleanup for Task 27-a smoke tests.
 * Removes the dummy platform WhatsApp settings + their audit rows so the live
 * owner starts UNCONFIGURED again. Run: bun prisma/qa-cleanup-whatsapp-smoke.ts
 */
import "../src/lib/env"; // canonical .env — the shell may export a stale DATABASE_URL
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const SMOKE_KEYS = [
  "whatsapp_display_phone",
  "whatsapp_phone_id",
  "whatsapp_waba_id",
  "whatsapp_token",
  "whatsapp_status",
  "whatsapp_last_checked_at",
];

async function main() {
  const settings = await db.platformSetting.deleteMany({ where: { key: { in: SMOKE_KEYS } } });
  console.log(`platformSetting rows deleted: ${settings.count}`);

  const audit = await db.platformAuditLog.deleteMany({
    where: { action: { in: ["WHATSAPP_PLATFORM_CONFIG", "WHATSAPP_PLATFORM_TEST_OK", "WHATSAPP_PLATFORM_TEST_FAILED"] } },
  });
  console.log(`platformAuditLog smoke rows deleted: ${audit.count}`);

  const waConfigs = await db.whatsAppConfig.findMany({ select: { propertyId: true } });
  console.log(`whatsAppConfig rows remaining (should be 0 for empty DB): ${waConfigs.length}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
