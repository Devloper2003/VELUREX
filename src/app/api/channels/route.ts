import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { encryptJSON } from "@/lib/crypto";
import {
  CHANNEL_DEFS, getAdapter, getLinkMethodDef, validateCredentialFields,
  type ChannelKey, type LinkMethod,
} from "@/lib/channel-adapters";
import { logActivity } from "@/lib/business";
import { getTenantEntitlements, assertWritable, checkLimit } from "@/lib/entitlements";

/**
 * GET /api/channels — channel manager state: every supported channel (even
 * unconnected ones, so the UI can render connect cards) joined with the saved
 * connection, mapping coverage and queue health.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Entitlement snapshot lets the UI show channel-slot usage and pre-disable
  // Connect when the plan cap is reached (instead of a raw 403 on submit).
  const ent = await getTenantEntitlements(propertyId);
  const otaLimit = ent.limits.ota_channels ?? 0;
  const connCount = await db.channelConnection.count({ where: { propertyId } });
  const unlimited = otaLimit === -1;
  const remaining = unlimited ? null : Math.max(0, otaLimit - connCount);

  const [connections, roomTypes, jobStats] = await Promise.all([
    db.channelConnection.findMany({
      where: { propertyId },
      include: { mappings: true },
      orderBy: { createdAt: "asc" },
    }),
    db.roomType.findMany({ where: { propertyId }, orderBy: { baseRate: "asc" }, select: { id: true, name: true, code: true } }),
    db.channelSyncJob.groupBy({
      by: ["channelConnectionId", "status"],
      where: { propertyId, status: { in: ["pending", "processing", "failed"] } },
      _count: { _all: true },
    }),
  ]);

  const queueByChannel = new Map<string, { pending: number; failed: number }>();
  for (const s of jobStats) {
    if (!s.channelConnectionId) continue;
    const cur = queueByChannel.get(s.channelConnectionId) ?? { pending: 0, failed: 0 };
    if (s.status === "failed") cur.failed += s._count._all;
    else cur.pending += s._count._all;
    queueByChannel.set(s.channelConnectionId, cur);
  }

  const channels = CHANNEL_DEFS.map((def) => {
    const conn = connections.find((c) => c.channel === def.key);
    if (!conn) {
      return { ...def, connected: false as const, connection: null };
    }
    const q = queueByChannel.get(conn.id) ?? { pending: 0, failed: 0 };
    return {
      ...def,
      connected: true as const,
      connection: {
        id: conn.id,
        status: conn.status,
        isActive: conn.isActive,
        lastSyncedAt: conn.lastSyncedAt,
        linkMethod: conn.linkMethod as LinkMethod,
        // Outbound link URLs (token-authenticated — safe to show to the tenant;
        // the token is what OTA extranets paste, so it is not treated as a secret in UI).
        icalUrl: conn.linkToken ? `${req.nextUrl.origin}/api/channels/ical/${conn.linkToken}` : null,
        webhookUrl: conn.linkToken ? `${req.nextUrl.origin}/api/channels/webhook/${conn.linkToken}` : null,
        mappedRoomTypes: conn.mappings.filter((m) => m.externalRoomTypeId).length,
        queue: q,
      },
    };
  });

  return NextResponse.json({
    channels,
    roomTypes,
    supported: CHANNEL_DEFS.map((d) => d.key),
    otaChannels: {
      used: connCount,
      limit: otaLimit, // -1 = unlimited
      remaining,
      canConnect: unlimited || connCount < otaLimit,
      planName: ent.plan?.name ?? null,
    },
  });
}

/**
 * POST /api/channels — connect a channel with the tenant's chosen link
 * technology. Body: { channel, method?, credentials }.
 *   method = "api_keys" (classic XML/REST push) | "oauth2" (scoped token
 *   handshake) | "ical" (universal calendar URLs).
 * Credentials are validated through the method's field spec, then stored
 * AES-256-GCM encrypted per tenant. A linkToken is minted for the outbound
 * iCal export + webhook URLs shown after connecting. Own website needs no
 * credentials.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  // Plan enforcement: OTA channel slots are capped per plan.
  const ent = await getTenantEntitlements(propertyId);
  const ro = assertWritable(ent);
  if (ro) return ro;
  const connCount = await db.channelConnection.count({ where: { propertyId } });
  const capped = checkLimit(ent, "ota_channels", connCount, "OTA channels");
  if (capped) return capped;

  const body = (await req.json().catch(() => null)) as {
    channel?: string; method?: string; credentials?: Record<string, string>;
  } | null;
  if (!body?.channel) return NextResponse.json({ error: "channel is required" }, { status: 400 });

  const key = body.channel as ChannelKey;
  const adapter = getAdapter(key);
  if (!adapter) return NextResponse.json({ error: `Unsupported channel "${body.channel}"` }, { status: 400 });

  const def = CHANNEL_DEFS.find((d) => d.key === key);
  // Resolve the link method against what the channel actually offers.
  const requested = body.method ?? "api_keys";
  const methodDef = def ? getLinkMethodDef(def, requested) : undefined;
  const method: LinkMethod = (methodDef?.method ?? "api_keys") as LinkMethod;
  const credentials = key === "own_website" ? {} : body.credentials ?? {};
  const fieldErrors = key === "own_website" || !methodDef
    ? {}
    : validateCredentialFields(methodDef.fields, credentials);
  const test = await adapter.testConnection(credentials, method);
  if (!test.ok) {
    return NextResponse.json(
      { error: test.message, fieldErrors: Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined },
      { status: 422 },
    );
  }

  const existing = await db.channelConnection.findUnique({
    where: { propertyId_channel: { propertyId, channel: key } },
  });

  // Mint (or reuse) the secret that authenticates the tenant's outbound link
  // URLs: the iCal export the tenant pastes into the OTA extranet and the
  // webhook endpoint OTAs push booking events to.
  const linkToken = existing?.linkToken ?? (key === "own_website" ? null : randomBytes(24).toString("base64url"));

  const data = {
    status: "connected" as const,
    credentials: encryptJSON(credentials),
    linkMethod: method,
    ...(linkToken ? { linkToken } : {}),
    isActive: true,
  };

  const conn = existing
    ? await db.channelConnection.update({ where: { id: existing.id }, data })
    : await db.channelConnection.create({ data: { propertyId, channel: key, ...data } });

  // Auto-map own_website (internal ids are the engine's ids)
  if (key === "own_website") {
    const roomTypes = await db.roomType.findMany({ where: { propertyId }, select: { id: true, code: true } });
    for (const rt of roomTypes) {
      await db.channelRoomMapping.upsert({
        where: { channelConnectionId_roomTypeId: { channelConnectionId: conn.id, roomTypeId: rt.id } },
        create: { channelConnectionId: conn.id, roomTypeId: rt.id, externalRoomTypeId: `OWN-${rt.code.toUpperCase().replace(/[^A-Z0-9]/g, "")}` },
        update: { externalRoomTypeId: `OWN-${rt.code.toUpperCase().replace(/[^A-Z0-9]/g, "")}` },
      });
    }
  }

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "CHANNEL_CONNECT",
    entity: "ChannelConnection",
    entityId: conn.id,
    details: `Connected ${key.replace("_", " ")} channel via ${method === "api_keys" ? "API keys" : method === "oauth2" ? "OAuth 2.0" : "iCal calendar sync"}${key === "own_website" ? " (booking engine)" : ""} — credentials encrypted at rest`,
  });

  return NextResponse.json({
    connection: {
      id: conn.id, channel: conn.channel, status: conn.status, isActive: conn.isActive,
      linkMethod: conn.linkMethod,
      icalUrl: conn.linkToken ? `${req.nextUrl.origin}/api/channels/ical/${conn.linkToken}` : null,
      webhookUrl: conn.linkToken ? `${req.nextUrl.origin}/api/channels/webhook/${conn.linkToken}` : null,
    },
    message: test.message,
  });
}
