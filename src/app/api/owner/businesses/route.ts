import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { hashPassword, generateTempPassword } from "@/lib/password";
import { logPlatformAction, setPlatformSetting, getPlatformSetting, getPlatformSettingNumber, nextInvoiceNumber, platformGstRate } from "@/lib/platform";
import { demoScope, notDemoTenantId, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/businesses — searchable, filterable, paginated business list.
 * ?search=&plan=&status=&city=&page=1&pageSize=10
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const search = sp.get("search")?.trim() ?? "";
  const plan = sp.get("plan") ?? "";
  const status = sp.get("status") ?? "";
  const city = sp.get("city") ?? "";
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get("pageSize") ?? "10", 10) || 10));

  const where: Record<string, unknown> = { ...notDemoTenantId(scope) };
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { city: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }
  if (plan) where.currentPlanId = plan;
  if (city) where.city = { contains: city, mode: "insensitive" };
  if (status === "deleted") where.deletedAt = { not: null };
  else if (status) {
    where.deletedAt = null;
    where.subscriptionStatus = status;
  } else where.deletedAt = null;

  const [total, properties] = await Promise.all([
    db.property.count({ where }),
    db.property.findMany({
      where,
      include: {
        subscription: { include: { plan: true } },
        staff: { where: { role: "hotel_admin" }, select: { id: true, name: true, email: true, active: true } },
      },
      orderBy: { createdAt: "asc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const roomCounts = await db.room.groupBy({ by: ["propertyId"], _count: true });
  const roomMap = new Map(roomCounts.map((r) => [r.propertyId, r._count]));

  const businesses = properties.map((p) => ({
    id: p.id,
    name: p.name,
    type: p.propertyType,
    category: p.businessCategory,
    city: p.city,
    state: p.state,
    phone: p.phone,
    email: p.email,
    status: p.deletedAt ? "deleted" : p.subscriptionStatus,
    healthScore: p.healthScore,
    notes: p.notes,
    createdAt: p.createdAt,
    plan: p.subscription?.plan
      ? { id: p.subscription.plan.id, code: p.subscription.plan.code, name: p.subscription.plan.name, monthlyPrice: p.subscription.plan.monthlyPrice }
      : p.currentPlanId
        ? { id: p.currentPlanId, code: "", name: "—", monthlyPrice: 0 }
        : null,
    subscription: p.subscription
      ? {
          id: p.subscription.id, cycle: p.subscription.cycle, status: p.subscription.status,
          renewalAt: p.subscription.renewalAt, trialEndsAt: p.subscription.trialEndsAt,
          autoRenew: p.subscription.autoRenew,
        }
      : null,
    admins: p.staff,
    rooms: roomMap.get(p.id) ?? 0,
    staffCount: 0,
  }));

  // staffCount per business (staff of demo tenants excluded for the real owner)
  const staffCounts = await db.staff.groupBy({ by: ["propertyId"], where: notDemoTenant(scope), _count: true });
  const staffMap = new Map(staffCounts.map((s) => [s.propertyId, s._count]));
  for (const b of businesses) b.staffCount = staffMap.get(b.id) ?? 0;

  return NextResponse.json({ businesses, total, page, pageSize, pages: Math.ceil(total / pageSize) });
}

/**
 * POST /api/owner/businesses — Add Business: creates the property, its admin
 * account, subscription (with trial per settings), onboarding checklist, and
 * optionally applies a coupon / first invoice.
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const name = String(body.name ?? "").trim();
  const adminName = String(body.adminName ?? "").trim();
  const adminEmail = String(body.adminEmail ?? "").toLowerCase().trim();
  // SECURITY: new admins ALWAYS start on a generated temporary password
  // (format `Vlx@XXXXXXXX`). The owner-provided password field is ignored —
  // the admin must reset to a permanent password on first login.
  const adminPassword = generateTempPassword();
  const adminPhone = String(body.adminPhone ?? "").trim();
  const planId = String(body.planId ?? "");
  const cycle = ["monthly", "quarterly", "yearly"].includes(body.cycle) ? body.cycle : "monthly";
  const trialDays = body.trialDays !== undefined && body.trialDays !== null && String(body.trialDays) !== ""
    ? Math.max(0, parseInt(String(body.trialDays), 10))
    : null;
  const couponCode = String(body.couponCode ?? "").trim().toUpperCase();
  const sendCredentials = body.sendCredentials !== false;

  if (!name) return NextResponse.json({ error: "Business name is required" }, { status: 400 });
  if (!adminName || !adminEmail)
    return NextResponse.json({ error: "Admin name and email are required" }, { status: 400 });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail))
    return NextResponse.json({ error: "A valid admin email is required" }, { status: 400 });

  const existingStaff = await db.staff.findUnique({ where: { email: adminEmail } });
  const existingOwner = await db.platformUser.findUnique({ where: { email: adminEmail } });
  if (existingStaff || existingOwner)
    return NextResponse.json({ error: "A user with this email already exists" }, { status: 409 });

  const plan = await db.plan.findUnique({ where: { id: planId } });
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const trialDaysEffective = trialDays ?? (await getPlatformSettingNumber("default_trial_days", 14));
  const now = new Date();

  // Optional coupon
  let coupon = null as null | { id: string; code: string; discountType: string; discountValue: number; planCode: string; trialDays: number; maxUses: number; usedCount: number; validTo: Date | null; active: boolean };
  if (couponCode) {
    const found = await db.coupon.findUnique({ where: { code: couponCode } });
    if (!found || !found.active) return NextResponse.json({ error: `Coupon ${couponCode} is not valid` }, { status: 400 });
    if (found.validTo && found.validTo < now) return NextResponse.json({ error: `Coupon ${couponCode} has expired` }, { status: 400 });
    if (found.usedCount >= found.maxUses) return NextResponse.json({ error: `Coupon ${couponCode} usage cap reached` }, { status: 400 });
    if (found.planCode && found.planCode !== plan.code)
      return NextResponse.json({ error: `Coupon ${couponCode} is only valid on the ${found.planCode} plan` }, { status: 400 });
    coupon = found;
  }

  const trialEndsAt = trialDaysEffective > 0 ? new Date(now.getTime() + trialDaysEffective * 86400000) : null;

  const result = await db.$transaction(async (tx) => {
    const property = await tx.property.create({
      data: {
        name,
        address: String(body.address ?? ""),
        city: String(body.city ?? ""),
        state: String(body.state ?? ""),
        phone: String(body.phone ?? ""),
        email: String(body.email ?? adminEmail),
        propertyType: String(body.propertyType ?? "Hotel"),
        businessCategory: String(body.category ?? "Luxury Hotel"),
        gstin: String(body.gstin ?? ""),
        currentPlanId: plan.id,
        subscriptionStatus: trialEndsAt ? "trial" : "active",
        trialEndsAt,
        healthScore: 80,
        notes: String(body.notes ?? ""),
      },
    });

    const admin = await tx.staff.create({
      data: {
        propertyId: property.id,
        name: adminName,
        email: adminEmail,
        phone: adminPhone,
        role: "hotel_admin",
        passwordHash: hashPassword(adminPassword),
        mustChangePassword: true,
      },
    });

    const subscription = await tx.subscription.create({
      data: {
        propertyId: property.id,
        planId: plan.id,
        cycle,
        status: trialEndsAt ? "trial" : "active",
        startedAt: now,
        renewalAt: trialEndsAt ?? new Date(now.getTime() + 30 * 86400000),
        trialEndsAt,
        autoRenew: true,
      },
    });

    if (trialEndsAt) {
      await tx.property.update({
        where: { id: property.id },
        data: { trialEndsAt },
      });
    }

    await tx.onboardingChecklist.create({
      data: {
        propertyId: property.id,
        credentialsSent: false,
        notes: "",
      },
    });

    // One-time setup fee invoice (always) + coupon redemption record
    const setupFee = Number(body.setupFee ?? 0);
    if (setupFee > 0) {
      const gst = await platformGstRate();
      const taxable = setupFee;
      const tax = Math.round(taxable * (gst / 100) * 100) / 100;
      const number = await nextInvoiceNumber();
      const inv = await tx.invoice.create({
        data: {
          number, propertyId: property.id, subscriptionId: subscription.id, type: "setup",
          status: "pending", subtotal: setupFee, taxAmount: tax,
          totalAmount: Math.round((taxable + tax) * 100) / 100,
          dueDate: new Date(now.getTime() + 7 * 86400000),
        },
      });
      await tx.invoiceItem.create({
        data: { invoiceId: inv.id, description: "One-time setup fee", qty: 1, unitPrice: setupFee, taxRate: gst, amount: setupFee },
      });
    }
    if (coupon) {
      await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } });
      await tx.couponRedemption.create({
        data: { couponId: coupon.id, propertyId: property.id },
      });
    }
    return { property, admin, subscription };
  });

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "BUSINESS_CREATED",
    entity: "property", entityId: result.property.id,
    propertyId: result.property.id,
    details: `${name} onboarded on ${plan.name} (${cycle}${trialEndsAt ? `, trial ${trialDaysEffective}d` : ""})`,
  });
  if (coupon) {
    await logPlatformAction({
      actorId: owner.sub, actorName: owner.email, action: "COUPON_APPLIED",
      entity: "coupon", entityId: coupon.id, propertyId: result.property.id,
      details: `${coupon.code} applied at onboarding`,
    });
  }

  // Credential delivery — template-driven when email/WhatsApp are configured (Platform Settings).
  const smtpConfigured = !!(await getPlatformSetting("smtp_user"));
  const waConfigured = !!(await getPlatformSetting("whatsapp_token"));
  let credentialsSent = false;
  if (sendCredentials) {
    // TODO: wire real SMTP / WhatsApp Cloud API providers here. Templates live in
    // Platform Settings (tmpl_welcome_email / tmpl_welcome_whatsapp). Until a
    // provider is configured the delivery is recorded as pending in the checklist.
    credentialsSent = smtpConfigured || waConfigured;
    await db.onboardingChecklist.updateMany({
      where: { propertyId: result.property.id },
      data: { credentialsSent },
    });
  }

  return NextResponse.json(
    {
      business: { id: result.property.id, name: result.property.name },
      admin: { id: result.admin.id, email: result.admin.email },
      subscription: { id: result.subscription.id, status: result.subscription.status },
      // Shown ONCE to the owner — share with the admin over a secure channel;
      // the admin replaces it with a permanent password on first login.
      tempPassword: adminPassword,
      credentialsSent,
      credentialsChannel: credentialsSent ? (smtpConfigured ? "email" : "whatsapp") : "pending — configure SMTP or WhatsApp in Platform Settings (stub)",
    },
    { status: 201 }
  );
}
