import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptJSON, decryptJSON } from "@/lib/crypto";
import { getAdapter } from "@/lib/channel-adapters";
import { logActivity } from "@/lib/business";

type Params = { params: Promise<{ id: string }> };

/**
 * PATCH /api/channels/[id] — update a connection:
 *   { isActive }                    → pause/resume pushing (stays connected)
 *   { credentials }                 → rotate credentials (re-validated + re-encrypted)
 *   { action: "reconnect" }         → handshake again after an error state
 *   { action: "disconnect" }        → status disconnected (credentials kept)
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const conn = await db.channelConnection.findFirst({ where: { id, propertyId } });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | { isActive?: boolean; credentials?: Record<string, string>; action?: "reconnect" | "disconnect" }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const data: { status?: string; isActive?: boolean; credentials?: string } = {};

  if (typeof body.isActive === "boolean") data.isActive = body.isActive;

  if (body.action === "disconnect") {
    data.status = "disconnected";
  } else if (body.action === "reconnect") {
    const adapter = getAdapter(conn.channel);
    const creds = body.credentials ?? undefined;
    if (adapter && conn.channel !== "own_website") {
      // Validate NEW credentials when rotating, otherwise re-test the stored bundle.
      const test = creds
        ? await adapter.testConnection(creds)
        : await adapter.testConnection(decryptJSON<Record<string, string>>(conn.credentials));
      if (!test.ok) {
        await db.channelConnection.update({ where: { id: conn.id }, data: { status: "error" } });
        return NextResponse.json({ error: test.message }, { status: 422 });
      }
    }
    data.status = "connected";
    if (creds) data.credentials = encryptJSON(creds);
  } else if (body.credentials) {
    const adapter = getAdapter(conn.channel);
    if (adapter && conn.channel !== "own_website") {
      const test = await adapter.testConnection(body.credentials);
      if (!test.ok) return NextResponse.json({ error: test.message }, { status: 422 });
    }
    data.credentials = encryptJSON(body.credentials);
    data.status = "connected";
  }

  const updated = await db.channelConnection.update({ where: { id: conn.id }, data });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_UPDATE",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: [
      body.action === "disconnect" ? "disconnected channel" : null,
      body.action === "reconnect" ? "re-connected channel" : null,
      typeof data.isActive === "boolean" ? `push ${data.isActive ? "resumed" : "paused"}` : null,
      data.credentials ? "credentials rotated" : null,
    ].filter(Boolean).join(" · ") || `updated ${conn.channel}`,
  });

  return NextResponse.json({
    connection: { id: updated.id, channel: updated.channel, status: updated.status, isActive: updated.isActive, lastSyncedAt: updated.lastSyncedAt },
  });
}

/** DELETE /api/channels/[id] — remove connection + mappings (logs retained). */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { id } = await params;

  const conn = await db.channelConnection.findFirst({ where: { id, propertyId } });
  if (!conn) return NextResponse.json({ error: "Channel connection not found" }, { status: 404 });

  await db.channelSyncJob.deleteMany({ where: { channelConnectionId: conn.id, status: { in: ["pending", "processing"] } } });
  await db.channelConnection.delete({ where: { id: conn.id } });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_DISCONNECT",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: `Removed ${conn.channel.replace("_", " ")} connection and unmapped its room types (sync history retained)`,
  });

  return NextResponse.json({ ok: true });
}
