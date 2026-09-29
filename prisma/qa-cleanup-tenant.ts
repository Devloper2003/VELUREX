/**
 * Velurex HMS — QA cleanup: hard-delete a test tenant and every row that
 * references it. Run: bun prisma/qa-cleanup-tenant.ts <propertyId|admin-email>
 *
 * Only intended for removing test businesses created during verification —
 * it physically deletes data. Never point it at a real client.
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const key = process.argv[2];
  if (!key) throw new Error("Usage: bun prisma/qa-cleanup-tenant.ts <propertyId|admin-email>");

  const staff = await db.staff.findFirst({ where: key.startsWith("cm") ? { id: key } : { propertyId: key }, select: { propertyId: true } });
  const property =
    (await db.property.findUnique({ where: { id: key }, select: { id: true, name: true } })) ??
    (await db.property.findUnique({ where: { id: staff?.propertyId ?? "" }, select: { id: true, name: true } })) ??
    (await db.property.findFirst({
      where: { staff: { some: { email: key.toLowerCase() } } },
      select: { id: true, name: true },
    }));
  if (!property) throw new Error(`No property found for "${key}"`);
  const id = property.id;
  console.log(`Deleting QA tenant: ${property.name} (${id})`);

  // Children whose FK chains must go first
  const reservations = await db.reservation.findMany({ where: { propertyId: id }, select: { id: true } });
  const resIds = reservations.map((r) => r.id);
  const posOrders = await db.posOrder.findMany({ where: { propertyId: id }, select: { id: true } });
  const posIds = posOrders.map((o) => o.id);
  const invoices = await db.invoice.findMany({ where: { propertyId: id }, select: { id: true } });
  const invIds = invoices.map((i) => i.id);

  await db.folioItem.deleteMany({ where: { OR: [{ propertyId: id }, { reservationId: { in: resIds } }] } });
  await db.payment.deleteMany({ where: { OR: [{ propertyId: id }, { reservationId: { in: resIds } }] } });
  await db.reservation.deleteMany({ where: { propertyId: id } });
  await db.posOrderItem.deleteMany({ where: { orderId: { in: posIds } } });
  await db.posOrder.deleteMany({ where: { propertyId: id } });
  await db.invoiceItem.deleteMany({ where: { invoiceId: { in: invIds } } });
  await db.platformPayment.deleteMany({ where: { propertyId: id } });
  await db.invoice.deleteMany({ where: { propertyId: id } });
  await db.couponRedemption.deleteMany({ where: { propertyId: id } });
  await db.subscriptionAddon.deleteMany({ where: { propertyId: id } });
  await db.featureOverride.deleteMany({ where: { propertyId: id } });
  await db.subscription.deleteMany({ where: { propertyId: id } });
  await db.onboardingChecklist.deleteMany({ where: { propertyId: id } });
  await db.usageMetric.deleteMany({ where: { propertyId: id } });
  await db.announcementRead.deleteMany({ where: { propertyId: id } });
  await db.whatsAppConfig.deleteMany({ where: { propertyId: id } });
  await db.bookingHold.deleteMany({ where: { propertyId: id } });
  await db.channelSyncJob.deleteMany({ where: { propertyId: id } });
  await db.channelSyncLog.deleteMany({ where: { propertyId: id } });
  await db.channelRoomMapping.deleteMany({ where: { connection: { propertyId: id } } });
  await db.roomInventory.deleteMany({ where: { propertyId: id } });
  await db.channelConnection.deleteMany({ where: { propertyId: id } });
  await db.housekeepingTask.deleteMany({ where: { propertyId: id } });
  await db.maintenanceTicket.deleteMany({ where: { propertyId: id } });
  await db.nightAuditLog.deleteMany({ where: { propertyId: id } });
  await db.whatsAppMessage.deleteMany({ where: { propertyId: id } });
  await db.activityLog.deleteMany({ where: { propertyId: id } });
  await db.promoCode.deleteMany({ where: { propertyId: id } });
  await db.menuItem.deleteMany({ where: { propertyId: id } });
  await db.room.deleteMany({ where: { propertyId: id } });
  await db.roomType.deleteMany({ where: { propertyId: id } });
  await db.ratePlan.deleteMany({ where: { propertyId: id } });
  await db.guest.deleteMany({ where: { propertyId: id } });
  await db.staff.deleteMany({ where: { propertyId: id } });
  await db.platformAuditLog.deleteMany({ where: { propertyId: id } });
  await db.property.delete({ where: { id } });

  console.log(`QA tenant removed cleanly: ${property.name}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
