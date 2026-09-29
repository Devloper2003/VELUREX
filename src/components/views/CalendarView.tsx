"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, toISODate, todayISO, STATUS_LABELS } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  ChevronLeft, ChevronRight, Loader2, CalendarDays, GripHorizontal, Trash2, Users,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const DAY_W = 58;   // minimum day-column width (columns stretch wider on big screens)
const ROW_H = 40;
const LABEL_W = 150;
const WINDOW_DAYS = 14;

interface CalRoom { id: string; number: string; floor: number; status: string; roomTypeId: string; roomTypeName: string; roomTypeCode: string }
interface CalRes {
  id: string; confirmationNumber: string; guestName: string; roomId: string | null; roomTypeId: string | null;
  checkIn: string; checkOut: string; status: string; nights: number; nightlyRate: number; totalAmount: number;
}
interface CalendarData { start: string; days: string[]; rooms: CalRoom[]; reservations: CalRes[] }
interface GuestLite { id: string; fullName: string; phone: string }

const BAR_COLOR: Record<string, string> = {
  confirmed: "bg-pine-700",
  checked_in: "bg-ok",
  hold: "bg-warn",
  checked_out: "bg-[#7ea08c]",
};

type Drag =
  | { mode: "create"; anchorDay: number; roomIdx: number; curDay: number; moved: boolean; startX: number; startY: number }
  | { mode: "move"; res: CalRes; grabOffset: number; span: number; startDay: number; roomIdx: number; curStartDay: number; curRoomIdx: number; moved: boolean; startX: number; startY: number };

/** Room ids already booked for [checkIn, checkOut), excluding one reservation. */
async function unavailableRoomIds(checkIn: string, checkOut: string, excludeId?: string): Promise<Set<string>> {
  const days = Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400000)) + 1;
  const data = await api<{ reservations: CalRes[] }>(`/api/calendar?start=${checkIn}&days=${days}`);
  const blocked = new Set<string>();
  for (const res of data.reservations) {
    if (excludeId && res.id === excludeId) continue;
    if (!res.roomId) continue;
    const ci = toISODate(new Date(res.checkIn));
    const co = toISODate(new Date(res.checkOut));
    if (ci < checkOut && co > checkIn) blocked.add(res.roomId);
  }
  return blocked;
}

function isWeekend(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.getDay() === 0 || d.getDay() === 6;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(iso: string) {
  // Explicit formatting (locale-independent). "day" is the bare number for the
  // large calendar digit; "date" is the padded "26 Sep" used in the toolbar range.
  const d = new Date(`${iso}T12:00:00`);
  return {
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()],
    day: d.getDate(),
    month: MONTHS_SHORT[d.getMonth()],
    date: `${String(d.getDate()).padStart(2, "0")} ${MONTHS_SHORT[d.getMonth()]}`,
  };
}

