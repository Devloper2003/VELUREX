import { db } from "@/lib/db";
import { startOfDay, endOfDay } from "@/lib/business";
import { decryptJSON } from "@/lib/crypto";

/**
 * WhatsApp Business API integration.
 * Credentials resolve per tenant: when a property has connected its own
 * WhatsApp Cloud API (Settings → WhatsApp API), messages use those encrypted
 * credentials; otherwise they fall back to the platform-wide env config, and
 * when neither exists messages are logged with status "mock" (simulated) so
 * the whole flow remains testable in development.
 */

interface SendArgs {
  propertyId: string;
  toPhone: string;
  templateName: string;
  body: string;
  reservationId?: string | null;
}

export interface WhatsAppCreds {
  accessToken: string;
  phoneNumberId: string;
  source: "tenant" | "platform";
}

/**
 * Resolve the WhatsApp Cloud API credentials for a property.
 * 1. Tenant-owned config (Settings → WhatsApp API), only when status is "connected".
 * 2. Platform-wide config — owner-configured (Platform Settings → WhatsApp API,
 *    stored encrypted) first, then the WHATSAPP_TOKEN + WHATSAPP_PHONE_ID env
 *    bootstrap fallback.
 * Returns null when neither is configured → caller logs a "mock" message.
 */
export async function getWhatsAppCreds(propertyId: string): Promise<WhatsAppCreds | null> {
  const cfg = await db.whatsAppConfig.findUnique({ where: { propertyId } });
  if (cfg && cfg.status === "connected" && cfg.phoneNumberId && cfg.accessTokenEnc) {
    const secret = decryptJSON<{ token?: string }>(cfg.accessTokenEnc);
    if (secret.token) {
      return { accessToken: secret.token, phoneNumberId: cfg.phoneNumberId, source: "tenant" };
    }
  }
  const { getPlatformSetting } = await import("@/lib/platform");
  const [dbToken, dbPhoneId] = await Promise.all([
    getPlatformSetting("whatsapp_token"),
    getPlatformSetting("whatsapp_phone_id"),
  ]);
  if (dbToken && dbPhoneId) {
    return { accessToken: dbToken, phoneNumberId: dbPhoneId, source: "platform" };
  }
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  if (token && phoneId) return { accessToken: token, phoneNumberId: phoneId, source: "platform" };
  return null;
}

