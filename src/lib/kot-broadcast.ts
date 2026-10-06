import { db } from "@/lib/db";
import { getWhatsAppCreds, sendViaCloudApi, sendViaCloudApiImage } from "@/lib/whatsapp";

/**
 * KOT WhatsApp broadcast — when a new order (KOT) is generated in the
 * Restaurant POS, the ticket is pushed to the property owner(s) and a
 * tenant-configured group of phone numbers over WhatsApp.
 *
 * The ticket is rendered as a branded receipt IMAGE (SVG → PNG via sharp);
 * if image delivery fails the plain-text version is sent instead, and when
 * no WhatsApp credentials exist everything is logged as "mock" so the flow
 * stays fully testable without a live provider.
 *
 * Config lives inside WhatsAppConfig.automationJson under the "kot_broadcast"
 * key — zero schema change, round-trips safely with the template switches.
 */

// ── Config ───────────────────────────────────────────────────────────────────

export interface KotBroadcastConfig {
  enabled: boolean;
  format: "image" | "text";
  phones: string[]; // group recipients beyond the property owner(s)
}

export const KOT_BROADCAST_DEFAULT: KotBroadcastConfig = {
  enabled: true,
  format: "image",
  phones: [],
};

const MAX_GROUP_PHONES = 12;

export async function getKotBroadcastConfig(propertyId: string): Promise<KotBroadcastConfig> {
  const cfg = await db.whatsAppConfig.findUnique({
    where: { propertyId },
    select: { automationJson: true },
  });
  let raw: unknown = {};
  try {
    raw = JSON.parse(cfg?.automationJson ?? "{}");
  } catch {
    /* corrupt JSON → defaults */
  }
  const kb = (raw as Record<string, unknown>)?.kot_broadcast;
  if (!kb || typeof kb !== "object") return { ...KOT_BROADCAST_DEFAULT, phones: [] };
  const o = kb as Record<string, unknown>;
  return {
    enabled: o.enabled === undefined ? KOT_BROADCAST_DEFAULT.enabled : Boolean(o.enabled),
    format: o.format === "text" ? "text" : "image",
    phones: Array.isArray(o.phones)
      ? o.phones
          .filter((p): p is string => typeof p === "string")
          .map((p) => p.trim())
          .filter(Boolean)
          .slice(0, MAX_GROUP_PHONES)
      : [],
  };
}

/** Read-modify-write of the automationJson blob, preserving template switches. */
export async function saveKotBroadcastConfig(
  propertyId: string,
  patch: Partial<KotBroadcastConfig>
): Promise<KotBroadcastConfig> {
  const current = await getKotBroadcastConfig(propertyId);
  const next: KotBroadcastConfig = {
    enabled: patch.enabled ?? current.enabled,
    format: patch.format === "text" || patch.format === "image" ? patch.format : current.format,
    phones: (patch.phones ?? current.phones)
      .map((p) => String(p).trim())
      .filter(Boolean)
      .slice(0, MAX_GROUP_PHONES),
  };
  const cfg = await db.whatsAppConfig.findUnique({
    where: { propertyId },
    select: { automationJson: true },
  });
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(cfg?.automationJson ?? "{}") as Record<string, unknown>;
  } catch {
    /* start fresh */
  }
  obj.kot_broadcast = next;
  await db.whatsAppConfig.upsert({
    where: { propertyId },
    update: { automationJson: JSON.stringify(obj) },
    create: { propertyId, automationJson: JSON.stringify(obj) },
  });
  return next;
}

// ── Recipients ───────────────────────────────────────────────────────────────

/** Owner(s) = active hotel_admin accounts with a phone number, plus the configured group list. */
export async function resolveKotRecipients(propertyId: string, groupPhones: string[]): Promise<string[]> {
  const owners = await db.staff.findMany({
    where: { propertyId, role: "hotel_admin", active: true, phone: { not: "" } },
    select: { phone: true },
  });
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [...owners.map((o) => o.phone), ...groupPhones]) {
    const phone = String(raw).trim();
    const digits = phone.replace(/[^0-9]/g, "");
    if (!phone || !digits || seen.has(digits)) continue;
    seen.add(digits);
    out.push(phone);
    if (out.length >= 10) break; // hard cap — a KOT is not a marketing channel
  }
  return out;
}

