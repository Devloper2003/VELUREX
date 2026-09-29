"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { fmtTime, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { mutate, flushQueue, getQueue } from "@/lib/offline-queue";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  BrushCleaning, BedDouble, Droplets, ClipboardCheck, MoonStar, Plus, Play, Check, Ban,
  RotateCcw, CloudOff, RefreshCw, Sparkles, Wrench, UserRound, Loader2, TriangleAlert,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ActiveTask {
  id: string; taskType: string; status: string; priority: string; assignedToName: string | null;
}
interface BoardRoom {
  id: string; number: string; floor: number; status: string; note: string;
  roomTypeName: string; currentGuest: string | null; activeTask: ActiveTask | null;
}
interface BoardFloor { floor: number; rooms: BoardRoom[] }
interface BoardData {
  floors: BoardFloor[];
  counts: { total: number; vacant: number; occupied: number; dirty: number; clean: number; outOfOrder: number; openTasks: number };
}
interface HkTask {
  id: string; roomId: string; assignedTo: string | null; taskType: string; priority: string;
  status: string; dueAt: string | null; notes: string; completedAt: string | null;
  clientRef: string; createdAt: string;
  room: { number: string; floor: number; status: string };
  assignedToStaff: { name: string } | null;
  offline?: boolean; // temporary row created while offline (not yet on server)
}
type TaskPatch = Partial<Pick<HkTask, "status" | "assignedTo" | "priority" | "dueAt" | "notes">>;

const TASK_TYPE_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string }> = {
  cleaning: { icon: BrushCleaning, label: "Cleaning" },
  linen_change: { icon: BedDouble, label: "Linen Change" },
  bathroom: { icon: Droplets, label: "Bathroom" },
  inspection: { icon: ClipboardCheck, label: "Inspection" },
  turndown: { icon: MoonStar, label: "Turndown" },
};

const PRIORITY_BADGE: Record<string, string> = {
  high: "border-danger/40 bg-danger/10 text-danger",
  normal: "border-line-strong bg-plaster text-muted-ink",
  low: "border-line bg-transparent text-muted-ink",
};
const TASK_STATUS_BADGE: Record<string, string> = {
  pending: "border-warn/40 bg-warn/10 text-warn",
  in_progress: "border-brass/40 bg-brass-50 text-brass",
  completed: "border-ok/40 bg-ok/10 text-ok",
  blocked: "border-danger/40 bg-danger/10 text-danger",
};

const EMPTY_FORM = { roomId: "", taskType: "cleaning", priority: "normal", dueAt: "", assignedTo: "none", notes: "" };

// ─── View ────────────────────────────────────────────────────────────────────

