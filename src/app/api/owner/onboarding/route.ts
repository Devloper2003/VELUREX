import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { PLAN_CORE_SELECT } from "@/lib/plan-safe";
import { logPlatformAction } from "@/lib/platform";
import { demoScope, notDemoPlatform, notDemoTenantId } from "@/lib/owner-demo";

/**
 * GET /api/owner/onboarding — leads pipeline + per-tenant checklists + stuck list.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const [leads, businesses] = await Promise.all([
    db.lead.findMany({ where: notDemoPlatform(scope), orderBy: { updatedAt: "desc" } }),
    db.property.findMany({
      where: { deletedAt: null, ...notDemoTenantId(scope) },
      include: { subscription: { include: { plan: { select: PLAN_CORE_SELECT } } }, checklist: true },
    }),
  ]);

  const now = Date.now();
  const checklists = businesses.map((p) => {
    const c = p.checklist;
    const done = [c?.roomsAdded, c?.staffCreated, c?.otaConnected, c?.firstBooking, c?.whatsappConnected].filter(Boolean).length;
    const trialAgeDays = p.trialEndsAt
      ? Math.max(0, 14 - Math.ceil((p.trialEndsAt.getTime() - now) / 86400000))
      : null;
    const startedAt = p.subscription?.startedAt;
    const stuckDays = startedAt && done < 5
      ? Math.floor((now - startedAt.getTime()) / 86400000)
      : 0;
    return {
      propertyId: p.id,
      name: p.name,
      status: p.subscriptionStatus,
      plan: p.subscription?.plan.name ?? "—",
      startedAt,
      steps: {
        roomsAdded: c?.roomsAdded ?? false,
        staffCreated: c?.staffCreated ?? false,
        otaConnected: c?.otaConnected ?? false,
        firstBooking: c?.firstBooking ?? false,
        credentialsSent: c?.credentialsSent ?? false,
        whatsappConnected: c?.whatsappConnected ?? false,
      },
      completion: Math.round((done / 5) * 100),
      stuck: stuckDays >= 7,
      stuckDays,
      trialAgeDays,
    };
  });

  return NextResponse.json({
    leads,
    checklists: checklists.sort((a, b) => b.stuckDays - a.stuckDays),
    stuckCount: checklists.filter((c) => c.stuck).length,
  });
}

/** POST /api/owner/onboarding — add a lead. */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => ({}));
  const businessName = String(body.businessName ?? "").trim();
  const contactName = String(body.contactName ?? "").trim();
  if (!businessName || !contactName)
    return NextResponse.json({ error: "businessName and contactName are required" }, { status: 400 });

  const lead = await db.lead.create({
    data: {
      businessName,
      contactName,
      email: String(body.email ?? ""),
      phone: String(body.phone ?? ""),
      city: String(body.city ?? ""),
      status: ["demo_requested", "demo_done", "trial_started", "converted", "lost"].includes(String(body.status))
        ? String(body.status) : "demo_requested",
      notes: String(body.notes ?? ""),
    },
  });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "LEAD_CREATED",
    entity: "lead", entityId: lead.id, details: `${businessName} (${contactName})`,
  });
  return NextResponse.json({ ok: true, id: lead.id }, { status: 201 });
}

/** PATCH /api/owner/onboarding — move lead through the pipeline. */
export async function PATCH(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? "");
  const status = String(body.status ?? "");
  const lead = await db.lead.findUnique({ where: { id } });
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  if (!["demo_requested", "demo_done", "trial_started", "converted", "lost"].includes(status))
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });

  // "converted" requires linking to an onboarded business (matched by name or explicit propertyId).
  let propertyId: string | null = lead.propertyId;
  if (status === "converted") {
    const explicit = String(body.propertyId ?? "");
    if (explicit) propertyId = explicit;
    else {
      const match = await db.property.findFirst({
        where: { name: { contains: lead.businessName.split(" ")[0], mode: "insensitive" }, deletedAt: null },
        select: { id: true },
      });
      propertyId = match?.id ?? null;
    }
    if (propertyId) {
      const sub = await db.subscription.findUnique({ where: { propertyId } });
      if (sub) {
        await db.subscription.update({ where: { id: sub.id }, data: { status: "active" } });
        await db.property.update({
          where: { id: propertyId },
          data: { subscriptionStatus: "active", currentPlanId: sub.planId },
        });
      }
    }
  }

  await db.lead.update({ where: { id }, data: { status, propertyId, notes: body.notes !== undefined ? String(body.notes) : undefined } });
  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "LEAD_MOVED",
    entity: "lead", entityId: id, details: `${lead.businessName}: ${lead.status} → ${status}`,
  });
  return NextResponse.json({ ok: true });
}
