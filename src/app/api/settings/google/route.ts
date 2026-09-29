import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * POST /api/settings/google — Google Business Profile connection state.
 *
 * The connection state is persisted on the Property row (googleProfile JSON:
 * { connected, accountEmail, profileName, lastSyncedAt }) so every client sees
 * the same truth. "sync" refreshes lastSyncedAt, writes an activity-log entry
 * (which live-pushes to all connected clients via the realtime service), and
 * is the same path the nightly audit uses to stamp profile syncs.
 *
 * Body: { action: "connect" | "disconnect" | "sync", accountEmail? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin"]);
  if ("error" in auth) return auth.error;
  const { propertyId, sub, name: staffName } = auth.session;

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Property not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as
    | { action?: string; accountEmail?: string }
    | null;
  const action = body?.action;
  if (!action || !["connect", "disconnect", "sync"].includes(action)) {
    return NextResponse.json({ error: "action must be connect | disconnect | sync" }, { status: 400 });
  }

  let profile: { connected: boolean; accountEmail?: string; profileName?: string; lastSyncedAt?: string | null } = { connected: false };
  try {
    if (property.googleProfile) profile = { connected: false, ...JSON.parse(property.googleProfile) };
  } catch { /* treat corrupt JSON as disconnected */ }

  if (action === "connect") {
    const email = String(body?.accountEmail ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return NextResponse.json({ error: "A valid Google account email is required" }, { status: 400 });
    }
    profile = {
      connected: true,
      accountEmail: email,
      profileName: property.name,
      lastSyncedAt: new Date().toISOString(),
    };
    // TRUE staff linkage: any team member whose login email matches the
    // connected Google account is linked for Google sign-in automatically.
    await db.staff.updateMany({
      where: { propertyId, email },
      data: { googleEmail: email },
    });
    await logActivity({
      propertyId, staffId: sub, staffName,
      action: "GOOGLE_CONNECT", entity: "Property", entityId: propertyId,
      details: `Google Business Profile connected as ${email}`,
    });
  } else if (action === "disconnect") {
    profile = { connected: false };
    // Unlink team members that were linked through this workspace account.
    const prev = (() => {
      try { return JSON.parse(property.googleProfile ?? "{}") as { accountEmail?: string }; } catch { return {}; }
    })();
    if (prev.accountEmail) {
      await db.staff.updateMany({
        where: { propertyId, googleEmail: prev.accountEmail },
        data: { googleEmail: null },
      });
    }
    await logActivity({
      propertyId, staffId: sub, staffName,
      action: "GOOGLE_DISCONNECT", entity: "Property", entityId: propertyId,
      details: "Google Business Profile disconnected",
    });
  } else {
    if (!profile.connected) {
      return NextResponse.json({ error: "Google Business Profile is not connected" }, { status: 400 });
    }
    profile.lastSyncedAt = new Date().toISOString();
    await logActivity({
      propertyId, staffId: sub, staffName,
      action: "GOOGLE_SYNC", entity: "Property", entityId: propertyId,
      details: `Google Business Profile synced (${profile.profileName ?? property.name})`,
    });
  }

  const updated = await db.property.update({
    where: { id: propertyId },
    data: { googleProfile: JSON.stringify(profile) },
  });

  let out: typeof profile = { connected: false };
  try {
    if (updated.googleProfile) out = { connected: false, ...JSON.parse(updated.googleProfile) };
  } catch { /* keep default */ }
  return NextResponse.json({ googleProfile: out });
}
