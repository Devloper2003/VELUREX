import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/channels/ical/{linkToken} — the tenant's OUTBOUND calendar feed.
 *
 * This is the URL the tenant copies from "Link URLs" and pastes into the OTA
 * extranet's calendar-import field (Booking.com → Calendar → iCal import,
 * Airbnb → Availability → Calendar sync, EasyXcelerate → iCal…). The OTA's
 * servers pull it periodically, which is why it authenticates with the
 * connection's secret linkToken instead of a session cookie and is
 * allow-listed in src/proxy.ts.
 *
 * The feed is REAL: it streams the property's confirmed reservations as
 * VEVENTs so any standards-compliant calendar consumer (or human pasting the
 * URL into a browser) gets a valid iCalendar document.
 *
 * Privacy: summaries carry only the room type, confirmation number and night
 * count — never guest names, phones or IDs.
 */

const CRLF = "\r\n";

/** Escape per RFC 5545 §3.3.11. */
function icsEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** yyyymmdd local-date string for DTSTART;VALUE=DATE (check-out is exclusive). */
const dOnly = (d: Date) =>
  `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

const stamp = (d: Date) =>
  `${dOnly(d)}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}${String(d.getUTCSeconds()).padStart(2, "0")}Z`;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const conn = await db.channelConnection.findUnique({
    where: { linkToken: token },
    include: { property: { select: { name: true } } },
  });
  if (!conn) {
    return new NextResponse("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", {
      status: 404,
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    });
  }
  if (!conn.isActive) {
    // A paused channel still serves a valid (empty) calendar — OTA importers
    // report a clear "0 events" rather than an error the tenant can't see.
    return new NextResponse("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n", {
      status: 200,
      headers: { "Content-Type": "text/calendar; charset=utf-8" },
    });
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days of history
  const reservations = await db.reservation.findMany({
    where: {
      propertyId: conn.propertyId,
      status: { in: ["confirmed", "checked_in", "checked_out"] },
      checkOut: { gte: cutoff },
    },
    orderBy: { checkIn: "asc" },
    take: 300,
    select: {
      id: true, confirmationNumber: true, checkIn: true, checkOut: true,
      nights: true, status: true,
      roomType: { select: { name: true, code: true } },
    },
  });

  const now = stamp(new Date());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Velurex HMS//Channel Manager//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    icsEscape(`X-WR-CALNAME:Velurex — ${conn.property.name}`),
    icsEscape(`X-WR-CALDESC:Reservations exported by Velurex HMS for the ${conn.channel} channel`),
  ];

  for (const r of reservations) {
    const rt = r.roomType?.name ?? r.roomType?.code ?? "Room";
    lines.push(
      "BEGIN:VEVENT",
      `UID:${r.id}@channels.velurexhms.in`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dOnly(r.checkIn)}`,
      `DTEND;VALUE=DATE:${dOnly(r.checkOut)}`,
      icsEscape(`SUMMARY:${rt} · ${r.confirmationNumber} (${r.nights}N)`),
      icsEscape(`DESCRIPTION:Velurex confirmation ${r.confirmationNumber} — status ${r.status}`),
      `STATUS:${r.status === "cancelled" ? "CANCELLED" : "CONFIRMED"}`,
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  const body = lines.join(CRLF) + CRLF;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `inline; filename="velurex-${conn.channel}.ics"`,
      "Cache-Control": "no-store",
    },
  });
}