export default function HousekeepingView() {
  const user = useSession((s) => s.user);
  const { toast } = useToast();

  const [online, setOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [tasks, setTasks] = useState<HkTask[]>([]);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("pending");

  // Offline optimistic overlays (cleared once a fetch confirms server truth)
  const [patches, setPatches] = useState<Record<string, TaskPatch>>({});
  const [offlineCreated, setOfflineCreated] = useState<HkTask[]>([]);

  // Dialog state
  const [roomDialog, setRoomDialog] = useState<BoardRoom | null>(null);
  const [oooOpen, setOooOpen] = useState(false);
  const [oooNote, setOooNote] = useState("");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const allRooms = useMemo(() => board?.floors.flatMap((f) => f.rooms) ?? [], [board]);

  const refreshQueueCount = useCallback(async () => {
    try { setQueueCount((await getQueue()).length); } catch { /* IndexedDB unavailable */ }
  }, []);

  const load = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) { setLoading(false); return; } // paused offline
    try {
      const [b, t, s] = await Promise.all([
        api<BoardData>("/api/housekeeping/board"),
        api<{ tasks: HkTask[] }>("/api/housekeeping/tasks"),
        api<{ staff: { id: string; name: string }[] }>("/api/housekeeping/staff"),
      ]);
      setBoard(b);
      setTasks(t.tasks);
      setStaff(s.staff);
      const q = await getQueue();
      setQueueCount(q.length);
      if (q.length === 0) { setPatches({}); setOfflineCreated([]); } // server truth confirmed
    } catch {
      /* offline or error — keep stale data */
    } finally {
      setLoading(false);
      refreshQueueCount();
    }
  }, [refreshQueueCount]);

  // Initial load
  useEffect(() => {
    setOnline(navigator.onLine);
    load();
  }, [load]);

  // Auto-refresh every 45s (paused offline)
  useEffect(() => {
    const t = setInterval(() => { if (navigator.onLine) load(); }, 45000);
    return () => clearInterval(t);
  }, [load]);

  // Online/offline events: auto-flush when connectivity returns
  useEffect(() => {
    const goOnline = () => {
      setOnline(true);
      (async () => {
        const r = await flushQueue();
        if (r.ok > 0) toast({ title: `Synced ${r.ok} offline change${r.ok === 1 ? "" : "s"}` });
        if (r.failed > 0) toast({ title: `${r.failed} change${r.failed === 1 ? "" : "s"} failed to sync`, description: "They stay queued — tap Sync now.", variant: "destructive" });
        await load();
      })();
    };
    const goOffline = () => {
      setOnline(false);
      toast({ title: "You're offline", description: "Changes are saved on this device and sync automatically." });
    };
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    // Background sync (service worker) replayed the queue while this view was
    // mounted but the tab hidden — refresh the board with the result.
    const onSwSync = () => { void load(); };
    window.addEventListener("velurex:sw-sync-done", onSwSync);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("velurex:sw-sync-done", onSwSync);
    };
  }, [load, toast]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await flushQueue();
      if (r.ok === 0 && r.failed === 0) toast({ title: "Nothing to sync — all caught up" });
      if (r.ok > 0) toast({ title: `Synced ${r.ok} change${r.ok === 1 ? "" : "s"}` });
      if (r.failed > 0) toast({ title: `${r.failed} failed — kept in queue`, variant: "destructive" });
      await load();
    } catch {
      toast({ title: "Sync failed", description: "Check your connection and try again.", variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  };

  // ─── Room status (offline-safe via mutate) ────────────────────────────────

  const applyLocalRoom = (roomId: string, status: string, note?: string) => {
    setBoard((prev) =>
      prev
        ? {
            ...prev,
            floors: prev.floors.map((f) => ({
              ...f,
              rooms: f.rooms.map((r) => (r.id === roomId ? { ...r, status, note: note !== undefined ? note : r.note } : r)),
            })),
          }
        : prev
    );
  };

  const setRoomStatus = async (roomId: string, status: string, note?: string, label?: string) => {
    applyLocalRoom(roomId, status, note); // optimistic tile update
    try {
      const r = await mutate("/api/housekeeping/room-status", "POST", { roomId, status, ...(note !== undefined ? { note } : {}) }, label || `Room → ${STATUS_LABELS[status] || status}`);
      if (r.queued) toast({ title: "Saved offline — will sync" });
      else toast({ title: label || "Room status updated" });
      setRoomDialog(null);
      setOooOpen(false);
      setOooNote("");
      await load();
    } catch (e) {
      toast({ title: "Could not update room", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
      await load(); // revert optimistic state from server truth
    }
  };

  // ─── Task mutations (offline-safe via mutate) ─────────────────────────────

  const patchTask = async (task: HkTask, data: TaskPatch, label: string) => {
    try {
      const r = await mutate(`/api/housekeeping/tasks/${task.id}`, "PATCH", data, label);
      if (r.queued) {
        toast({ title: "Saved offline — will sync" });
        setPatches((prev) => ({ ...prev, [task.id]: { ...prev[task.id], ...data } }));
      } else {
        toast({ title: label });
        await load();
      }
    } catch (e) {
      toast({ title: "Could not update task", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    }
  };

  const submitNewTask = async () => {
    if (!form.roomId) { toast({ title: "Pick a room first", variant: "destructive" }); return; }
    setSaving(true);
    const assignedTo = form.assignedTo === "none" ? null : form.assignedTo;
    const payload = {
      roomId: form.roomId,
      taskType: form.taskType,
      priority: form.priority,
      assignedTo,
      notes: form.notes,
      ...(form.dueAt ? { dueAt: new Date(form.dueAt).toISOString() } : {}),
    };
    try {
      const r = await mutate<{ task: HkTask }>("/api/housekeeping/tasks", "POST", payload, "New task");
      if (r.queued) {
        toast({ title: "Saved offline — will sync" });
        const room = allRooms.find((x) => x.id === form.roomId);
        const member = staff.find((s) => s.id === assignedTo);
        setOfflineCreated((prev) => [
          ...prev,
          {
            id: `offline-${Date.now()}`,
            roomId: form.roomId,
            assignedTo,
            taskType: form.taskType,
            priority: form.priority,
            status: "pending",
            dueAt: form.dueAt ? new Date(form.dueAt).toISOString() : null,
            notes: form.notes,
            completedAt: null,
            clientRef: "",
            createdAt: new Date().toISOString(),
            room: { number: room?.number ?? "?", floor: room?.floor ?? 0, status: room?.status ?? "vacant" },
            assignedToStaff: member ? { name: member.name } : null,
            offline: true,
          },
        ]);
        setNewTaskOpen(false);
        setForm(EMPTY_FORM);
      } else {
        toast({ title: "Task created" });
        setNewTaskOpen(false);
        setForm(EMPTY_FORM);
        await load();
      }
    } catch (e) {
      toast({ title: "Could not create task", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  // ─── Derived task list ────────────────────────────────────────────────────

  const allTasks = useMemo(() => {
    const merged = tasks.map((t) => (patches[t.id] ? { ...t, ...patches[t.id] } : t));
    return [...merged, ...offlineCreated];
  }, [tasks, patches, offlineCreated]);

  const visibleTasks = useMemo(() => {
    const filtered = tab === "all" ? allTasks : allTasks.filter((t) => t.status === tab);
    const order: Record<string, number> = { pending: 0, in_progress: 1, blocked: 2, completed: 3 };
    return [...filtered].sort((a, b) => {
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      if (a.status === "completed") return new Date(b.completedAt ?? 0).getTime() - new Date(a.completedAt ?? 0).getTime();
      const da = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const dbv = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      return da - dbv;
    });
  }, [allTasks, tab]);

  const tabCount = (s: string) => (s === "all" ? allTasks.length : allTasks.filter((t) => t.status === s).length);

  const assigneeName = (t: HkTask) =>
    t.assignedToStaff?.name ?? staff.find((s) => s.id === t.assignedTo)?.name ?? "Unassigned";

  const onAssign = (taskId: string, value: string) => {
    const t = allTasks.find((x) => x.id === taskId);
    if (t) patchTask(t, { assignedTo: value === "none" ? null : value }, "Assignee updated");
  };

  // ─── Loading / error states ───────────────────────────────────────────────

  if (loading && !board) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-12 rounded-lg" />
        <div className="panel p-4 space-y-4">
          {[...Array(3)].map((_, i) => <div key={i} className="skeleton h-14 rounded-md" />)}
        </div>
        <div className="panel p-4 space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-16 rounded-md" />)}
        </div>
      </div>
    );
  }

  if (!board) {
    return (
      <div className="panel p-6 space-y-3">
        <p className="text-sm text-danger flex items-center gap-2"><TriangleAlert className="h-4 w-4" /> Could not load the housekeeping board.</p>
        <button className="btn-outline" onClick={() => { setLoading(true); load(); }}><RefreshCw className="h-4 w-4" /> Retry</button>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Sticky header with persistent sync chip — thumb-reachable on phones */}
      <div className="sticky top-0 z-20 bg-plaster/95 backdrop-blur-sm pt-1 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-pine truncate">{board.counts.total} rooms · {board.floors.length} floors</h2>
            <p className="text-xs text-muted-ink truncate">
              {board.counts.dirty} dirty · {board.counts.clean} clean · {board.counts.openTasks} open tasks
              {!online && <span className="text-warn font-medium"> · offline mode</span>}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn-outline h-9" onClick={syncNow} disabled={syncing} aria-label="Sync queued changes">
              {online ? <RefreshCw className={cn("h-4 w-4", syncing && "animate-spin")} /> : <CloudOff className="h-4 w-4 text-warn" />}
              <span className="hidden sm:inline">{online ? "Sync now" : "Offline"}</span>
              {queueCount > 0 && <span className="badge border-warn/40 bg-warn/10 text-warn px-1.5">{queueCount}</span>}
            </button>
            <button className="btn-pine h-9" onClick={() => setNewTaskOpen(true)}>
              <Plus className="h-4 w-4" /><span className="hidden sm:inline">New Task</span>
            </button>
          </div>
        </div>
      </div>

      {/* Offline banner */}
      {!online && (
        <div className="panel border-warn/50 bg-warn/10 px-4 py-3 flex items-start gap-3">
          <CloudOff className="h-5 w-5 text-warn shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-warn">You&apos;re offline — changes are saved on this device and sync automatically.</p>
            <p className="text-xs text-warn/80 mt-0.5">{queueCount > 0 ? `${queueCount} change${queueCount === 1 ? "" : "s"} waiting to sync.` : "Signed in as " + (user?.name ?? "staff") + "."}</p>
          </div>
        </div>
      )}

      {/* Room status board */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Room Status Board</p>
          <div className="hidden md:flex items-center gap-3 text-[11px] text-muted-ink">
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" />Vacant</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-pine-700" />Occupied</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-warn" />Dirty</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-[#7ea08c]" />Clean</span>
            <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-danger" />O.O.O.</span>
          </div>
        </div>
        <div className="p-4 space-y-4">
          {board.floors.map((f) => (
            <div key={f.floor} className="flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="sm:w-20 shrink-0">
                <p className="font-display font-semibold text-pine">Floor {f.floor}</p>
                <p className="text-[11px] text-muted-ink">{f.rooms.length} rooms</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {f.rooms.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => { setRoomDialog(r); setOooOpen(false); setOooNote(""); }}
                    className={cn("relative h-11 w-12 rounded-md text-[12px] font-semibold transition hover:scale-105 active:scale-95 cursor-pointer", `tile-${r.status}`)}
                    title={`${r.roomTypeName} · ${STATUS_LABELS[r.status] || r.status}${r.currentGuest ? ` · ${r.currentGuest}` : ""}${r.note ? ` · ${r.note}` : ""}`}
                    aria-label={`Room ${r.number} — ${STATUS_LABELS[r.status] || r.status}`}
                  >
                    {r.number}
                    {r.currentGuest && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-white/90" />}
                    {r.activeTask && <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-white/70" />}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted-ink flex flex-wrap gap-x-4 gap-y-1">
          <span>Tap a room for quick actions</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-white border border-line-strong inline-block" /> guest in house</span>
          <span className="flex items-center gap-1"><span className="h-1.5 w-1.5 rounded-full bg-white/70 border border-line-strong inline-block" /> open task</span>
        </div>
      </div>

      {/* Task board */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Tasks</p>
          <span className="text-xs text-muted-ink hidden sm:inline">{allTasks.length} total</span>
        </div>
        <div className="px-4 pt-3">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full sm:w-auto flex-wrap h-9">
              {["pending", "in_progress", "completed", "all"].map((key) => (
                <TabsTrigger key={key} value={key} className="flex-1 sm:flex-none px-2.5 text-[12px]">
                  {key === "all" ? "All" : STATUS_LABELS[key]}
                  <span className="ml-1.5 text-[10px] rounded-full bg-plaster-deep px-1.5 py-0.5 text-muted-ink">{tabCount(key)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="p-4">
          {visibleTasks.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-ink">
              No {tab === "all" ? "" : STATUS_LABELS[tab]?.toLowerCase() + " "}tasks right now.
            </div>
          ) : (
            <>
              {/* Mobile: stacked cards */}
              <div className="space-y-3 sm:hidden">
                {visibleTasks.map((t) => (
                  <TaskCard key={t.id} task={t} staff={staff} assigneeName={assigneeName} onAssign={onAssign} onPatch={patchTask} />
                ))}
              </div>
              {/* Desktop: table */}
              <div className="hidden sm:block overflow-x-auto scroll-slim">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="th">Room</th>
                      <th className="th">Task</th>
                      <th className="th">Priority</th>
                      <th className="th">Assignee</th>
                      <th className="th">Due</th>
                      <th className="th">Status</th>
                      <th className="th w-[240px]">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleTasks.map((t) => (
                      <TaskRow key={t.id} task={t} staff={staff} assigneeName={assigneeName} onAssign={onAssign} onPatch={patchTask} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Room quick actions dialog */}
      <Dialog open={!!roomDialog} onOpenChange={(o) => { if (!o) setRoomDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-display">Room {roomDialog?.number}</DialogTitle>
            <DialogDescription>
              {roomDialog?.roomTypeName} · Floor {roomDialog?.floor} · {roomDialog ? STATUS_LABELS[roomDialog.status] || roomDialog.status : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {roomDialog?.currentGuest && (
              <p className="text-sm text-pine flex items-center gap-2"><UserRound className="h-4 w-4 text-brass shrink-0" /> In house: {roomDialog.currentGuest}</p>
            )}
            {roomDialog?.activeTask && (
              <div className="rounded-md border border-line bg-plaster/60 px-3 py-2 text-[13px]">
                <p className="font-medium text-pine">
                  Open task: {TASK_TYPE_META[roomDialog.activeTask.taskType]?.label ?? roomDialog.activeTask.taskType}
                </p>
                <p className="text-[11px] text-muted-ink">
                  {STATUS_LABELS[roomDialog.activeTask.status] || roomDialog.activeTask.status}
                  {roomDialog.activeTask.assignedToName ? ` · ${roomDialog.activeTask.assignedToName}` : " · unassigned"}
                </p>
              </div>
            )}
            {roomDialog?.note && <p className="text-xs text-muted-ink">Note: {roomDialog.note}</p>}
            <div className="grid grid-cols-2 gap-2">
              <button className="btn-outline h-11" onClick={() => roomDialog && setRoomStatus(roomDialog.id, "vacant", undefined, "Room marked clean & vacant")}>
                <Sparkles className="h-4 w-4" /> Mark Clean
              </button>
              <button className="btn-outline h-11" onClick={() => roomDialog && setRoomStatus(roomDialog.id, "dirty", undefined, "Room marked dirty")}>
                <BrushCleaning className="h-4 w-4" /> Mark Dirty
              </button>
              <button className="btn-outline h-11" onClick={() => roomDialog && setRoomStatus(roomDialog.id, "clean", undefined, "Room marked inspected")}>
                <ClipboardCheck className="h-4 w-4" /> Mark Inspected
              </button>
              <button className={cn("btn-outline h-11", oooOpen && "border-danger/50 text-danger")} onClick={() => setOooOpen((v) => !v)}>
                <Wrench className="h-4 w-4" /> Out of Order
              </button>
            </div>
            {oooOpen && (
              <div className="space-y-2">
                <input className="field" placeholder="Reason (e.g. AC compressor)" value={oooNote} onChange={(e) => setOooNote(e.target.value)} aria-label="Out of order reason" />
                <button className="btn-danger h-10 w-full" onClick={() => roomDialog && setRoomStatus(roomDialog.id, "out_of_order", oooNote, "Room set out of order")}>
                  <Wrench className="h-4 w-4" /> Set Out of Order
                </button>
              </div>
            )}
          </div>
          <DialogFooter className="sm:justify-center">
            <button
              className="btn-brass h-11 w-full"
              onClick={() => {
                if (!roomDialog) return;
                setForm((f) => ({ ...f, roomId: roomDialog.id }));
                setRoomDialog(null);
                setOooOpen(false);
                setOooNote("");
                setNewTaskOpen(true);
              }}
            >
              <Plus className="h-4 w-4" /> Create task for this room
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New task dialog */}
      <Dialog open={newTaskOpen} onOpenChange={(o) => { if (!o) setNewTaskOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">New Housekeeping Task</DialogTitle>
            <DialogDescription>Works offline too — it syncs automatically when you&apos;re back online.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="field-label">Room</label>
              <Select value={form.roomId} onValueChange={(v) => setForm((f) => ({ ...f, roomId: v }))}>
                <SelectTrigger className="w-full h-10"><SelectValue placeholder="Select a room" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  {allRooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.number} · Floor {r.floor} · {STATUS_LABELS[r.status] || r.status}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Task type</label>
                <Select value={form.taskType} onValueChange={(v) => setForm((f) => ({ ...f, taskType: v }))}>
                  <SelectTrigger className="w-full h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(TASK_TYPE_META).map(([k, m]) => (
                      <SelectItem key={k} value={k}>{m.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="field-label">Priority</label>
                <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v }))}>
                  <SelectTrigger className="w-full h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="field-label">Due</label>
                <input type="datetime-local" className="field h-10" value={form.dueAt} onChange={(e) => setForm((f) => ({ ...f, dueAt: e.target.value }))} />
              </div>
              <div>
                <label className="field-label">Assignee</label>
                <Select value={form.assignedTo} onValueChange={(v) => setForm((f) => ({ ...f, assignedTo: v }))}>
                  <SelectTrigger className="w-full h-10"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label className="field-label">Notes</label>
              <Textarea rows={2} className="bg-panel" placeholder="Optional instructions…" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <button className="btn-ghost h-11 flex-1 sm:flex-none" onClick={() => setNewTaskOpen(false)}>Cancel</button>
            <button className="btn-pine h-11 flex-1 sm:flex-none" disabled={saving} onClick={submitNewTask}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create Task
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Task subcomponents ──────────────────────────────────────────────────────

interface TaskItemProps {
  task: HkTask;
  staff: { id: string; name: string }[];
  assigneeName: (t: HkTask) => string;
  onAssign: (taskId: string, value: string) => void;
  onPatch: (task: HkTask, data: TaskPatch, label: string) => void;
}

function TypeIcon({ taskType, className }: { taskType: string; className?: string }) {
  const Meta = TASK_TYPE_META[taskType]?.icon ?? BrushCleaning;
  return <Meta className={className} />;
}

function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className={cn("badge", PRIORITY_BADGE[priority] || PRIORITY_BADGE.normal)}>
      {priority === "high" && "!"}{priority}
    </span>
  );
}

function DueCell({ task }: { task: HkTask }) {
  if (!task.dueAt) return <span className="text-muted-ink text-[13px]">—</span>;
  const overdue = task.status !== "completed" && new Date(task.dueAt).getTime() < Date.now();
  return (
    <span className={cn("text-[13px]", overdue ? "text-danger font-medium" : "text-ink")}>
      {fmtTime(task.dueAt)}{overdue ? " · overdue" : ""}
    </span>
  );
}

function TaskActions({ task, onPatch }: { task: HkTask; onPatch: TaskItemProps["onPatch"] }) {
  const cls = "h-9 flex-1 text-[13px]";
  if (task.status === "completed") {
    return (
      <div className="flex gap-2">
        <button className={cn("btn-outline", cls)} onClick={() => onPatch(task, { status: "pending" }, "Task reopened")}>
          <RotateCcw className="h-3.5 w-3.5" /> Reopen
        </button>
      </div>
    );
  }
  if (task.status === "blocked") {
    return (
      <div className="flex gap-2">
        <button className={cn("btn-outline", cls)} onClick={() => onPatch(task, { status: "in_progress" }, "Task resumed")}>
          <Play className="h-3.5 w-3.5" /> Resume
        </button>
        <button className={cn("btn-outline", cls)} onClick={() => onPatch(task, { status: "pending" }, "Task reopened")}>
          <RotateCcw className="h-3.5 w-3.5" /> Reopen
        </button>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      {task.status === "pending" && (
        <button className={cn("btn-pine", cls)} onClick={() => onPatch(task, { status: "in_progress" }, "Task started")}>
          <Play className="h-3.5 w-3.5" /> Start
        </button>
      )}
      <button className={cn("btn-outline", cls)} onClick={() => onPatch(task, { status: "completed" }, "Task completed")}>
        <Check className="h-3.5 w-3.5" /> Done
      </button>
      <button className={cn("btn-ghost", cls)} onClick={() => onPatch(task, { status: "blocked" }, "Task blocked")}>
        <Ban className="h-3.5 w-3.5" /> Block
      </button>
    </div>
  );
}

function AssigneeSelect({ task, staff, onAssign, className }: { task: HkTask; staff: TaskItemProps["staff"]; onAssign: TaskItemProps["onAssign"]; className?: string }) {
  return (
    <Select value={task.assignedTo ?? "none"} onValueChange={(v) => onAssign(task.id, v)}>
      <SelectTrigger className={cn("h-9 text-[13px]", className ?? "w-[150px]")} aria-label="Assignee">
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="none">Unassigned</SelectItem>
        {staff.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

function TaskRow({ task, staff, assigneeName, onAssign, onPatch }: TaskItemProps) {
  return (
    <tr className={cn("hover:bg-plaster/50", task.status === "completed" && "bg-ok/5")}>
      <td className="td">
        <div className="font-semibold text-pine">{task.room.number}</div>
        <div className="text-[11px] text-muted-ink">Floor {task.room.floor}</div>
      </td>
      <td className="td">
        <div className="flex items-center gap-2">
          <TypeIcon taskType={task.taskType} className="h-4 w-4 text-pine-700" />
          <span>{TASK_TYPE_META[task.taskType]?.label ?? task.taskType}</span>
        </div>
        {task.offline && <span className="badge border-warn/40 bg-warn/10 text-warn mt-1 ml-6">⇄ offline</span>}
      </td>
      <td className="td"><PriorityBadge priority={task.priority} /></td>
      <td className="td"><AssigneeSelect task={task} staff={staff} onAssign={onAssign} /></td>
      <td className="td"><DueCell task={task} /></td>
      <td className="td">
        {task.status === "completed" ? (
          <span className="text-[12px] text-ok">Done · {fmtTime(task.completedAt)}</span>
        ) : (
          <span className={cn("badge", TASK_STATUS_BADGE[task.status])}>{STATUS_LABELS[task.status] || task.status}</span>
        )}
      </td>
      <td className="td"><TaskActions task={task} onPatch={onPatch} /></td>
    </tr>
  );
}

function TaskCard({ task, staff, assigneeName, onAssign, onPatch }: TaskItemProps) {
  return (
    <div className={cn("panel p-3 space-y-2.5", task.status === "completed" && "bg-ok/5 border-ok/30")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-md bg-pine-100 flex items-center justify-center shrink-0">
            <TypeIcon taskType={task.taskType} className="h-5 w-5 text-pine-700" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-pine leading-tight">
              Room {task.room.number} <span className="text-muted-ink font-normal">· Floor {task.room.floor}</span>
            </p>
            <p className="text-[11px] text-muted-ink">{TASK_TYPE_META[task.taskType]?.label ?? task.taskType}</p>
          </div>
        </div>
        <PriorityBadge priority={task.priority} />
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-ink">
        <span>Due <DueCell task={task} /></span>
        <span className="flex items-center gap-1"><UserRound className="h-3 w-3" /> {assigneeName(task)}</span>
        {task.status === "completed" ? (
          <span className="badge border-ok/40 bg-ok/10 text-ok">Completed · {fmtTime(task.completedAt)}</span>
        ) : (
          <span className={cn("badge", TASK_STATUS_BADGE[task.status])}>{STATUS_LABELS[task.status] || task.status}</span>
        )}
        {task.offline && <span className="badge border-warn/40 bg-warn/10 text-warn">⇄ offline</span>}
      </div>
      {task.notes && <p className="text-xs text-muted-ink border-l-2 border-line pl-2">{task.notes}</p>}
      <AssigneeSelect task={task} staff={staff} onAssign={onAssign} className="w-full" />
      <TaskActions task={task} onPatch={onPatch} />
    </div>
  );
}
