import { db } from "@/lib/db";
import { decryptJSON } from "@/lib/crypto";
import { getAdapter, type ChannelPushPayload } from "@/lib/channel-adapters";
import { emitRealtime } from "@/lib/realtime-server";

/**
 * DB-backed async push queue.
 *
 * Every open/close/rate change writes one ChannelSyncJob per target channel,
 * then returns to the caller immediately — the UI never waits on OTA APIs.
 * A worker tick (client poll or fire-and-forget call after toggle) drains the
 * queue: claims jobs → calls the channel's ChannelAdapter → writes a
 * ChannelSyncLog row per attempt → updates connection health.
 *
 * Attempts < MAX_ATTEMPTS are re-queued automatically (mock OTA flakes recover
 * on retry); after MAX_ATTEMPTS the job is marked failed permanently and the
 * cell shows a retry action in the UI.
 */

const MAX_ATTEMPTS = 3;
const BATCH = 12;

export interface EnqueueInput {
  propertyId: string;
  inventoryId: string;
  action: "open" | "close" | "rate_update" | "full_sync";
  payload: {
    dateISO: string;
    roomTypeId: string;
    availableCount: number;
    isOpen: boolean;
    rate: number | null;
  };
}

/** Fan out one job per active+connected channel that maps this room type. */
export async function enqueueChannelJobs(input: EnqueueInput): Promise<number> {
  const connections = await db.channelConnection.findMany({
    where: { propertyId: input.propertyId, isActive: true, status: "connected" },
    include: { mappings: { where: { roomTypeId: input.payload.roomTypeId } } },
  });

  const targets = connections.filter((c) => c.mappings.length > 0 && c.mappings[0].externalRoomTypeId);
  if (targets.length === 0) return 0;

  await db.channelSyncJob.createMany({
    data: targets.map((c) => ({
      propertyId: input.propertyId,
      channelConnectionId: c.id,
      roomInventoryId: input.inventoryId,
      action: input.action,
      payload: JSON.stringify(input.payload),
    })),
  });

  // Best-effort immediate drain so single toggles feel instant.
  void processChannelJobs(input.propertyId).catch(() => {});
  return targets.length;
}

/** Re-queue a permanently failed job (cell-level Retry button). */
export async function retryChannelJob(jobId: string, propertyId: string): Promise<boolean> {
  const job = await db.channelSyncJob.findFirst({ where: { id: jobId, propertyId } });
  if (!job) return false;
  await db.channelSyncJob.update({
    where: { id: job.id },
    data: { status: "pending", attempts: 0, lastError: "" },
  });
  void processChannelJobs(propertyId).catch(() => {});
  return true;
}

/** Drain pending jobs for a property. Safe to call concurrently — claims via updateMany. */
export async function processChannelJobs(propertyId: string): Promise<{
  processed: number; done: number; failed: number; requeued: number;
}> {
  const pending = await db.channelSyncJob.findMany({
    where: { propertyId, status: "pending", attempts: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: "asc" },
    take: BATCH,
  });

  let done = 0, failed = 0, requeued = 0;

  for (const job of pending) {
    // Claim atomically (concurrent ticks skip already-claimed jobs)
    const claimed = await db.channelSyncJob.updateMany({
      where: { id: job.id, status: "pending" },
      data: { status: "processing", attempts: { increment: 1 } },
    });
    if (claimed.count === 0) continue;

    const attempts = job.attempts + 1;
    try {
      const inv = await db.roomInventory.findUnique({ where: { id: job.roomInventoryId } });
      const conn = job.channelConnectionId
        ? await db.channelConnection.findUnique({ where: { id: job.channelConnectionId } })
        : null;

      if (!inv || !conn) {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "failed", processedAt: new Date(), lastError: "Inventory row or channel connection no longer exists." },
        });
        failed++;
        continue;
      }

      const adapter = getAdapter(conn.channel);
      if (!adapter) {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "failed", processedAt: new Date(), lastError: `No adapter registered for channel "${conn.channel}".` },
        });
        failed++;
        continue;
      }

      const mapping = await db.channelRoomMapping.findFirst({
        where: { channelConnectionId: conn.id, roomTypeId: inv.roomTypeId },
      });
      const credentials = decryptJSON<Record<string, string>>(conn.credentials);
      const payload = JSON.parse(job.payload || "{}") as Omit<ChannelPushPayload, "action" | "externalRoomTypeId" | "credentials">;

      const result = await adapter.pushInventory({
        ...payload,
        action: job.action as ChannelPushPayload["action"],
        externalRoomTypeId: mapping?.externalRoomTypeId ?? "",
        credentials,
        attempt: attempts,
      });

      await db.channelSyncLog.create({
        data: {
          propertyId,
          channelConnectionId: conn.id,
          roomInventoryId: inv.id,
          channel: conn.channel,
          action: job.action,
          status: result.ok ? "success" : "failed",
          message: result.message,
        },
      });

      if (result.ok) {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "done", processedAt: new Date(), lastError: "" },
        });
        await db.channelConnection.update({
          where: { id: conn.id },
          data: { lastSyncedAt: new Date(), status: "connected" },
        });
        done++;
        emitRealtime("global", "channel:sync", {
          inventoryId: inv.id, channel: conn.channel, status: "success",
          action: job.action, date: inv.date, roomTypeId: inv.roomTypeId,
        });
      } else if (attempts >= MAX_ATTEMPTS) {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "failed", processedAt: new Date(), lastError: result.message },
        });
        await db.channelConnection.update({ where: { id: conn.id }, data: { status: "error" } });
        failed++;
        emitRealtime("global", "channel:sync", {
          inventoryId: inv.id, channel: conn.channel, status: "failed",
          action: job.action, date: inv.date, roomTypeId: inv.roomTypeId, error: result.message,
        });
      } else {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "pending", lastError: result.message },
        });
        requeued++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown worker error";
      if (attempts >= MAX_ATTEMPTS) {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "failed", processedAt: new Date(), lastError: message },
        }).catch(() => {});
        failed++;
      } else {
        await db.channelSyncJob.update({
          where: { id: job.id },
          data: { status: "pending", lastError: message },
        }).catch(() => {});
        requeued++;
      }
    }
  }

  return { processed: pending.length, done, failed, requeued };
}
