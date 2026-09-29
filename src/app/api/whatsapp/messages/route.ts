import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";

const TEMPLATES = ["booking_confirmation", "pre_arrival", "post_stay", "custom"];
const STATUSES = ["queued", "sent", "failed", "mock"];

/**
 * GET /api/whatsapp/messages?template=&status= — message log, newest first,
 * with the linked reservation's confirmation number.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const { searchParams } = new URL(req.url);
  const template = searchParams.get("template");
  const status = searchParams.get("status");

  const where: Record<string, unknown> = { propertyId };
  if (template && TEMPLATES.includes(template)) where.templateName = template;
  if (status && STATUSES.includes(status)) where.status = status;

  const messages = await db.whatsAppMessage.findMany({
    where,
    include: { reservation: { select: { id: true, confirmationNumber: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ messages });
}
