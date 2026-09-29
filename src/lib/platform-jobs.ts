import { db } from "@/lib/db";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { getPlatformSettingNumber, nextInvoiceNumber, platformGstRate, logPlatformAction, cyclePrice } from "@/lib/platform";

/**
 * Daily platform jobs (run by instrumentation scheduler + the manual trigger):
 *   1. trial reminders (7/3/1 days left) → platform audit entries (email/WhatsApp stub)
 *   2. renewal sweep: autoRenew → invoice + roll renewal date; no autoRenew → overdue
 *   3. overdue → grace (7d) → suspend (data retained 60d) → cancelled after retention
 *   4. apply scheduled (pendingPlanId) downgrades at renewal
 *   5. usage_metrics snapshot for every live tenant
 *   6. health score refresh
 */
export async function runDailyJobs(): Promise<{ ran: string[]; skipped: string[] }> {
  const ran: string[] = [];
  const skipped: string[] = [];
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const lastRun = await db.platformSetting.findUnique({ where: { key: "cron_last_run" } });
  if (lastRun?.value === today) {
    return { ran, skipped: ["already-ran-today"] };
  }

  const graceDays = await getPlatformSettingNumber("grace_days", 7);
  const retentionDays = await getPlatformSettingNumber("suspend_retention_days", 60);

  const subs = await db.subscription.findMany({
    where: { status: { not: "cancelled" } },
    include: { plan: true, property: { include: { _count: { select: { rooms: true, staff: true } } } } },
  });

  let reminders = 0, renewals = 0, overdueMarked = 0, suspended = 0, cancelled = 0;

  for (const sub of subs) {
    const prop = sub.property;
    if (!prop || prop.deletedAt) continue;

    // ── 1. Trial reminders at 7 / 3 / 1 days
    if (sub.status === "trial" && sub.trialEndsAt) {
      const daysLeft = Math.ceil((sub.trialEndsAt.getTime() - now.getTime()) / 86400000);
      if ([7, 3, 1].includes(daysLeft)) {
        await logPlatformAction({
          actorName: "system", action: "TRIAL_REMINDER", entity: "subscription", entityId: sub.id,
          propertyId: sub.propertyId,
          details: `${prop.name}: trial ends in ${daysLeft} day(s) — reminder queued (email/WhatsApp stub, TODO provider)`,
        });
        reminders++;
      }
      if (daysLeft <= 0) {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "overdue" } });
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "overdue" } });
        await clearEntitlementsCache(sub.propertyId);
        await logPlatformAction({
          actorName: "system", action: "TRIAL_LAPSED", entity: "subscription", entityId: sub.id,
          propertyId: sub.propertyId, details: `${prop.name}: trial ended → overdue (grace ${graceDays}d)`,
        });
        overdueMarked++;
      }
    }

    // ── 2. Renewal sweep (active only)
    if (sub.status === "active" && sub.renewalAt && sub.renewalAt <= now) {
      if (sub.autoRenew) {
        const price = await cyclePrice(sub.plan.monthlyPrice, sub.cycle);
        const gst = await platformGstRate();
        const tax = Math.round(price * (gst / 100) * 100) / 100;
        const number = await nextInvoiceNumber();
        const cycleDays = sub.cycle === "yearly" ? 365 : sub.cycle === "quarterly" ? 90 : 30;
        const newRenewal = new Date(sub.renewalAt.getTime() + cycleDays * 86400000);
        const inv = await db.invoice.create({
          data: {
            number, propertyId: sub.propertyId, subscriptionId: sub.id, type: "subscription",
            status: "pending", subtotal: price, taxAmount: tax,
            totalAmount: Math.round((price + tax) * 100) / 100,
            periodStart: sub.renewalAt, periodEnd: newRenewal,
            dueDate: new Date(now.getTime() + 7 * 86400000),
            notes: "Auto-generated at renewal",
          },
        });
        await db.invoiceItem.create({
          data: { invoiceId: inv.id, description: `${sub.plan.name} plan — ${sub.cycle}`, qty: 1, unitPrice: price, taxRate: gst, amount: price },
        });
        await db.subscription.update({ where: { id: sub.id }, data: { renewalAt: newRenewal } });
        renewals++;
        await logPlatformAction({
          actorName: "system", action: "RENEWAL_INVOICED", entity: "invoice", entityId: inv.id,
          propertyId: sub.propertyId, details: `${prop.name}: renewal invoice ${number} (₹${inv.totalAmount})`,
        });
      } else {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "overdue" } });
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "overdue" } });
        await clearEntitlementsCache(sub.propertyId);
        overdueMarked++;
      }
    }

    // ── 3. Overdue → grace → suspend → cancel
    if (sub.status === "overdue" && sub.renewalAt) {
      const graceEnd = sub.renewalAt.getTime() + graceDays * 86400000;
      if (now.getTime() > graceEnd) {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "suspended" } });
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "suspended" } });
        await clearEntitlementsCache(sub.propertyId);
        await logPlatformAction({
          actorName: "system", action: "TENANT_SUSPENDED", entity: "subscription", entityId: sub.id,
          propertyId: sub.propertyId,
          details: `${prop.name}: grace period (${graceDays}d) elapsed → suspended. Data retained ${retentionDays}d.`,
        });
        suspended++;
      }
    }

    if (sub.status === "suspended" && sub.updatedAt) {
      const retentionEnd = sub.updatedAt.getTime() + retentionDays * 86400000;
      if (now.getTime() > retentionEnd) {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "cancelled", cancelledAt: now } });
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "cancelled" } });
        cancelled++;
        await logPlatformAction({
          actorName: "system", action: "TENANT_CANCELLED", entity: "subscription", entityId: sub.id,
          propertyId: sub.propertyId,
          details: `${prop.name}: ${retentionDays}d retention elapsed → cancelled (data archive TODO)`,
        });
      }
    }

    // ── 4. Scheduled downgrades at renewal
    if (sub.pendingPlanId && sub.renewalAt && sub.renewalAt <= now) {
      const plan = await db.plan.findUnique({ where: { id: sub.pendingPlanId } });
      if (plan) {
        await db.subscription.update({ where: { id: sub.id }, data: { planId: plan.id, pendingPlanId: null } });
        await db.property.update({ where: { id: sub.propertyId }, data: { currentPlanId: plan.id } });
        await clearEntitlementsCache(sub.propertyId);
        await logPlatformAction({
          actorName: "system", action: "PLAN_DOWNGRADED", entity: "subscription", entityId: sub.id,
          propertyId: sub.propertyId, details: `${prop.name}: scheduled downgrade applied → ${plan.name}`,
        });
      }
    }
  }

  // ── 5. Usage snapshot for every live tenant
  const tenants = await db.property.findMany({ where: { deletedAt: null } });
  const subStatusByProperty = new Map(subs.map((s) => [s.propertyId, s.status]));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  for (const t of tenants) {
    const [rooms, staff, bookings, wa] = await Promise.all([
      db.room.count({ where: { propertyId: t.id } }),
      db.staff.count({ where: { propertyId: t.id } }),
      db.reservation.count({ where: { propertyId: t.id } }),
      db.whatsAppMessage.count({ where: { propertyId: t.id, createdAt: { gte: monthStart } } }),
    ]);
    const lastActive = await db.activityLog.findFirst({ where: { propertyId: t.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
    await db.usageMetric.upsert({
      where: { propertyId_date: { propertyId: t.id, date: today } },
      create: {
        propertyId: t.id, date: today, roomsUsed: rooms, staffUsed: staff,
        bookings, whatsappMsgs: wa, lastActiveAt: lastActive?.createdAt ?? null,
      },
      update: {
        roomsUsed: rooms, staffUsed: staff, bookings, whatsappMsgs: wa,
        lastActiveAt: lastActive?.createdAt ?? null,
      },
    });

    // ── 6. Health score: activity + onboarding completeness + billing state
    const checklist = await db.onboardingChecklist.findUnique({ where: { propertyId: t.id } });
    const done = [checklist?.roomsAdded, checklist?.staffCreated, checklist?.otaConnected, checklist?.firstBooking].filter(Boolean).length;
    let health = 40 + done * 10; // 40-80
    if (lastActive && now.getTime() - lastActive.createdAt.getTime() < 7 * 86400000) health += 10;
    if (subStatusByProperty.get(t.id) === "overdue") health -= 25;
    if (subStatusByProperty.get(t.id) === "suspended") health -= 40;
    health = Math.max(0, Math.min(100, health));
    await db.property.update({ where: { id: t.id }, data: { healthScore: health } });
  }

  await db.platformSetting.upsert({
    where: { key: "cron_last_run" },
    create: { key: "cron_last_run", value: today, updatedBy: "daily-jobs" },
    update: { value: today, updatedBy: "daily-jobs" },
  });

  await logPlatformAction({
    actorName: "system", action: "DAILY_JOBS", entity: "platform",
    details: `Renewals invoiced: ${renewals} · reminders: ${reminders} · overdue: ${overdueMarked} · suspended: ${suspended} · cancelled: ${cancelled} · snapshots: ${tenants.length}`,
  });

  ran.push(`renewals:${renewals}`, `reminders:${reminders}`, `overdue:${overdueMarked}`, `suspended:${suspended}`, `snapshots:${tenants.length}`);
  return { ran, skipped };
}
