"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { mutate, flushQueue, getQueue } from "@/lib/offline-queue";
import { fmtTime, STATUS_LABELS } from "@/lib/format";
import { useRealtime, type RealtimeStatus } from "@/lib/realtime";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Bell,
  Check,
  CheckCircle2,
  ChefHat,
  Clock,
  CloudOff,
  ConciergeBell,
  Flame,
  RefreshCw,
  ShoppingBag,
  Utensils,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface KotItem {
  id: string;
  name: string;
  qty: number;
  notes: string;
  status: string;
}

interface KotOrder {
  id: string;
  orderNumber: string;
  orderType: string;
  tableNumber: string;
  roomNumber: string;
  guestName: string;
  createdAt: string;
  elapsedMinutes: number;
  items: KotItem[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const ITEM_NEXT: Record<string, string> = { pending: "preparing", preparing: "ready", ready: "served" };

const ITEM_CHIP: Record<string, string> = {
  pending: "border-line-strong bg-plaster text-ink",
  preparing: "border-warn/50 bg-warn/10 text-warn",
  ready: "border-brass/50 bg-brass-50 text-brass",
  served: "border-ok/50 bg-ok/10 text-ok",
};

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

// ─── Small pieces ────────────────────────────────────────────────────────────

function TypeBadge({ o }: { o: KotOrder }) {
  const cls =
    o.orderType === "room_service"
      ? "border-brass/40 bg-brass-50 text-brass"
      : o.orderType === "takeaway"
        ? "border-pine-700/30 bg-pine-100 text-pine-700"
        : "border-ok/40 bg-ok/10 text-ok";
  const Icon = o.orderType === "room_service" ? ConciergeBell : o.orderType === "takeaway" ? ShoppingBag : Utensils;
  const label =
    o.orderType === "room_service"
      ? `Room ${o.roomNumber || "—"}`
      : o.orderType === "takeaway"
        ? "Takeaway"
        : `Table ${o.tableNumber || "—"}`;
  return (
    <span className={cn("badge text-xs px-2.5 py-1", cls)}>
      <Icon className="h-3.5 w-3.5" /> {label}
    </span>
  );
}

function ItemChip({ item, onAdvance }: { item: KotItem; onAdvance: () => void }) {
  const next = ITEM_NEXT[item.status];
  return (
    <button
      onClick={() => next && onAdvance()}
      disabled={!next}
      className={cn(
        "inline-flex items-center gap-1.5 h-10 px-3 rounded-full border text-sm font-semibold transition shrink-0",
        ITEM_CHIP[item.status],
        next ? "hover:scale-105 active:scale-95 cursor-pointer" : "cursor-default"
      )}
      title={next ? `Tap → ${STATUS_LABELS[next] ?? next}` : "Done"}
    >
      {item.status === "pending" && <Clock className="h-4 w-4" />}
      {item.status === "preparing" && <Flame className="h-4 w-4" />}
      {item.status === "ready" && <Bell className="h-4 w-4" />}
      {item.status === "served" && <Check className="h-4 w-4" />}
      {STATUS_LABELS[item.status] ?? item.status}
      {next && <span className="text-[10px] opacity-60">▸</span>}
    </button>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function KitchenView() {
  const { toast } = useToast();
  const [orders, setOrders] = useState<KotOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [live, setLive] = useState<RealtimeStatus>("connecting");

  // Offline-first: connectivity flag + pending-op count for the header badge
  const [isOnline, setIsOnline] = useState(true);
  const [queuedCount, setQueuedCount] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await api<{ orders: KotOrder[] }>("/api/pos/kot");
      setOrders(d.orders);
    } catch {
      /* keep stale on offline */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  // Realtime: new KOTs and status changes from POS/other kitchen screens land instantly.
  useRealtime(
    (event) => {
      if (event === "kot:update") load();
    },
    (status) => setLive(status)
  );

  // Live clock (also re-renders elapsed minutes).
  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // Track connectivity + queue depth; auto-flush queued KOT flips on reconnect.
  const bumpQueueCount = useCallback(() => {
    getQueue()
      .then((q) => setQueuedCount(q.length))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    bumpQueueCount();
    const goOffline = () => setIsOnline(false);
    window.addEventListener("offline", goOffline);
    return () => window.removeEventListener("offline", goOffline);
  }, [bumpQueueCount]);

  const syncNow = useCallback(async () => {
    const r = await flushQueue();
    if (r.ok > 0) toast({ title: `Synced ${r.ok} offline kitchen update${r.ok === 1 ? "" : "s"}` });
    bumpQueueCount();
    load();
  }, [bumpQueueCount, load, toast]);

  useEffect(() => {
    if (isOnline) return;
    const goOnline = () => {
      setIsOnline(true);
      syncNow();
    };
    window.addEventListener("online", goOnline);
    return () => window.removeEventListener("online", goOnline);
  }, [isOnline, syncNow]);

  const advanceItem = async (o: KotOrder, item: KotItem) => {
    const next = ITEM_NEXT[item.status];
    if (!next || busyId) return;
    setBusyId(item.id);
    try {
      // Offline-safe: the PATCH sets an ABSOLUTE status, so an offline replay
      // is harmless; if the item moved on meanwhile the 4xx resolves the queue.
      const r = await mutate(`/api/pos/items/${item.id}`, "PATCH", { status: next }, `KOT ${o.orderNumber} · ${item.name} → ${next}`);
      if (r.queued) {
        toast({
          title: "Offline — update queued",
          description: `${item.name} → ${STATUS_LABELS[next] ?? next} syncs automatically when you're back online.`,
        });
        bumpQueueCount();
      }
      await load();
    } catch (e) {
      toast({ title: "Could not update item", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const markAllReady = async (o: KotOrder) => {
    const targets = o.items.filter((i) => i.status === "pending" || i.status === "preparing");
    if (targets.length === 0 || busyId) return;
    setBusyId(o.id);
    try {
      const results = await Promise.all(
        targets.map((i) =>
          mutate(`/api/pos/items/${i.id}`, "PATCH", { status: "ready" }, `KOT ${o.orderNumber} · ${i.name} → ready`)
        )
      );
      const queuedCount_ = results.filter((r) => r.queued).length;
      if (queuedCount_ > 0) {
        toast({
          title: `Offline — ${queuedCount_} update${queuedCount_ === 1 ? "" : "s"} queued`,
          description: `${o.orderNumber} “all ready” syncs automatically when you're back online.`,
        });
        bumpQueueCount();
      } else {
        toast({ title: `${o.orderNumber} — all items ready` });
      }
      await load();
    } catch (e) {
      toast({ title: "Could not update items", description: errMsg(e), variant: "destructive" });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const markServed = async (o: KotOrder) => {
    if (busyId) return;
    setBusyId(o.id);
    try {
      const r = await mutate(`/api/pos/orders/${o.id}`, "PATCH", { status: "served" }, `KOT ${o.orderNumber} → served`);
      if (r.queued) {
        toast({
          title: "Offline — update queued",
          description: `${o.orderNumber} “served” syncs automatically when you're back online.`,
        });
        bumpQueueCount();
      } else {
        toast({ title: `${o.orderNumber} marked served` });
      }
      await load();
    } catch (e) {
      toast({ title: "Could not update order", description: errMsg(e), variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = orders.length;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="panel px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md bg-pine-700 text-panel">
            <ChefHat className="h-6 w-6" />
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Live kitchen queue</p>
            <p className="text-sm text-muted-ink">
              {now ? fmtTime(now) : "—"} · {pendingCount} pending ticket{pendingCount === 1 ? "" : "s"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!isOnline || queuedCount > 0 ? (
            <span
              className={cn("badge", !isOnline ? "border-warn/40 bg-warn/10 text-warn" : "border-ok/40 bg-ok/10 text-ok")}
              title={!isOnline ? "Offline — status flips are queued and sync automatically" : "Queued kitchen updates waiting to sync"}
            >
              <CloudOff className="h-3.5 w-3.5" />
              {!isOnline ? "Offline" : `${queuedCount} queued`}
            </span>
          ) : null}
          {live === "online" ? (
            <span className="badge border-ok/40 bg-ok/10 text-ok">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-ok opacity-60" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-ok" />
              </span>
              Realtime
            </span>
          ) : (
            <span className="badge border-warn/40 bg-warn/10 text-warn">Reconnecting · polling 15s</span>
          )}
          <button className="btn-outline h-10" onClick={load}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        </div>
      </div>

      {/* Tickets */}
      {loading ? (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="panel p-4">
              <div className="skeleton h-40 rounded" />
            </div>
          ))}
        </div>
      ) : orders.length === 0 ? (
        <div className="panel py-16 flex flex-col items-center gap-3 text-center">
          <CheckCircle2 className="h-12 w-12 text-ok" />
          <p className="font-display text-lg font-semibold text-pine">No pending kitchen orders</p>
          <p className="text-sm text-muted-ink">All caught up — new KOTs appear here automatically.</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {orders.map((o) => {
            const elapsed = Math.max(
              0,
              Math.floor((now ? now.getTime() - new Date(o.createdAt).getTime() : o.elapsedMinutes * 60000) / 60000)
            );
            const late = elapsed > 15;
            const allReady = o.items.every((i) => i.status === "ready" || i.status === "served");
            const allDone = o.items.every((i) => i.status === "served");
            return (
              <div key={o.id} className={cn("panel p-4", late && "border-warn")}>
                {/* Ticket header */}
                <div className="flex items-start justify-between gap-2 border-b border-line pb-3">
                  <div>
                    <p className="font-display text-2xl font-bold text-pine leading-tight">{o.orderNumber}</p>
                    <p className="text-xs text-muted-ink mt-0.5">{fmtTime(o.createdAt)}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <TypeBadge o={o} />
                    <p className={cn("text-base font-bold leading-none", late ? "text-warn" : "text-muted-ink")}>
                      {elapsed} min
                    </p>
                  </div>
                </div>

                {/* Item lines */}
                <ul className="py-3 space-y-3">
                  {o.items.map((it) => (
                    <li key={it.id} className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="leading-snug">
                          <span className="text-xl font-bold text-pine">{it.qty}×</span>{" "}
                          <span className="text-lg text-ink">{it.name}</span>
                        </p>
                        {it.notes && <p className="text-sm text-warn font-medium truncate">↳ {it.notes}</p>}
                      </div>
                      <ItemChip item={it} onAdvance={() => advanceItem(o, it)} />
                    </li>
                  ))}
                </ul>

                {/* Actions */}
                <div className="flex gap-2 border-t border-line pt-3">
                  <button
                    className="btn-outline flex-1 h-11"
                    disabled={allDone || busyId === o.id}
                    onClick={() => markAllReady(o)}
                  >
                    <Bell className="h-4 w-4" /> Mark all ready
                  </button>
                  <button
                    className="btn-pine flex-1 h-11"
                    disabled={!allReady || busyId === o.id}
                    title={allReady ? "Mark the whole order served" : "All items must be ready first"}
                    onClick={() => markServed(o)}
                  >
                    <Check className="h-4 w-4" /> Order served
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
