import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { demoScope, notDemoAudit, notDemoTenant, notDemoTenantId } from "@/lib/owner-demo";

/**
 * GET /api/owner/health — job queue status, recent platform errors,
 * last daily-job run, DB backup placeholder (clearly marked when not wired).
 *
 * Runs on Neon PostgreSQL: database size via pg_database_size, plus a live
 * connectivity probe with round-trip latency.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  // Live connectivity probe — measures round-trip latency to Postgres.
  const probeStart = Date.now();
  await db.$queryRaw`SELECT 1`;
  const dbLatencyMs = Date.now() - probeStart;

  const [cronRow, pendingJobs, failedJobs, recentErrors, sizeRows, propertyCount] = await Promise.all([
    db.platformSetting.findUnique({ where: { key: "cron_last_run" } }),
    db.channelSyncJob.count({ where: { status: "pending", ...notDemoTenant(scope) } }),
    db.channelSyncJob.count({ where: { status: "failed", ...notDemoTenant(scope) } }),
    db.platformAuditLog.findMany({
      where: { action: { in: ["DAILY_JOBS_ERROR", "SYSTEM_ERROR"] }, ...notDemoAudit(scope) },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    // Postgres equivalent of the old SQLite pragma page math.
    db.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`,
    db.property.count({ where: { deletedAt: null, ...notDemoTenantId(scope) } }),
  ]);

  const backupRow = await db.platformSetting.findUnique({ where: { key: "last_db_backup" } });

  return NextResponse.json({
    dailyJobs: {
      lastRun: cronRow?.value ? new Date(cronRow.value) : null,
      lastRunBy: cronRow?.updatedBy ?? "scheduler",
      configured: true,
    },
    queue: { pending: pendingJobs, failed: failedJobs },
    recentErrors: recentErrors.map((e) => ({
      id: e.id,
      action: e.action,
      details: e.details,
      createdAt: e.createdAt,
    })),
    database: {
      sizeBytes: Number(sizeRows[0]?.size ?? 0),
      properties: propertyCount,
      provider: "PostgreSQL · Neon",
      latencyMs: dbLatencyMs,
      backup: backupRow
        ? { lastBackup: new Date(backupRow.value), configured: true }
        : { lastBackup: null, configured: false, note: "DB backups are not wired in this environment — configure a cron dump in production. Data retention for suspended tenants (60d) is enforced by the daily jobs." },
    },
  });
}
