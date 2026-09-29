import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { clearEntitlementsCache } from "@/lib/entitlements";
import { logPlatformAction, nextInvoiceNumber, platformGstRate, cyclePrice } from "@/lib/platform";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/owner/subscriptions/[id] — one subscription with entitlements detail.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;

  const sub = await db.subscription.findUnique({
    where: { id },
    include: {
      plan: true,
      property: { include: { _count: { select: { rooms: true, staff: true } } } },
    },
  });
  if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

  const [overrides, addons] = await Promise.all([
    db.featureOverride.findMany({ where: { propertyId: sub.propertyId } }),
    db.subscriptionAddon.findMany({ where: { propertyId: sub.propertyId, active: true } }),
  ]);

  return NextResponse.json({
    subscription: {
      id: sub.id, cycle: sub.cycle, status: sub.status, startedAt: sub.startedAt,
      renewalAt: sub.renewalAt, trialEndsAt: sub.trialEndsAt, autoRenew: sub.autoRenew,
      pausedAt: sub.pausedAt, pendingPlanId: sub.pendingPlanId, notes: sub.notes,
    },
    plan: sub.plan,
    property: sub.property,
    addons,
    overrides,
  });
}

/**
 * PATCH /api/owner/subscriptions/[id] — lifecycle actions:
 *   upgrade | downgrade | pause | resume | cancel | extend | toggle_auto_renew |
 *   apply_pending_plan | add_addon | remove_addon | set_override | remove_override
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;
  const { id } = await params;

  const sub = await db.subscription.findUnique({
    where: { id },
    include: { plan: true, property: true },
  });
  if (!sub) return NextResponse.json({ error: "Subscription not found" }, { status: 404 });

  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? "");
  const audit = (details: string) =>
    logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: action.toUpperCase(),
      entity: "subscription", entityId: id, propertyId: sub.propertyId, details,
    });

  switch (action) {
    case "upgrade":
    case "downgrade": {
      const planId = String(body.planId ?? "");
      const cycle = ["monthly", "quarterly", "yearly"].includes(body.cycle) ? body.cycle : sub.cycle;
      const plan = await db.plan.findUnique({ where: { id: planId } });
      if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

      const isUpgrade = plan.monthlyPrice >= sub.plan.monthlyPrice;

      if (isUpgrade) {
        // Immediate + prorated invoice (credit for unused old-plan time).
        const oldCyclePrice = await cyclePrice(sub.plan.monthlyPrice, sub.cycle);
        const newCyclePrice = await cyclePrice(plan.monthlyPrice, cycle);
        const now = Date.now();
        const renewal = sub.renewalAt?.getTime() ?? now;
        const cycleMs = (sub.cycle === "yearly" ? 365 : sub.cycle === "quarterly" ? 90 : 30) * 86400000;
        const credit = cycleMs > 0 ? Math.max(0, (oldCyclePrice * (renewal - now)) / cycleMs) : 0;
        const net = Math.max(0, Math.round((newCyclePrice - credit) * 100) / 100);
        const gst = await platformGstRate();
        const tax = Math.round(net * (gst / 100) * 100) / 100;
        const number = await nextInvoiceNumber();
        const inv = await db.invoice.create({
          data: {
            number, propertyId: sub.propertyId, subscriptionId: sub.id, type: "subscription",
            status: "pending", subtotal: newCyclePrice, discountAmount: Math.round(credit * 100) / 100,
            taxAmount: tax, totalAmount: Math.round((net + tax) * 100) / 100,
            periodStart: new Date(), periodEnd: sub.renewalAt,
            dueDate: new Date(now + 7 * 86400000),
            notes: `Prorated upgrade ${sub.plan.name} → ${plan.name}`,
          },
        });
        await db.invoiceItem.create({
          data: { invoiceId: inv.id, description: `${plan.name} plan — ${cycle}`, qty: 1, unitPrice: newCyclePrice, taxRate: gst, amount: newCyclePrice },
        });
        await db.subscription.update({ where: { id }, data: { planId, cycle, pendingPlanId: null } });
        await db.property.update({ where: { id: sub.propertyId }, data: { currentPlanId: plan.id } });
        await clearEntitlementsCache(sub.propertyId);
        await audit(`Upgraded ${sub.plan.name} → ${plan.name} (${cycle}) — prorated invoice ${number}`);
        return NextResponse.json({ ok: true, invoiceNumber: number });
      }

      // Downgrade: scheduled for next renewal + usage warning when over the new caps.
      const features = JSON.parse(plan.features || "{}") as Record<string, unknown>;
      const warnings: string[] = [];
      const roomCount = await db.room.count({ where: { propertyId: sub.propertyId } });
      const staffCount = await db.staff.count({ where: { propertyId: sub.propertyId } });
      if (typeof features.rooms === "number" && features.rooms !== -1 && roomCount > features.rooms)
        warnings.push(`${roomCount} rooms exceed the ${plan.name} cap of ${features.rooms} — new rooms will be blocked until usage drops or an add-on is added`);
      if (typeof features.staff === "number" && features.staff !== -1 && staffCount > features.staff)
        warnings.push(`${staffCount} staff exceed the ${plan.name} cap of ${features.staff} — existing staff stay active but no new seats can be created`);
      if (features.pos === false) warnings.push("Restaurant POS will be locked");
      if (features.night_audit === false) warnings.push("Night Audit will be locked");

      await db.subscription.update({ where: { id }, data: { pendingPlanId: planId } });
      await audit(`Downgrade to ${plan.name} scheduled for next renewal (${sub.renewalAt?.toISOString().slice(0, 10) ?? "—"})`);
      return NextResponse.json({ ok: true, scheduled: true, warnings, effectiveAt: sub.renewalAt });
    }

    case "pause": {
      await db.subscription.update({ where: { id }, data: { status: "paused", pausedAt: new Date() } });
      await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "suspended" } });
      await clearEntitlementsCache(sub.propertyId);
      await audit("Subscription paused — workspace blocked, data retained");
      return NextResponse.json({ ok: true, status: "paused" });
    }

    case "resume": {
      await db.subscription.update({ where: { id }, data: { status: "active", pausedAt: null } });
      await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "active" } });
      await clearEntitlementsCache(sub.propertyId);
      await audit("Subscription resumed");
      return NextResponse.json({ ok: true, status: "active" });
    }

    case "cancel": {
      await db.subscription.update({ where: { id }, data: { status: "cancelled", autoRenew: false, cancelledAt: new Date() } });
      await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "cancelled" } });
      await clearEntitlementsCache(sub.propertyId);
      await audit("Subscription cancelled — data retained 60 days");
      return NextResponse.json({ ok: true, status: "cancelled" });
    }

    case "extend": {
      const days = Math.max(1, parseInt(String(body.days ?? "7"), 10) || 7);
      const base = sub.renewalAt && sub.renewalAt > new Date() ? sub.renewalAt : new Date();
      const newRenewal = new Date(base.getTime() + days * 86400000);
      await db.subscription.update({ where: { id }, data: { renewalAt: newRenewal, status: sub.status === "overdue" ? "active" : sub.status } });
      if (sub.status === "overdue") {
        await db.property.update({ where: { id: sub.propertyId }, data: { subscriptionStatus: "active" } });
      }
      await clearEntitlementsCache(sub.propertyId);
      await audit(`Renewal extended ${days} days → ${newRenewal.toISOString().slice(0, 10)}`);
      return NextResponse.json({ ok: true, renewalAt: newRenewal });
    }

    case "toggle_auto_renew": {
      const autoRenew = !sub.autoRenew;
      await db.subscription.update({ where: { id }, data: { autoRenew } });
      await audit(`Auto-renew ${autoRenew ? "enabled" : "disabled"}`);
      return NextResponse.json({ ok: true, autoRenew });
    }

    case "apply_pending_plan": {
      if (!sub.pendingPlanId) return NextResponse.json({ error: "No pending plan change" }, { status: 400 });
      const plan = await db.plan.findUnique({ where: { id: sub.pendingPlanId } });
      if (!plan) return NextResponse.json({ error: "Pending plan not found" }, { status: 404 });
      await db.subscription.update({ where: { id }, data: { planId: plan.id, pendingPlanId: null } });
      await db.property.update({ where: { id: sub.propertyId }, data: { currentPlanId: plan.id } });
      await clearEntitlementsCache(sub.propertyId);
      await audit(`Scheduled plan change applied: now on ${plan.name}`);
      return NextResponse.json({ ok: true });
    }

    case "add_addon": {
      const addonKey = String(body.addonKey ?? "rooms_pack");
      const labels: Record<string, string> = {
        rooms_pack: "Extra Rooms Pack (+10 rooms)",
        staff_pack: "Extra Staff Pack (+5 seats)",
        whatsapp_pack: "WhatsApp Pack (+100 msgs/mo)",
        ota_pack: "Extra OTA Channel",
        setup_fee: "One-time setup fee",
      };
      const price = Math.max(0, Number(body.price ?? (addonKey === "setup_fee" ? 4999 : 999)));
      const qty = Math.max(1, parseInt(String(body.qty ?? "1"), 10) || 1);
      const oneOff = addonKey === "setup_fee";
      const addon = await db.subscriptionAddon.create({
        data: { propertyId: sub.propertyId, addonKey, label: String(body.label ?? labels[addonKey] ?? addonKey), qty, price, oneOff },
      });
      await clearEntitlementsCache(sub.propertyId);

      // Bill one-off setup fees immediately.
      let invoiceNumber: string | null = null;
      if (oneOff) {
        const gst = await platformGstRate();
        const tax = Math.round(price * (gst / 100) * 100) / 100;
        invoiceNumber = await nextInvoiceNumber();
        const inv = await db.invoice.create({
          data: {
            number: invoiceNumber, propertyId: sub.propertyId, subscriptionId: sub.id, type: "addon",
            status: "pending", subtotal: price, taxAmount: tax,
            totalAmount: Math.round((price + tax) * 100) / 100,
            dueDate: new Date(Date.now() + 7 * 86400000),
          },
        });
        await db.invoiceItem.create({
          data: { invoiceId: inv.id, description: addon.label, qty, unitPrice: price, taxRate: gst, amount: price * qty },
        });
      }
      await audit(`Add-on added: ${addon.label}`);
      return NextResponse.json({ ok: true, addon, invoiceNumber });
    }

    case "remove_addon": {
      const addonId = String(body.addonId ?? "");
      const addon = await db.subscriptionAddon.findFirst({ where: { id: addonId, propertyId: sub.propertyId } });
      if (!addon) return NextResponse.json({ error: "Add-on not found" }, { status: 404 });
      await db.subscriptionAddon.update({ where: { id: addonId }, data: { active: false } });
      await clearEntitlementsCache(sub.propertyId);
      await audit(`Add-on removed: ${addon.label}`);
      return NextResponse.json({ ok: true });
    }

    case "set_override": {
      const featureKey = String(body.featureKey ?? "").trim();
      if (!featureKey) return NextResponse.json({ error: "featureKey is required" }, { status: 400 });
      const enabled = body.enabled === undefined || body.enabled === null ? null : Boolean(body.enabled);
      const limitValue = body.limitValue === undefined || body.limitValue === null || String(body.limitValue) === ""
        ? null
        : parseInt(String(body.limitValue), 10);
      await db.featureOverride.upsert({
        where: { propertyId_featureKey: { propertyId: sub.propertyId, featureKey } },
        create: { propertyId: sub.propertyId, featureKey, enabled, limitValue, note: String(body.note ?? "") },
        update: { enabled, limitValue, note: String(body.note ?? "") },
      });
      await clearEntitlementsCache(sub.propertyId);
      await audit(`Override set: ${featureKey}${enabled !== null ? ` enabled=${enabled}` : ""}${limitValue !== null ? ` limit=${limitValue}` : ""}`);
      return NextResponse.json({ ok: true });
    }

    case "remove_override": {
      const featureKey = String(body.featureKey ?? "");
      await db.featureOverride.deleteMany({ where: { propertyId: sub.propertyId, featureKey } });
      await clearEntitlementsCache(sub.propertyId);
      await audit(`Override removed: ${featureKey}`);
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  }
}
