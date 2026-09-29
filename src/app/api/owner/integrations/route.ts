import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/integrations — platform-wide OTA connections view:
 * every tenant's channel connections, last sync, failures (7d).
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const connections = await db.channelConnection.findMany({
    where: notDemoTenant(scope),
    include: {
      property: { select: { id: true, name: true, city: true, subscriptionStatus: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const [failures, jobs] = await Promise.all([
    db.channelSyncLog.groupBy({
      by: ["propertyId"],
      where: { status: "failed", attemptedAt: { gte: weekAgo }, ...notDemoTenant(scope) },
      _count: true,
    }),
    db.channelSyncJob.findMany({
      where: { status: { in: ["pending", "processing", "failed"] }, ...notDemoTenant(scope) },
      include: { property: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 20,
    }),
  ]);
  const failMap = new Map(failures.map((f) => [f.propertyId, f._count]));

  return NextResponse.json({
    connections: connections.map((c) => ({
      id: c.id,
      channel: c.channel,
      status: c.status,
      isActive: c.isActive,
      lastSyncedAt: c.lastSyncedAt,
      updatedAt: c.updatedAt,
      property: c.property,
      failures7d: failMap.get(c.propertyId) ?? 0,
    })),
    queue: jobs.map((j) => ({
      id: j.id, action: j.action, status: j.status, attempts: j.attempts,
      lastError: j.lastError, createdAt: j.createdAt, property: j.property.name,
    })),
    summary: {
      connected: connections.filter((c) => c.status === "connected").length,
      error: connections.filter((c) => c.status === "error").length,
      total: connections.length,
    },
  });
}
