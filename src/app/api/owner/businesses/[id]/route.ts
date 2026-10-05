import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { PLAN_CORE_SELECT, findPlanSafe } from "@/lib/plan-safe";
import { getTenantEntitlements, clearEntitlementsCache } from "@/lib/entitlements";
import { logPlatformAction, nextInvoiceNumber, platformGstRate, cyclePrice } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/** GET /api/owner/businesses/[id] — full detail: profile, subscription, usage, staff, activity. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const property = await db.property.findUnique({
    where: { id },
    include: {
      subscription: { include: { plan: { select: PLAN_CORE_SELECT } } },
      addons: { where: { active: true } },
      overrides: true,
      staff: { orderBy: { createdAt: "asc" } },
      checklist: true,
      whatsappConfig: true,
    },
  });
  if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

  const ent = await getTenantEntitlements(id);
  const [roomCount, resCount, waCount, invoices, auditTrail, usage] = await Promise.all([
    db.room.count({ where: { propertyId: id } }),
    db.reservation.count({ where: { propertyId: id } }),
    db.whatsAppMessage.count({ where: { propertyId: id } }),
    db.invoice.findMany({ where: { propertyId: id }, orderBy: { createdAt: "desc" }, take: 12 }),
    db.platformAuditLog.findMany({ where: { propertyId: id }, orderBy: { createdAt: "desc" }, take: 15 }),
    db.usageMetric.findMany({ where: { propertyId: id }, orderBy: { date: "desc" }, take: 14 }),
  ]);

  return NextResponse.json({
    business: {
      id: property.id, name: property.name, address: property.address, city: property.city,
      state: property.state, phone: property.phone, email: property.email, gstin: property.gstin,
      type: property.propertyType, category: property.businessCategory,
      status: property.deletedAt ? "deleted" : property.subscriptionStatus,
      trialEndsAt: property.trialEndsAt, healthScore: property.healthScore,
      notes: property.notes, deletedAt: property.deletedAt, createdAt: property.createdAt,
    },
    plan: ent.plan,
    subscription: ent.subscription,
    entitlements: { features: ent.features, limits: ent.limits, addons: ent.addons, overrides: ent.overrides, writable: ent.writable, warning: ent.warning },
    usage: { rooms: roomCount, staff: property.staff.length, bookings: resCount, whatsappMsgs: waCount },
    staff: property.staff.map((s) => ({ id: s.id, name: s.name, email: s.email, role: s.role, active: s.active, lastLoginAt: s.lastLoginAt })),
    checklist: property.checklist,
    whatsapp: property.whatsappConfig
      ? {
          displayPhone: property.whatsappConfig.displayPhone,
          phoneNumberId: property.whatsappConfig.phoneNumberId,
          wabaId: property.whatsappConfig.wabaId,
          connected: property.whatsappConfig.status === "connected",
          status: property.whatsappConfig.status,
          lastError: property.whatsappConfig.lastError,
          connectedAt: property.whatsappConfig.connectedAt,
          lastCheckedAt: property.whatsappConfig.lastCheckedAt,
        }
      : null,
    invoices,
    auditTrail,
    usageHistory: usage,
  });
}

/**
 * PATCH /api/owner/businesses/[id] — owner actions:
 *   edit | suspend | activate | change_plan | reassign_admin | soft_delete |
 *   restore | extend_trial | notes
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const property = await db.property.findUnique({ where: { id }, include: { subscription: { include: { plan: { select: PLAN_CORE_SELECT } } } } });
  if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const audit = (details: string) =>
    logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: action.toUpperCase(),
      entity: "property", entityId: id, propertyId: id, details,
    });

  switch (action) {
    case "edit": {
      const updated = await db.property.update({
        where: { id },
        data: {
          name: body.name !== undefined ? String(body.name) : undefined,
          city: body.city !== undefined ? String(body.city) : undefined,
          state: body.state !== undefined ? String(body.state) : undefined,
          phone: body.phone !== undefined ? String(body.phone) : undefined,
          email: body.email !== undefined ? String(body.email) : undefined,
          gstin: body.gstin !== undefined ? String(body.gstin) : undefined,
          propertyType: body.propertyType !== undefined ? String(body.propertyType) : undefined,
        },
      });
      await audit("Profile updated");
      return NextResponse.json({ ok: true, business: { id: updated.id, name: updated.name } });
    }

    case "suspend": {
      await db.property.update({ where: { id }, data: { subscriptionStatus: "suspended" } });
      if (property.subscription) {
        await db.subscription.update({ where: { id: property.subscription.id }, data: { status: "suspended" } });
      }
      await clearEntitlementsCache(id);
      await audit("Business suspended — data retained, login blocked");
      return NextResponse.json({ ok: true, status: "suspended" });
    }

    case "activate": {
      await db.property.update({ where: { id }, data: { subscriptionStatus: "active" } });
      if (property.subscription) {
        await db.subscription.update({
          where: { id: property.subscription.id },
          data: { status: "active", renewalAt: property.subscription.renewalAt ?? new Date(Date.now() + 30 * 86400000) },
        });
      }
      await clearEntitlementsCache(id);
      await audit("Business re-activated");
      return NextResponse.json({ ok: true, status: "active" });
    }

    case "change_plan": {
      const newPlanId = String(body.planId ?? "");
      const newCycle = ["monthly", "quarterly", "yearly"].includes(body.cycle) ? body.cycle : property.subscription?.cycle ?? "monthly";
      const plan = await findPlanSafe(newPlanId);
      if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

      const oldPlan = property.subscription?.plan;
      const isUpgrade = plan.monthlyPrice > (oldPlan?.monthlyPrice ?? 0);
      const oldCyclePrice = oldPlan ? await cyclePrice(oldPlan.monthlyPrice, property.subscription?.cycle ?? "monthly") : 0;
      const newCyclePrice = await cyclePrice(plan.monthlyPrice, newCycle);

      // Prorated upgrade: unused old-plan time credited against the new cycle charge.
      let invoiceNumber: string | null = null;
      if (isUpgrade && property.subscription) {
        const now = Date.now();
        const renewal = property.subscription.renewalAt?.getTime() ?? now;
        const cycleMs = (property.subscription.cycle === "yearly" ? 365 : property.subscription.cycle === "quarterly" ? 90 : 30) * 86400000;
        const remaining = Math.max(0, renewal - now);
        const credit = cycleMs > 0 ? (oldCyclePrice * remaining) / cycleMs : 0;
        const net = Math.max(0, Math.round((newCyclePrice - credit) * 100) / 100);
        const gst = await platformGstRate();
        const tax = Math.round(net * (gst / 100) * 100) / 100;
        invoiceNumber = await nextInvoiceNumber();
        const inv = await db.invoice.create({
          data: {
            number: invoiceNumber, propertyId: id, subscriptionId: property.subscription.id,
            type: "subscription", status: "pending",
            subtotal: newCyclePrice, discountAmount: Math.round(credit * 100) / 100,
            taxAmount: tax, totalAmount: Math.round((net + tax) * 100) / 100,
            periodStart: new Date(), periodEnd: property.subscription.renewalAt,
            dueDate: new Date(now + 7 * 86400000),
            notes: `Prorated upgrade ${oldPlan?.name ?? "—"} → ${plan.name} (credit ₹${Math.round(credit)} for unused time)`,
          },
        });
        await db.invoiceItem.create({
          data: {
            invoiceId: inv.id,
            description: `${plan.name} plan — ${newCycle}${credit > 0 ? ` (credit −₹${Math.round(credit)})` : ""}`,
            qty: 1, unitPrice: newCyclePrice, taxRate: gst, amount: newCyclePrice,
          },
        });
      }

      await db.property.update({ where: { id }, data: { currentPlanId: plan.id } });
      if (property.subscription) {
        await db.subscription.update({
          where: { id: property.subscription.id },
          data: { planId: plan.id, cycle: newCycle, pendingPlanId: null },
        });
      }
      await clearEntitlementsCache(id);
      await audit(`Plan changed: ${oldPlan?.name ?? "—"} → ${plan.name} (${newCycle})${isUpgrade ? ` — prorated invoice ${invoiceNumber}` : ""}`);
      return NextResponse.json({ ok: true, invoiceNumber, upgrade: isUpgrade });
    }

    case "reassign_admin": {
      const adminId = String(body.adminId ?? "");
      const staff = await db.staff.findFirst({ where: { id: adminId, propertyId: id } });
      if (!staff) return NextResponse.json({ error: "Staff member not found in this business" }, { status: 404 });
      await db.staff.update({ where: { id: adminId }, data: { role: "hotel_admin" } });
      await audit(`Admin assigned: ${staff.name} (${staff.email})`);
      return NextResponse.json({ ok: true });
    }

    case "soft_delete": {
      await db.property.update({ where: { id }, data: { deletedAt: new Date() } });
      await audit("Business soft-deleted — data retained for 60 days before purge");
      return NextResponse.json({ ok: true, status: "deleted" });
    }

    case "restore": {
      await db.property.update({ where: { id }, data: { deletedAt: null } });
      await audit("Business restored from soft-delete");
      return NextResponse.json({ ok: true, status: property.subscriptionStatus });
    }

    case "extend_trial": {
      const days = Math.max(1, parseInt(String(body.days ?? "7"), 10) || 7);
      const base = property.trialEndsAt && property.trialEndsAt > new Date() ? property.trialEndsAt : new Date();
      const newEnd = new Date(base.getTime() + days * 86400000);
      await db.property.update({ where: { id }, data: { trialEndsAt: newEnd, subscriptionStatus: "trial" } });
      if (property.subscription) {
        await db.subscription.update({
          where: { id: property.subscription.id },
          data: { trialEndsAt: newEnd, status: "trial", renewalAt: newEnd },
        });
      }
      await clearEntitlementsCache(id);
      await audit(`Trial extended by ${days} days → ${newEnd.toISOString().slice(0, 10)}`);
      return NextResponse.json({ ok: true, trialEndsAt: newEnd });
    }

    case "notes": {
      await db.property.update({ where: { id }, data: { notes: String(body.notes ?? "") } });
      await audit("Notes updated");
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