// ── Content builders ─────────────────────────────────────────────────────────

export interface KotBroadcastOrder {
  orderNumber: string;
  orderType: string;
  tableNumber: string;
  roomNumber: string;
  createdAt: Date | string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  items: { name: string; qty: number; notes: string }[];
}

function whereOf(o: KotBroadcastOrder): string {
  if (o.orderType === "room_service") return `Room ${o.roomNumber || "—"}`;
  if (o.orderType === "takeaway") return "Takeaway";
  return `Table ${o.tableNumber || "—"}`;
}

function typeOf(o: KotBroadcastOrder): string {
  if (o.orderType === "room_service") return "Room Service";
  if (o.orderType === "takeaway") return "Takeaway";
  return "Dine-in";
}

function itemCount(o: KotBroadcastOrder): number {
  return o.items.reduce((s, i) => s + i.qty, 0);
}

function inr(n: number): string {
  return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** WhatsApp markdown text version of the ticket. */
export function buildKotText(o: KotBroadcastOrder, propertyName: string): string {
  const dt = new Date(o.createdAt);
  const time = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const date = dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const lines: string[] = [
    `🍳 *KOT ${o.orderNumber}* — new order received`,
    `*${propertyName}*`,
    `📍 ${whereOf(o)} · ${typeOf(o)}`,
    `🕒 ${time} · ${date}`,
    "──────────────",
  ];
  for (const i of o.items) {
    lines.push(`• *${i.qty}×* ${i.name}`);
    if (i.notes) lines.push(`   ↳ _${i.notes}_`);
  }
  lines.push("──────────────");
  lines.push(`Items: ${itemCount(o)} · Subtotal ${inr(o.subtotal)} · GST ${inr(o.taxAmount)}`);
  lines.push(`*Total ${inr(o.totalAmount)}* incl. GST`);
  return lines.join("\n");
}

/** Short caption for the image message (≤1024 chars enforced by the sender). */
export function buildKotCaption(o: KotBroadcastOrder, propertyName: string): string {
  return `KOT ${o.orderNumber} · ${whereOf(o)} · ${itemCount(o)} items · ${inr(o.totalAmount)} — ${propertyName}`;
}

// ── Ticket image (SVG → PNG) ─────────────────────────────────────────────────

const PAGE_W = 480;
const INK = "#1A2B27";
const MUTED = "#6B7B76";
const PINE = "#0F2622";
const BRASS = "#B9873E";
const BRASS_SOFT = "#D9B779";
const PLASTER = "#EFE6D8";
const WARN = "#B45309";
const LINE = "#E2D8C6";

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Rough wrap for monospace 15px (≈9px/char) within `max` px. */
function wrapName(name: string, maxChars: number): string[] {
  const clean = name.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return [clean];
  const words = clean.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w.slice(0, maxChars);
    } else if ((cur + " " + w).length <= maxChars) {
      cur += " " + w;
    } else {
      lines.push(cur);
      cur = w.slice(0, maxChars);
    }
    if (lines.length >= 2) break; // two lines max — truncate the rest
  }
  if (lines.length < 2 && cur) lines.push(cur);
  if (lines.length === 2) {
    const consumed = lines.join(" ").length;
    if (consumed < clean.length) lines[1] = lines[1].slice(0, Math.max(0, maxChars - 1)) + "…";
  }
  return lines.slice(0, 2);
}

const MONO = "DejaVu Sans Mono, monospace";
const SANS = "DejaVu Sans, sans-serif";

/**
 * Branded KOT receipt as PNG. Pure presentation — every value comes from the
 * order row, nothing is hard-coded beyond the brand palette.
 *
 * Layout: pine header (hotel · KITCHEN ORDER TICKET · big order number, brass
 * underline rule) → plaster meta strip (where · type | time · date) → items
 * with a brass qty column and hanging cooking notes → subtotal / GST / TOTAL
 * block → brass accent bar. White-label: the property's own name only.
 */