export default function CalendarView() {
  const { toast } = useToast();
  const [startDate, setStartDate] = useState(todayISO());
  const [data, setData] = useState<CalendarData | null>(null);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState("all");
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const rowGridRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Dialogs
  const [modifyRes, setModifyRes] = useState<CalRes | null>(null);
  const [createPrefill, setCreatePrefill] = useState<{ roomId: string; roomTypeId: string; checkIn: string; checkOut: string } | null>(null);
  const [cancelRes, setCancelRes] = useState<CalRes | null>(null);

  const setDragD = useCallback((d: Drag | null) => {
    dragRef.current = d;
    setDrag(d);
  }, []);

  const load = useCallback(async () => {
    try {
      setData(await api<CalendarData>(`/api/calendar?start=${startDate}&days=${WINDOW_DAYS}`));
    } catch (e) {
      toast({ title: "Could not load calendar", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [startDate, toast]);

  useEffect(() => { load(); }, [load]);

  const days = data?.days ?? [];

  /* Fluid day columns: stretch so the grid fills the panel edge-to-edge (no
     dead strip after the last day on wide screens). All drag/bar math derives
     from this value, so alignment is preserved at any width. */
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [dayW, setDayW] = useState(DAY_W);
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const measure = () => {
      const n = Math.max(1, data?.days.length || WINDOW_DAYS);
      // Exact float width → columns sum to precisely the panel width (no dead
      // strip after the last day). clientWidth already excludes borders.
      const avail = el.clientWidth - LABEL_W;
      setDayW(Math.max(DAY_W, avail / n));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [data]);
  const visibleRooms = useMemo(
    () => (data?.rooms ?? []).filter((r) => typeFilter === "all" || r.roomTypeId === typeFilter),
    [data, typeFilter]
  );
  const roomIdxById = useMemo(() => new Map(visibleRooms.map((r, i) => [r.id, i])), [visibleRooms]);

  /** Bar placement clamped to the visible window. */
  const barBoxes = useMemo(() => {
    const map = new Map<string, { startIdx: number; span: number }>();
    if (!data) return map;
    for (const res of data.reservations) {
      if (res.roomId === null || !roomIdxById.has(res.roomId)) continue;
      const ci = toISODate(new Date(res.checkIn));
      const co = toISODate(new Date(res.checkOut));
      let s = days.indexOf(ci);
      let e = days.indexOf(co);
      if (s === -1 && e === -1) {
        // Entire bar outside window on one side — derive from date math
        if (co <= days[0] || ci >= days[days.length - 1]) continue;
        s = 0; e = days.length;
      }
      if (s < 0) s = 0;
      if (e < 0 || e > days.length) e = days.length;
      if (e <= s) continue;
      map.set(res.id, { startIdx: s, span: e - s });
    }
    return map;
  }, [data, days, roomIdxById]);

  const dayFromClientX = useCallback((clientX: number): number => {
    if (!rowGridRef.current) return 0;
    const rect = rowGridRef.current.getBoundingClientRect();
    return Math.floor((clientX - rect.left) / dayW);
  }, [dayW]);

  const roomIdxFromClientY = useCallback((clientY: number): number => {
    if (!bodyRef.current) return 0;
    const rect = bodyRef.current.getBoundingClientRect();
    return Math.max(0, Math.min(visibleRooms.length - 1, Math.floor((clientY - rect.top) / ROW_H)));
  }, [visibleRooms.length]);

  /* ── Global pointer listeners while dragging ─────────────────── */
  const dragMode = drag?.mode ?? null;
  useEffect(() => {
    if (!dragMode) return;

    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      if (!d) return;
      const moved = d.moved || Math.abs(e.clientX - d.startX) > 5 || Math.abs(e.clientY - d.startY) > 5;
      const day = dayFromClientX(e.clientX);
      if (d.mode === "create") {
        setDragD({ ...d, curDay: Math.max(0, Math.min(days.length - 1, day)), moved });
      } else {
        // Snap vertically to the nearest row of the same room type.
        let roomIdx = roomIdxFromClientY(e.clientY);
        if (visibleRooms[roomIdx]?.roomTypeId !== d.res.roomTypeId) {
          let best = -1;
          let bestDist = Infinity;
          visibleRooms.forEach((r, i) => {
            if (r.roomTypeId !== d.res.roomTypeId) return;
            const dist = Math.abs(i - roomIdx);
            if (dist < bestDist) { bestDist = dist; best = i; }
          });
          if (best >= 0) roomIdx = best;
        }
        const clamped = Math.max(0, Math.min(days.length - d.span, day - d.grabOffset));
        setDragD({ ...d, curStartDay: clamped, curRoomIdx: roomIdx, moved });
      }
    }

    function onUp(e: PointerEvent) {
      const d = dragRef.current;
      setDragD(null);
      if (!d) return;
      if (d.mode === "create") {
        const lo = Math.min(d.anchorDay, d.curDay);
        const hi = Math.max(d.anchorDay, d.curDay);
        // Ignore plain clicks on cells — require a real drag (≥6px or spanning a day).
        if (hi === lo && !d.moved) return;
        const room = visibleRooms[d.roomIdx];
        if (!room) return;
        setCreatePrefill({
          roomId: room.id,
          roomTypeId: room.roomTypeId,
          checkIn: days[lo],
          checkOut: addISODays(days[hi], 1),
        });
      } else {
        if (!d.moved) {
          setModifyRes(d.res);
          return;
        }
        const room = visibleRooms[d.curRoomIdx];
        const newCheckIn = days[d.curStartDay];
        const newCheckOut = addISODays(newCheckIn, d.span);
        const unchanged = d.res.roomId === room?.id && toISODate(new Date(d.res.checkIn)) === newCheckIn;
        if (unchanged || !room) return;
        moveReservation(d.res, { roomId: room.id, checkIn: newCheckIn, checkOut: newCheckOut });
      }
    }

    function onCancel() { setDragD(null); }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    };
  }, [dragMode, days, visibleRooms, dayFromClientX, roomIdxFromClientY, setDragD]);

  function addISODays(iso: string, n: number): string {
    const d = new Date(`${iso}T12:00:00`);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  }

  /** Optimistic move with rollback. */
  async function moveReservation(res: CalRes, patch: { roomId: string; checkIn: string; checkOut: string }) {
    const prev = data;
    if (!data) return;
    const nights = Math.max(1, Math.round((new Date(patch.checkOut).getTime() - new Date(patch.checkIn).getTime()) / 86400000));
    setData({
      ...data,
      reservations: data.reservations.map((r) =>
        r.id === res.id ? { ...r, roomId: patch.roomId, checkIn: `${patch.checkIn}T00:00:00`, checkOut: `${patch.checkOut}T00:00:00`, nights } : r
      ),
    });
    try {
      await api(`/api/reservations/${res.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      toast({ title: "Reservation moved", description: `${res.guestName} → ${patch.checkIn} → ${patch.checkOut}` });
      load();
    } catch (e) {
      if (prev) setData(prev);
      toast({ title: "Move failed — reverted", description: (e as Error).message, variant: "destructive" });
      load();
    }
  }

  function startCreate(e: React.PointerEvent<HTMLDivElement>, roomIdx: number) {
    if (e.button !== 0) return;
    const day = Math.max(0, Math.min(days.length - 1, dayFromClientX(e.clientX)));
    setDragD({ mode: "create", anchorDay: day, roomIdx, curDay: day, moved: false, startX: e.clientX, startY: e.clientY });
  }

  function startMove(e: React.PointerEvent<HTMLDivElement>, res: CalRes) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const box = barBoxes.get(res.id);
    if (!box) return;
    const grabOffset = Math.max(0, dayFromClientX(e.clientX) - box.startIdx);
    const roomIdx = roomIdxById.get(res.roomId ?? "") ?? 0;
    setDragD({
      mode: "move", res, grabOffset, span: box.span, startDay: box.startIdx, roomIdx,
      curStartDay: box.startIdx, curRoomIdx: roomIdx, moved: false,
      startX: e.clientX, startY: e.clientY,
    });
  }

  function shiftDate(n: number) {
    setStartDate((s) => addISODays(s, n));
  }

  const todayIdx = days.indexOf(todayISO());
  const typeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    (data?.rooms ?? []).forEach((r) => seen.set(r.roomTypeId, r.roomTypeName));
    return [...seen.entries()];
  }, [data]);

  // Ghost geometry
  const createGhost = drag?.mode === "create"
    ? { roomIdx: drag.roomIdx, lo: Math.min(drag.anchorDay, drag.curDay), hi: Math.max(drag.anchorDay, drag.curDay) }
    : null;
  const moveGhost = drag?.mode === "move" && drag.moved
    ? { roomIdx: drag.curRoomIdx, startIdx: drag.curStartDay, span: drag.span }
    : null;

  if (loading && !data) {
    return (
      <div className="panel p-6 space-y-3">
        {[...Array(8)].map((_, i) => <div key={i} className="skeleton h-9 rounded" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel px-4 py-3 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button className="btn-outline px-2" onClick={() => shiftDate(-7)} aria-label="Previous week"><ChevronLeft className="h-4 w-4" /></button>
          <button className="btn-outline px-3" onClick={() => setStartDate(todayISO())}>Today</button>
          <button className="btn-outline px-2" onClick={() => shiftDate(7)} aria-label="Next week"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <span className="text-[13px] text-muted-ink hidden sm:block">
          {days[0] && dayLabel(days[0]).date} — {days[days.length - 1] && dayLabel(days[days.length - 1]).date} · drag on empty cells to book, drag bars to reschedule
        </span>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[170px] ml-auto"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All room types</SelectItem>
            {typeOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      {/* Gantt grid */}
      <div className="panel" ref={panelRef}>
        <div className="panel-header">
          <p className="panel-title">Availability — 14 Days</p>
          <div className="hidden md:flex items-center gap-3 text-[11px] text-muted-ink">
            <Legend color="#1f4b43" label="Confirmed" />
            <Legend color="#4c7a5a" label="Checked In" />
            <Legend color="#c08a2e" label="Hold" />
            <Legend color="#7ea08c" label="Checked Out" />
          </div>
        </div>
        <div className="overflow-x-auto scroll-slim">
          <div className="min-w-max select-none">
            {/* Day header */}
            <div className="flex border-b border-line bg-plaster/60">
              <div className="sticky left-0 z-30 shrink-0 bg-panel border-r border-line flex items-center px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-ink" style={{ width: LABEL_W }}>
                <CalendarDays className="h-3.5 w-3.5 mr-1.5 text-brass" /> Room
              </div>
              {days.map((d) => {
                const l = dayLabel(d);
                const isToday = d === todayISO();
                return (
                  <div
                    key={d}
                    className={cn(
                      "shrink-0 flex items-center justify-center gap-1.5 py-3 border-r border-line/40",
                      isWeekend(d) && "bg-brass-50/70",
                      isToday && "bg-pine-100/80"
                    )}
                    style={{ width: dayW }}
                    aria-label={`${l.weekday} ${l.day} ${l.month}`}
                  >
                    <span className={cn("text-[19px] font-semibold leading-none tabular-nums", isToday ? "text-pine" : "text-ink")}>
                      {l.day}
                    </span>
                    <span className="flex flex-col items-start gap-[3px] leading-none">
                      <span className={cn("text-[9px] font-semibold uppercase tracking-[0.08em]", isToday ? "text-pine" : "text-muted-ink")}>
                        {l.weekday}
                      </span>
                      <span className="text-[9px] text-muted-ink/70 leading-none">{l.month}</span>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Body */}
            <div className="relative" ref={bodyRef}>
              {visibleRooms.map((room, idx) => (
                <div key={room.id} className="flex" style={{ height: ROW_H }}>
                  <div className="sticky left-0 z-20 shrink-0 bg-panel border-r border-b border-line flex flex-col justify-center px-3" style={{ width: LABEL_W }}>
                    <p className="text-[13px] font-semibold text-pine leading-none">{room.number}</p>
                    <p className="text-[10px] text-muted-ink leading-tight mt-0.5">F{room.floor} · {room.roomTypeCode}</p>
                  </div>
                  <div
                    ref={idx === 0 ? rowGridRef : undefined}
                    className="relative flex-1 border-b border-line/50"
                    style={{ touchAction: "pan-x" }}
                    onPointerDown={(e) => startCreate(e, idx)}
                  >
                    {/* Day cells */}
                    {days.map((d, i) => (
                      <div
                        key={d}
                        className={cn("absolute top-0 bottom-0 border-r border-line/30", isWeekend(d) && "bg-brass-50/40")}
                        style={{ left: i * dayW, width: dayW }}
                      />
                    ))}
                    {/* Bars */}
                    {data?.reservations.map((res) => {
                      const box = barBoxes.get(res.id);
                      if (!box || res.roomId !== room.id) return null;
                      const dragging = drag?.mode === "move" && drag.res.id === res.id && drag.moved;
                      return (
                        <div
                          key={res.id}
                          className={cn(
                            "cal-bar absolute rounded-md cursor-grab active:cursor-grabbing flex items-center px-1.5 overflow-hidden",
                            BAR_COLOR[res.status] ?? "bg-pine-600",
                            dragging && "opacity-30"
                          )}
                          style={{
                            left: box.startIdx * dayW + 2,
                            width: box.span * dayW - 4,
                            top: 4,
                            height: ROW_H - 12,
                            touchAction: "none",
                            zIndex: 10,
                          }}
                          title={`${res.guestName} · ${res.confirmationNumber} · ${STATUS_LABELS[res.status]}`}
                          onPointerDown={(e) => startMove(e, res)}
                        >
                          <span className="text-[11px] font-medium text-white truncate pointer-events-none">
                            {res.guestName} · {res.nights}N
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}

              {visibleRooms.length === 0 && (
                <div className="py-10 text-center text-sm text-muted-ink">No rooms match this filter.</div>
              )}

              {/* Today marker */}
              {todayIdx >= 0 && (
                <div
                  className="absolute top-0 bottom-0 border-l-2 border-dashed border-brass pointer-events-none"
                  style={{ left: LABEL_W + todayIdx * dayW + dayW / 2, zIndex: 15 }}
                />
              )}

              {/* Create ghost */}
              {createGhost && visibleRooms[createGhost.roomIdx] && (
                <div
                  className="absolute rounded-md border-2 border-dashed border-brass bg-brass/20 flex items-center justify-center pointer-events-none"
                  style={{
                    left: LABEL_W + createGhost.lo * dayW + 2,
                    width: (createGhost.hi - createGhost.lo + 1) * dayW - 4,
                    top: createGhost.roomIdx * ROW_H + 4,
                    height: ROW_H - 12,
                    zIndex: 25,
                  }}
                >
                  <span className="text-[10px] font-semibold text-brass">
                    {createGhost.hi - createGhost.lo + 1}N · {visibleRooms[createGhost.roomIdx].number}
                  </span>
                </div>
              )}

              {/* Move ghost */}
              {moveGhost && (
                <div
                  className={cn("absolute rounded-md opacity-70 pointer-events-none flex items-center px-1.5", BAR_COLOR[drag?.mode === "move" ? drag.res.status : ""] ?? "bg-pine-600")}
                  style={{
                    left: LABEL_W + moveGhost.startIdx * dayW + 2,
                    width: moveGhost.span * dayW - 4,
                    top: moveGhost.roomIdx * ROW_H + 4,
                    height: ROW_H - 12,
                    zIndex: 25,
                  }}
                >
                  <GripHorizontal className="h-3 w-3 text-white/80 shrink-0" />
                  <span className="text-[11px] font-medium text-white truncate">{drag?.mode === "move" ? drag.res.guestName : ""}</span>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="border-t border-line px-4 py-2 flex md:hidden flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-ink">
          <Legend color="#1f4b43" label="Confirmed" />
          <Legend color="#4c7a5a" label="Checked In" />
          <Legend color="#c08a2e" label="Hold" />
          <Legend color="#7ea08c" label="Checked Out" />
        </div>
      </div>

      {/* Dialogs */}
      {modifyRes && (
        <ModifyCalendarDialog
          res={modifyRes}
          rooms={data?.rooms ?? []}
          onOpenChange={(o) => !o && setModifyRes(null)}
          onSaved={() => { setModifyRes(null); load(); }}
          onCancelClick={() => setCancelRes(modifyRes)}
        />
      )}
      {createPrefill && (
        <CreateFromGridDialog
          prefill={createPrefill}
          room={data?.rooms.find((r) => r.id === createPrefill.roomId)}
          onOpenChange={(o) => !o && setCreatePrefill(null)}
          onCreated={() => { setCreatePrefill(null); load(); }}
        />
      )}

      <AlertDialog open={!!cancelRes} onOpenChange={(o) => !o && setCancelRes(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel {cancelRes?.confirmationNumber}?</AlertDialogTitle>
            <AlertDialogDescription>
              {cancelRes?.guestName}&apos;s stay will be cancelled and the room block released.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-outline h-9">Keep</AlertDialogCancel>
            <AlertDialogAction
              className="btn-danger"
              onClick={async () => {
                if (!cancelRes) return;
                try {
                  await api(`/api/reservations/${cancelRes.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
                  toast({ title: "Reservation cancelled", description: cancelRes.confirmationNumber });
                  setModifyRes(null);
                  setCancelRes(null);
                  load();
                } catch (e) {
                  toast({ title: "Could not cancel", description: (e as Error).message, variant: "destructive" });
                }
              }}
            >
              <Trash2 className="h-4 w-4" /> Cancel Reservation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

/* ─────────────── Modify dialog (from bar click) ─────────────── */

function ModifyCalendarDialog({ res, rooms, onOpenChange, onSaved, onCancelClick }: {
  res: CalRes;
  rooms: CalRoom[];
  onOpenChange: (o: boolean) => void;
  onSaved: () => void;
  onCancelClick: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [blocked, setBlocked] = useState<Set<string>>(new Set());
  const [form, setForm] = useState({
    checkIn: toISODate(new Date(res.checkIn)),
    checkOut: toISODate(new Date(res.checkOut)),
    roomId: res.roomId ?? "",
    nightlyRate: String(res.nightlyRate),
  });

  const checkIn = form.checkIn;
  const checkOut = form.checkOut;
  useEffect(() => {
    if (checkOut <= checkIn) return;
    let stale = false;
    unavailableRoomIds(checkIn, checkOut, res.id).then((s) => { if (!stale) setBlocked(s); }).catch(() => {});
    return () => { stale = true; };
  }, [checkIn, checkOut, res.id]);

  const sameTypeRooms = rooms.filter((r) => r.roomTypeId === res.roomTypeId);
  const nights = Math.max(1, Math.round((new Date(form.checkOut).getTime() - new Date(form.checkIn).getTime()) / 86400000));

  async function save() {
    setSaving(true);
    try {
      await api(`/api/reservations/${res.id}`, {
        method: "PATCH",
        body: JSON.stringify({ checkIn: form.checkIn, checkOut: form.checkOut, roomId: form.roomId, nightlyRate: Number(form.nightlyRate) }),
      });
      toast({ title: "Reservation updated", description: `${res.guestName} · ${form.checkIn} → ${form.checkOut}` });
      onSaved();
    } catch (e) {
      toast({ title: "Update failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">{res.guestName}</DialogTitle>
          <DialogDescription>
            {res.confirmationNumber} · {STATUS_LABELS[res.status] ?? res.status} · {inr(res.nightlyRate)}/night
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="field-label">Check-in</label>
            <input className="field" type="date" value={form.checkIn} onChange={(e) => setForm({ ...form, checkIn: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Check-out</label>
            <input className="field" type="date" min={addDaysISO(form.checkIn, 1)} value={form.checkOut} onChange={(e) => setForm({ ...form, checkOut: e.target.value })} />
          </div>
          <div className="col-span-2">
            <label className="field-label">Room — same type ({nights} night{nights === 1 ? "" : "s"})</label>
            <Select value={form.roomId} onValueChange={(v) => setForm({ ...form, roomId: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {sameTypeRooms.map((r) => (
                  <SelectItem key={r.id} value={r.id} disabled={blocked.has(r.id) && r.id !== res.roomId}>
                    {r.number} {blocked.has(r.id) && r.id !== res.roomId ? "· taken" : `· Floor ${r.floor}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-2">
            <label className="field-label">Rate / night (₹)</label>
            <input className="field" type="number" min={0} value={form.nightlyRate} onChange={(e) => setForm({ ...form, nightlyRate: e.target.value })} />
          </div>
        </div>
        <DialogFooter className="sm:justify-between">
          <button className="btn-ghost text-danger hover:bg-danger/10" onClick={onCancelClick}><Trash2 className="h-3.5 w-3.5" /> Cancel Reservation</button>
          <div className="flex gap-2">
            <button className="btn-outline" onClick={() => onOpenChange(false)}>Close</button>
            <button className="btn-pine" onClick={save} disabled={saving || form.checkOut <= form.checkIn || !form.roomId}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} Save
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function addDaysISO(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

/* ─────────────── Create dialog (from grid drag) ─────────────── */

function CreateFromGridDialog({ prefill, room, onOpenChange, onCreated }: {
  prefill: { roomId: string; roomTypeId: string; checkIn: string; checkOut: string };
  room?: CalRoom;
  onOpenChange: (o: boolean) => void;
  onCreated: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [guests, setGuests] = useState<GuestLite[]>([]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [guestQuery, setGuestQuery] = useState("");
  const [guestId, setGuestId] = useState("");
  const [form, setForm] = useState({
    fullName: "", phone: "", adults: "1", children: "0",
    nightlyRate: "", status: "confirmed", notes: "",
  });

  useEffect(() => {
    api<{ guests: GuestLite[] }>("/api/guests").then((d) => setGuests(d.guests)).catch(() => {});
    api<{ roomTypes: { id: string; baseRate: number }[] }>("/api/room-types")
      .then((d) => {
        const rt = d.roomTypes.find((t) => t.id === prefill.roomTypeId);
        if (rt) setForm((f) => ({ ...f, nightlyRate: f.nightlyRate || String(rt.baseRate) }));
      })
      .catch(() => {});
  }, [prefill.roomTypeId]);

  const nights = Math.max(1, Math.round((new Date(prefill.checkOut).getTime() - new Date(prefill.checkIn).getTime()) / 86400000));
  const total = nights * (Number(form.nightlyRate) || 0);

  const filteredGuests = useMemo(() => {
    const q = guestQuery.toLowerCase();
    return guests.filter((g) => g.fullName.toLowerCase().includes(q) || g.phone.includes(q)).slice(0, 30);
  }, [guests, guestQuery]);

  async function submit() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        roomId: prefill.roomId,
        roomTypeId: prefill.roomTypeId,
        checkIn: prefill.checkIn,
        checkOut: prefill.checkOut,
        adults: Number(form.adults) || 1,
        children: Number(form.children) || 0,
        nightlyRate: Number(form.nightlyRate),
        status: form.status,
        notes: form.notes,
        source: "front_desk",
      };
      if (mode === "existing") {
        if (!guestId) throw new Error("Select a guest or switch to New Guest");
        payload.guestId = guestId;
      } else {
        if (!form.fullName.trim() || !form.phone.trim()) throw new Error("Guest name and phone are required");
        payload.guest = { fullName: form.fullName.trim(), phone: form.phone.trim() };
      }
      const data = await api<{ reservation: { confirmationNumber: string; guest: { fullName: string } } }>("/api/reservations", {
        method: "POST", body: JSON.stringify(payload),
      });
      toast({ title: `Booked ${data.reservation.confirmationNumber}`, description: `${data.reservation.guest.fullName} · room ${room?.number ?? ""} · ${nights}N · ${inr(total)}` });
      onCreated();
    } catch (e) {
      toast({ title: "Could not create booking", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto scroll-slim">
        <DialogHeader>
          <DialogTitle className="font-display text-pine">New Booking — Room {room?.number}</DialogTitle>
          <DialogDescription>
            {prefill.checkIn} → {prefill.checkOut} · {nights} night{nights === 1 ? "" : "s"} · {room?.roomTypeName}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {(["existing", "new"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                "badge cursor-pointer px-3 py-1.5 transition",
                mode === m ? "border-pine-700 bg-pine-700 text-panel" : "border-line-strong bg-panel text-muted-ink hover:border-brass hover:text-brass"
              )}
            >
              {m === "existing" ? "Existing Guest" : "New Guest"}
            </button>
          ))}
        </div>

        {mode === "existing" ? (
          <div className="space-y-2">
            <input className="field" placeholder="Search by name or phone…" value={guestQuery} onChange={(e) => setGuestQuery(e.target.value)} />
            <div className="max-h-32 overflow-y-auto scroll-slim rounded-md border border-line divide-y divide-line/60">
              {filteredGuests.map((g) => (
                <button
                  key={g.id}
                  onClick={() => setGuestId(g.id)}
                  className={cn(
                    "w-full flex items-center justify-between px-3 py-2 text-left text-[13px] transition",
                    guestId === g.id ? "bg-pine-100 text-pine-700 font-medium" : "hover:bg-plaster/70"
                  )}
                >
                  <span>{g.fullName}</span>
                  <span className="text-[11px] text-muted-ink">{g.phone}</span>
                </button>
              ))}
              {filteredGuests.length === 0 && <div className="px-3 py-3 text-[13px] text-muted-ink text-center">No matches — use “New Guest”.</div>}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Full Name *</label>
              <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Phone *</label>
              <input className="field" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
          </div>
        )}

        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="field-label">Adults</label>
            <input className="field" type="number" min={1} value={form.adults} onChange={(e) => setForm({ ...form, adults: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Children</label>
            <input className="field" type="number" min={0} value={form.children} onChange={(e) => setForm({ ...form, children: e.target.value })} />
          </div>
          <div>
            <label className="field-label">Rate (₹)</label>
            <input className="field" type="number" min={0} value={form.nightlyRate} onChange={(e) => setForm({ ...form, nightlyRate: e.target.value })} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <label className="field-label">Status</label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="confirmed">Confirmed</SelectItem>
                <SelectItem value="hold">Hold</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="flex items-center gap-1 font-display text-lg font-semibold text-pine justify-end pb-1.5">
            <Users className="h-3.5 w-3.5 text-brass" /> {inr(total)}
          </p>
        </div>

        <DialogFooter>
          <button className="btn-outline" onClick={() => onOpenChange(false)}>Cancel</button>
          <button
            className="btn-pine"
            onClick={submit}
            disabled={saving || (mode === "existing" ? !guestId : !form.fullName.trim() || !form.phone.trim()) || !(Number(form.nightlyRate) > 0)}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />} Create Booking
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