/** Send via Meta Cloud API with the given credentials. Returns provider status + id. */
export async function sendViaCloudApi(
  creds: WhatsAppCreds,
  toPhone: string,
  body: string
): Promise<{ status: "sent" | "failed"; providerId: string }> {
  try {
    const res = await fetch(`https://graph.facebook.com/v18.0/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhone.replace(/\s|\+/g, ""),
        type: "text",
        text: { body },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (res.ok) {
      return { status: "sent", providerId: data?.messages?.[0]?.id || "" };
    }
    return { status: "failed", providerId: "" };
  } catch {
    return { status: "failed", providerId: "" };
  }
}

/**
 * Upload a PNG/JPEG to the Meta Cloud API media endpoint and send it as an
 * image message with a caption. Returns "sent"/"failed" + provider message id.
 * A failed media upload or send is always a clean "failed" — callers fall back
 * to the plain-text send.
 */
export async function sendViaCloudApiImage(
  creds: WhatsAppCreds,
  toPhone: string,
  image: Buffer,
  caption: string
): Promise<{ status: "sent" | "failed"; providerId: string }> {
  try {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("file", new Blob([new Uint8Array(image)], { type: "image/png" }), "kot.png");
    const upRes = await fetch(`https://graph.facebook.com/v18.0/${creds.phoneNumberId}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const upData = (await upRes.json().catch(() => ({}))) as { id?: string };
    const mediaId = upData.id;
    if (!upRes.ok || !mediaId) return { status: "failed", providerId: "" };

    const res = await fetch(`https://graph.facebook.com/v18.0/${creds.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toPhone.replace(/\s|\+/g, ""),
        type: "image",
        image: { id: mediaId, caption: caption.slice(0, 1024) },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    if (res.ok) {
      return { status: "sent", providerId: data?.messages?.[0]?.id || "" };
    }
    return { status: "failed", providerId: "" };
  } catch {
    return { status: "failed", providerId: "" };
  }
}

export async function sendWhatsApp({ propertyId, toPhone, templateName, body, reservationId }: SendArgs) {
  const creds = await getWhatsAppCreds(propertyId);

  let status: "mock" | "sent" | "failed" = "mock";
  let providerId = "";

  if (creds) {
    const result = await sendViaCloudApi(creds, toPhone, body);
    status = result.status;
    providerId = result.providerId;
  }

  return db.whatsAppMessage.create({
    data: {
      propertyId,
      toPhone,
      templateName,
      body,
      status,
      providerId,
      reservationId: reservationId || null,
      sentAt: status === "sent" || status === "mock" ? new Date() : null,
    },
  });
}

// ── Template customization & automation switches ─────────────────────────
// Tenants can override the copy of the three lifecycle templates and pause
// each automatic flow. Stored on WhatsAppConfig as JSON; missing keys fall
// back to the built-in defaults below, so existing tenants keep their exact
// behavior until they change something.

export const WA_TEMPLATE_KEYS = ["booking_confirmation", "pre_arrival", "post_stay"] as const;
export type WaTemplateName = (typeof WA_TEMPLATE_KEYS)[number];

export const WA_PLACEHOLDERS: Record<WaTemplateName, string[]> = {
  booking_confirmation: ["{hotel}", "{guest}", "{confirmation}", "{room}", "{checkin}", "{nights}", "{amount}"],
  pre_arrival: ["{hotel}", "{guest}", "{confirmation}", "{checkin}"],
  post_stay: ["{hotel}", "{guest}"],
};

export interface WaSettings {
  templates: Partial<Record<WaTemplateName, string>>; // stored overrides ("" = use default)
  automation: Record<WaTemplateName, boolean>; // missing keys default to true
}

export const WA_AUTOMATION_DEFAULT: Record<WaTemplateName, boolean> = {
  booking_confirmation: true,
  pre_arrival: true,
  post_stay: true,
};

/** Load a property's template overrides + automation switches (defaults when no config row). */
export async function getWhatsAppSettings(propertyId: string): Promise<WaSettings> {
  const cfg = await db.whatsAppConfig.findUnique({
    where: { propertyId },
    select: { templatesJson: true, automationJson: true },
  });
  let templates: Partial<Record<WaTemplateName, string>> = {};
  let automation: Partial<Record<WaTemplateName, boolean>> = {};
  try {
    templates = JSON.parse(cfg?.templatesJson ?? "{}") as Partial<Record<WaTemplateName, string>>;
  } catch {
    /* corrupt JSON → defaults */
  }
  try {
    automation = JSON.parse(cfg?.automationJson ?? "{}") as Partial<Record<WaTemplateName, boolean>>;
  } catch {
    /* corrupt JSON → defaults */
  }
  return {
    templates: typeof templates === "object" && templates ? templates : {},
    automation: { ...WA_AUTOMATION_DEFAULT, ...(typeof automation === "object" && automation ? automation : {}) },
  };
}

/** Replace {placeholders} in a stored template body. Unknown placeholders stay untouched. */
export function renderWaTemplate(body: string, vars: Record<string, string | number>): string {
  return body.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

export interface WaTemplateVars {
  hotel: string;
  guest: string;
  confirmation?: string;
  room?: string;
  checkin?: Date;
  nights?: number;
  amount?: number;
}

function fmtDay(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

/**
 * Build the final body for a lifecycle template: the tenant's stored override
 * (placeholders rendered) when customized, otherwise the built-in default copy.
 */
export function buildTemplateBody(name: WaTemplateName, vars: WaTemplateVars, settings?: WaSettings): string {
  const stored = settings?.templates?.[name]?.trim();
  if (stored) {
    return renderWaTemplate(stored, {
      hotel: vars.hotel,
      guest: vars.guest,
      confirmation: vars.confirmation ?? "",
      room: vars.room ?? "",
      checkin: vars.checkin ? fmtDay(vars.checkin) : "",
      nights: vars.nights ?? "",
      amount: vars.amount !== undefined ? `₹${Math.round(vars.amount).toLocaleString("en-IN")}` : "",
    });
  }
  if (name === "booking_confirmation") {
    return bookingConfirmationMsg(vars.hotel, vars.guest, vars.confirmation ?? "", vars.checkin ?? new Date(), vars.room ?? "", vars.nights ?? 1, vars.amount ?? 0);
  }
  if (name === "pre_arrival") {
    return preArrivalMsg(vars.hotel, vars.guest, vars.confirmation ?? "", vars.checkin ?? new Date());
  }
  return postStayMsg(vars.hotel, vars.guest);
}

export function bookingConfirmationMsg(hotelName: string, guestName: string, conf: string, checkIn: Date, roomName: string, nights: number, total: number) {
  return `Hi ${guestName.split(" ")[0]}! Your booking ${conf} at ${hotelName} is confirmed. 🏨\nRoom: ${roomName}\nCheck-in: ${checkIn.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })} (2 PM onwards) · ${nights} night(s)\nAmount: ₹${Math.round(total).toLocaleString("en-IN")}\nWe look forward to hosting you!`;
}

export function preArrivalMsg(hotelName: string, guestName: string, conf: string, checkIn: Date) {
  return `Hi ${guestName.split(" ")[0]}, we look forward to welcoming you to ${hotelName} tomorrow! Your booking ${conf} — check-in from 2 PM. Need an airport pickup or early check-in? Just reply here.`;
}

export function postStayMsg(hotelName: string, guestName: string) {
  return `Thank you for staying with us at ${hotelName}, ${guestName.split(" ")[0]}! We'd love your feedback — rate your stay 1-5 by replying to this message. Hope to see you again soon! ✨`;
}

/**
 * Idempotent pre-arrival campaign runner: finds confirmed arrivals on the
 * given day (default: tomorrow) that have a phone number and have NOT already
 * received a pre_arrival message, sends each one, and returns the tally.
 * Used both by the manual bulk trigger (source "manual") and by the
 * night-audit auto-trigger (source "auto" — honours the tenant's automation
 * switch; when it is off the campaign is skipped entirely).
 */
export async function runPreArrivalCampaign(
  propertyId: string,
  forDay?: Date,
  opts?: { source?: "manual" | "auto" }
) {
  const settings = await getWhatsAppSettings(propertyId);
  if (opts?.source === "auto" && !settings.automation.pre_arrival) {
    return { sent: 0, eligible: 0, skippedNoPhone: 0, skippedAlreadyMessaged: 0, skippedAutomation: 1 };
  }

  const property = await db.property.findUnique({ where: { id: propertyId }, select: { name: true } });
  if (!property) return { sent: 0, eligible: 0, skippedNoPhone: 0, skippedAlreadyMessaged: 0, skippedAutomation: 0 };

  const target = forDay ?? startOfDay(new Date(Date.now() + 86400000));
  const dayStart = startOfDay(target);
  const dayEnd = endOfDay(target);

  const reservations = await db.reservation.findMany({
    where: { propertyId, status: "confirmed", checkIn: { gte: dayStart, lte: dayEnd } },
    include: { guest: { select: { fullName: true, phone: true } } },
    orderBy: { checkIn: "asc" },
  });

  const ids = reservations.map((r) => r.id);
  const already = ids.length
    ? await db.whatsAppMessage.findMany({
        where: { propertyId, templateName: "pre_arrival", reservationId: { in: ids } },
        select: { reservationId: true },
      })
    : [];
  const messaged = new Set(already.map((m) => m.reservationId));

  const eligible = reservations.filter((r) => r.guest.phone.trim().length > 0 && !messaged.has(r.id));
  let sent = 0;
  for (const reservation of eligible) {
    const message = await sendWhatsApp({
      propertyId,
      toPhone: reservation.guest.phone,
      templateName: "pre_arrival",
      body: buildTemplateBody(
        "pre_arrival",
        {
          hotel: property.name,
          guest: reservation.guest.fullName,
          confirmation: reservation.confirmationNumber,
          checkin: reservation.checkIn,
        },
        settings
      ),
      reservationId: reservation.id,
    });
    if (message.status !== "failed") sent++;
  }

  return {
    sent,
    eligible: eligible.length,
    skippedNoPhone: reservations.filter((r) => r.guest.phone.trim().length === 0).length,
    skippedAlreadyMessaged: reservations.length - eligible.length - reservations.filter((r) => r.guest.phone.trim().length === 0).length,
    skippedAutomation: 0,
  };
}
