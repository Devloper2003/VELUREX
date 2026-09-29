import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Meta webhook endpoints (public — verified via hub.verify_token):
 *   GET  /api/whatsapp/webhook — subscription handshake: echo hub.challenge
 *        when hub.verify_token matches ANY tenant's saved verify token (or the
 *        platform WHATSAPP_VERIFY_TOKEN env).
 *   POST /api/whatsapp/webhook — delivery/status events. Acknowledged with 200
 *        immediately; Meta retries on non-200, so failures must never throw.
 */

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mode = sp.get("hub.mode");
  const token = sp.get("hub.verify_token") ?? "";
  const challenge = sp.get("hub.challenge") ?? "";

  if (mode !== "subscribe" || !token) {
    return new NextResponse("Bad request", { status: 400 });
  }

  const envToken = process.env.WHATSAPP_VERIFY_TOKEN ?? "";
  let matched = envToken !== "" && token === envToken;
  if (!matched) {
    const cfg = await db.whatsAppConfig.findFirst({
      where: { verifyToken: token },
      select: { id: true },
    });
    matched = Boolean(cfg);
  }

  if (!matched) return new NextResponse("Forbidden", { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(req: NextRequest) {
  // Always 200 so Meta does not retry-storm; payload inspection is a TODO for
  // delivery receipts (message status → WhatsAppMessage.providerId matching).
  try {
    await req.json();
  } catch {
    /* ignore malformed payloads */
  }
  return NextResponse.json({ received: true });
}
