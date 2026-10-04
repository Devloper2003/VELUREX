import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import {
  WA_PLACEHOLDERS,
  WA_TEMPLATE_KEYS,
  getWhatsAppSettings,
  type WaTemplateName,
} from "@/lib/whatsapp";

/**
 * GET /api/whatsapp/templates — lifecycle template customization + automation
 * switches for the WhatsApp tab: each template's stored body ("" = default),
 * its placeholder list and a rendered sample, plus the auto-send switches.
 */
export async function GET(req: Request) {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const settings = await getWhatsAppSettings(propertyId);
  const propertyName = (await db.property.findUnique({ where: { id: propertyId }, select: { name: true } }))?.name ?? "Your Hotel";
  const tomorrow = new Date(Date.now() + 86400000);

  const samples: Record<WaTemplateName, Record<string, string | number>> = {
    booking_confirmation: {
      hotel: propertyName, guest: "Rahul Sharma", confirmation: "VX-24816",
      room: "Deluxe Room", checkin: tomorrow.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
      nights: 2, amount: "₹8,500",
    },
    pre_arrival: {
      hotel: propertyName, guest: "Rahul Sharma", confirmation: "VX-24816",
      checkin: tomorrow.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
    },
    post_stay: { hotel: propertyName, guest: "Rahul Sharma" },
  };

  const templates = WA_TEMPLATE_KEYS.map((name) => {
    const stored = (settings.templates[name] ?? "").trim();
    const body = stored || null; // null → built-in default in use
    const preview = body
      ? body.replace(/\{(\w+)\}/g, (m: string, key: string) =>
          key in samples[name] ? String(samples[name][key]) : m
        )
      : null;
    return {
      name,
      body,
      custom: Boolean(stored),
      placeholders: WA_PLACEHOLDERS[name],
      sample: preview,
      auto: settings.automation[name],
    };
  });

  return NextResponse.json({ templates });
}

/**
 * PATCH /api/whatsapp/templates — update one template at a time:
 *   { templateName, body }   → store/clear a custom copy ("" clears → default)
 *   { templateName, auto }   → flip the automatic-send switch
 * hotel_admin only — messaging copy and automation are owner-level settings.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const payload = (await req.json().catch(() => null)) as
    | { templateName?: string; body?: string; auto?: boolean }
    | null;
  const templateName = payload?.templateName;
  if (!templateName || !WA_TEMPLATE_KEYS.includes(templateName as WaTemplateName)) {
    return NextResponse.json(
      { error: `templateName must be one of: ${WA_TEMPLATE_KEYS.join(", ")}` },
      { status: 400 }
    );
  }
  if (payload?.body !== undefined && typeof payload.body !== "string") {
    return NextResponse.json({ error: "body must be a string" }, { status: 400 });
  }
  if (payload?.body && payload.body.length > 1000) {
    return NextResponse.json({ error: "Template body is too long (max 1000 characters)" }, { status: 400 });
  }
  if (payload?.auto !== undefined && typeof payload.auto !== "boolean") {
    return NextResponse.json({ error: "auto must be a boolean" }, { status: 400 });
  }

  const current = await getWhatsAppSettings(propertyId);
  const key = templateName as WaTemplateName;

  const templatesJson: Record<string, string> = { ...current.templates };
  if (payload?.body !== undefined) {
    if (payload.body.trim().length === 0) delete templatesJson[key];
    else templatesJson[key] = payload.body.slice(0, 1000);
  }

  const automationJson: Record<string, boolean> = { ...current.automation };
  if (payload?.auto !== undefined) automationJson[key] = payload.auto;

  const saved = await db.whatsAppConfig.upsert({
    where: { propertyId },
    create: {
      propertyId,
      templatesJson: JSON.stringify(templatesJson),
      automationJson: JSON.stringify(automationJson),
    },
    update: {
      templatesJson: JSON.stringify(templatesJson),
      automationJson: JSON.stringify(automationJson),
    },
  });

  await logActivity({
    propertyId,
    staffName: auth.session.name,
    action: "WHATSAPP_TEMPLATES_UPDATE",
    entity: "WhatsAppConfig",
    entityId: saved.id,
    details: `WhatsApp template "${key}" updated — ${payload?.body !== undefined ? (payload.body.trim() ? "custom copy saved" : "reset to default") : `auto ${automationJson[key] ? "on" : "off"}`}`,
  });

  return NextResponse.json({ ok: true, template: key, custom: Boolean(templatesJson[key]), auto: automationJson[key] });
}