export async function buildKotImage(o: KotBroadcastOrder, propertyName: string): Promise<Buffer> {
  const { default: sharp } = await import("sharp");

  const dt = new Date(o.createdAt);
  const time = dt.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
  const date = dt.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // Item rows: name lines (max 2) + optional note line each.
  type Row = { lines: string[]; note: string };
  const rows: Row[] = o.items.map((i) => ({
    lines: wrapName(i.name, 38),
    note: i.notes ? i.notes.slice(0, 44) : "",
  }));
  const itemsH = rows.reduce(
    (h, r) => h + r.lines.length * 22 + (r.note ? 19 : 0) + 12,
    0
  );

  const headerH = 118;
  const metaH = 38;
  const labelH = 38; // "ITEMS · N" label + gap
  const tailH = 2 + 28 + 20 + 30 + 22 + 6; // divider gap + items/subtotal + GST + TOTAL rows + bottom pad + accent bar
  const height = headerH + metaH + labelH + itemsH + tailH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${height}" viewBox="0 0 ${PAGE_W} ${height}">`
  );
  parts.push(`<rect width="${PAGE_W}" height="${height}" fill="#FFFFFF"/>`);

  // Header band + brass underline rule
  parts.push(`<rect width="${PAGE_W}" height="${headerH}" fill="${PINE}"/>`);
  parts.push(`<rect y="${headerH - 3}" width="${PAGE_W}" height="3" fill="${BRASS}"/>`);
  parts.push(
    `<text x="${PAGE_W / 2}" y="32" text-anchor="middle" font-family="${SANS}" font-size="15" font-weight="bold" fill="${BRASS_SOFT}" letter-spacing="1.5">${xmlEsc(
      propertyName.toUpperCase()
    )}</text>`
  );
  parts.push(
    `<text x="${PAGE_W / 2}" y="54" text-anchor="middle" font-family="${SANS}" font-size="9.5" fill="#8FA6A0" letter-spacing="3">KITCHEN ORDER TICKET</text>`
  );
  parts.push(
    `<text x="${PAGE_W / 2}" y="94" text-anchor="middle" font-family="${MONO}" font-size="28" font-weight="bold" fill="#FFFFFF">${xmlEsc(
      o.orderNumber
    )}</text>`
  );

  // Meta strip
  parts.push(`<rect y="${headerH}" width="${PAGE_W}" height="${metaH}" fill="${PLASTER}"/>`);
  parts.push(
    `<text x="20" y="${headerH + 24}" font-family="${SANS}" font-size="13.5" font-weight="bold" fill="${PINE}">${xmlEsc(
      `${whereOf(o)} · ${typeOf(o)}`
    )}</text>`
  );
  parts.push(
    `<text x="${PAGE_W - 20}" y="${headerH + 24}" text-anchor="end" font-family="${MONO}" font-size="12" fill="${MUTED}">${xmlEsc(
      `${time} · ${date}`
    )}</text>`
  );

  // Items
  let y = headerH + metaH + 20;
  parts.push(
    `<text x="20" y="${y - 4}" font-family="${SANS}" font-size="10" letter-spacing="2" fill="${MUTED}">ITEMS · ${itemCount(
      o
    )}</text>`
  );
  y += 18;
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    for (let li = 0; li < r.lines.length; li++) {
      if (li === 0) {
        parts.push(
          `<text x="20" y="${y}" font-family="${MONO}" font-size="16" font-weight="bold" fill="${BRASS}"><tspan x="20">${xmlEsc(
            String(o.items[ri]?.qty ?? 1)
          )}×</tspan><tspan x="64" font-weight="normal" fill="${INK}">${xmlEsc(r.lines[li])}</tspan></text>`
        );
      } else {
        parts.push(
          `<text x="64" y="${y}" font-family="${MONO}" font-size="15" fill="${INK}">${xmlEsc(r.lines[li])}</text>`
        );
      }
      y += 22;
    }
    if (r.note) {
      parts.push(
        `<text x="64" y="${y - 4}" font-family="${MONO}" font-size="12.5" font-style="italic" fill="${WARN}">» ${xmlEsc(
          r.note
        )}</text>`
      );
      y += 19;
    }
    parts.push(`<line x1="20" y1="${y - 6}" x2="${PAGE_W - 20}" y2="${y - 6}" stroke="${LINE}" stroke-width="1"/>`);
    y += 12;
  }

  // Divider + totals block
  parts.push(
    `<line x1="20" y1="${y + 2}" x2="${PAGE_W - 20}" y2="${y + 2}" stroke="${MUTED}" stroke-width="1" stroke-dasharray="5 4"/>`
  );
  const fy1 = y + 28;
  parts.push(
    `<text x="20" y="${fy1}" font-family="${SANS}" font-size="13" fill="${MUTED}">Items: ${itemCount(o)}</text>`
  );
  parts.push(
    `<text x="${PAGE_W - 20}" y="${fy1}" text-anchor="end" font-family="${SANS}" font-size="13" fill="${MUTED}">Subtotal ${xmlEsc(
      inr(o.subtotal)
    )}</text>`
  );
  const fy2 = fy1 + 20;
  parts.push(
    `<text x="${PAGE_W - 20}" y="${fy2}" text-anchor="end" font-family="${SANS}" font-size="13" fill="${MUTED}">GST ${xmlEsc(
      inr(o.taxAmount)
    )}</text>`
  );
  const fy3 = fy2 + 30;
  parts.push(
    `<text x="20" y="${fy3}" font-family="${SANS}" font-size="15" font-weight="bold" fill="${PINE}" letter-spacing="1">TOTAL</text>`
  );
  parts.push(
    `<text x="${PAGE_W - 20}" y="${fy3}" text-anchor="end" font-family="${MONO}" font-size="24" font-weight="bold" fill="${PINE}">${xmlEsc(
      inr(o.totalAmount)
    )}</text>`
  );

  // Brass accent bar (bottom edge)
  parts.push(`<rect y="${height - 6}" width="${PAGE_W}" height="6" fill="${BRASS}"/>`);
  parts.push(`</svg>`);

  return sharp(Buffer.from(parts.join("")), { density: 144 }).resize(960).png().toBuffer();
}

