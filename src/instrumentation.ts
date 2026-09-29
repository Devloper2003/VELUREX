/**
 * Velurex platform scheduler (BUILD 10).
 * Registers once per server process: every 30 minutes it checks whether the
 * daily platform jobs (renewals, trial reminders, overdue→suspend, usage
 * snapshots) have run today; if not, it runs them. The owner can also trigger
 * manually via POST /api/owner/cron/daily.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const g = globalThis as typeof globalThis & { __vxDailyJobsTimer?: NodeJS.Timeout };
  if (g.__vxDailyJobsTimer) return; // HMR / multiple registration guard

  const tick = async () => {
    try {
      const { runDailyJobs } = await import("@/lib/platform-jobs");
      const result = await runDailyJobs();
      if (result.ran.length > 0) {
        console.log("[velurex-daily-jobs]", result.ran.join(" · "));
      }
    } catch (err) {
      console.error("[velurex-daily-jobs] failed:", err);
      const { db } = await import("@/lib/db");
      const { logPlatformAction } = await import("@/lib/platform");
      await logPlatformAction({
        actorName: "system", action: "DAILY_JOBS_ERROR", entity: "platform",
        details: `Daily jobs failed: ${String(err).slice(0, 300)}`,
      }).catch(() => {});
      await db.$disconnect().catch(() => {});
    }
  };

  // First run shortly after boot, then every 30 minutes (idempotent per day).
  g.__vxDailyJobsTimer = setInterval(tick, 30 * 60 * 1000);
  setTimeout(tick, 15_000);
}