// ── Broadcast ────────────────────────────────────────────────────────────────

export interface KotBroadcastTally {
  recipients: number;
  sent: number;
  failed: number;
  skipped: "disabled" | "no_recipients" | "";
}

/**
 * Fire the KOT to owner(s) + group. NEVER throws — order creation must not
 * depend on WhatsApp. Every attempt is logged in WhatsAppMessage so the
 * tenant's message log stays the single source of truth.
 */
export async function broadcastKot(
  propertyId: string,
  order: KotBroadcastOrder
): Promise<KotBroadcastTally | null> {
  try {
    const cfg = await getKotBroadcastConfig(propertyId);
    if (!cfg.enabled) return { recipients: 0, sent: 0, failed: 0, skipped: "disabled" };

    const property = await db.property.findUnique({
      where: { id: propertyId },
      select: { name: true },
    });
    if (!property) return null;

    const recipients = await resolveKotRecipients(propertyId, cfg.phones);
    if (recipients.length === 0) return { recipients: 0, sent: 0, failed: 0, skipped: "no_recipients" };

    const creds = await getWhatsAppCreds(propertyId);
    const text = buildKotText(order, property.name);
    const caption = buildKotCaption(order, property.name);

    let image: Buffer | null = null;
    if (cfg.format === "image") {
      image = await buildKotImage(order, property.name).catch(() => null);
    }

    const statuses = await Promise.all(
      recipients.map(async (phone) => {
        let status: "mock" | "sent" | "failed" = "mock";
        let providerId = "";
        if (creds) {
          let ok = false;
          if (image) {
            const r = await sendViaCloudApiImage(creds, phone, image, caption);
            ok = r.status === "sent";
            providerId = r.providerId;
          }
          if (!ok) {
            // image failed/not requested → text (also the explicit fallback)
            const t = await sendViaCloudApi(creds, phone, text);
            ok = t.status === "sent";
            providerId = t.providerId;
          }
          status = ok ? "sent" : "failed";
        }
        await db.whatsAppMessage.create({
          data: {
            propertyId,
            toPhone: phone,
            templateName: "kot_broadcast",
            body: text,
            status,
            providerId,
            sentAt: status === "sent" || status === "mock" ? new Date() : null,
          },
        });
        return status;
      })
    );

    return {
      recipients: recipients.length,
      sent: statuses.filter((s) => s !== "failed").length,
      failed: statuses.filter((s) => s === "failed").length,
      skipped: "",
    };
  } catch {
    return null; // broadcast is strictly best-effort
  }
}
