"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check, AlertTriangle, Loader2, RotateCcw, X,
  Grid3X3, Lock, LockOpen, Layers, RefreshCw, Wifi, Info, IndianRupee, Keyboard,
} from "lucide-react";
import { api, qs } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/* ─── Types mirroring /api/channel-inventory ─────────────────────────────── */

interface GridCell {
  inventoryId: string;
  date: string;
  availableCount: number;
  capacity: number;
  isOpen: boolean;
  rate: number;
  rateOverride: boolean;
  pending: number;
  failed: number;
}
interface GridRow {
  roomTypeId: string;
  name: string;
  code: string;
  capacity: number;
  cells: GridCell[];
}
interface GridPayload {
  dates: string[];
  rows: GridRow[];
  summary: {
    totalRooms: number; openToday: number; closedToday: number;
    syncing: number; failed: number; channelsConnected: number; channelsActive: number;
  };
}

interface JobRow {
  id: string; channel: string; action: string; status: string;
  attempts: number; lastError: string; createdAt: string; channelActive: boolean;
}

const RANGE_OPTIONS = [30, 60, 90] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const parseISO = (s: string) => new Date(`${s}T12:00:00`);
const dow = (s: string) => parseISO(s).getDay();
const dayNum = (s: string) => parseISO(s).getDate();
const isWeekend = (s: string) => { const d = dow(s); return d === 0 || d === 6; };
const money = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default function InventoryControlView() {
  const { toast } = useToast();
  const [days, setDays] = useState<30 | 60 | 90>(30);
  const [tab, setTab] = useState<"inventory" | "rate">("inventory");
  const [grid, setGrid] = useState<GridPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCell, setSavingCell] = useState<string | null>(null); // `${rt}|${date}` while POSTing
  const [rateEdit, setRateEdit] = useState<{ rt: string; date: string; value: string } | null>(null);
  const [countEdit, setCountEdit] = useState<{ rt: string; date: string; value: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkCount, setBulkCount] = useState("");
  const [jobsCell, setJobsCell] = useState<{ cell: GridCell; roomTypeName: string; jobs: JobRow[]; loading: boolean } | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const draggingRef = useRef(false);
  const movedRef = useRef(false);
  const anchorRef = useRef<{ r: number; c: number } | null>(null);
  const pollRef = useRef<number | null>(null);
  // Single-click toggles are debounced briefly so a double-click (count
  // editor) can supersede the open/close flip that the first click schedules.
  const pendingToggleRef = useRef<{ rt: string; date: string; timer: number } | null>(null);

  const cellKey = (rt: string, date: string) => `${rt}|${date}`;

  /* ── Data loading ──────────────────────────────────────────────────── */
  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const data = await api<GridPayload>(`/api/channel-inventory${qs({ days })}`);
      setGrid(data);
    } catch (e) {
      if (showSpinner) toast({ title: "Could not load inventory", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [days, toast]);

  useEffect(() => { load(true); }, [load]);

  // Async queue maintenance: worker tick every 2.5s + grid refresh every 5s.
  useEffect(() => {
    const tick = async () => {
      try { await api("/api/channels/worker", { method: "POST" }); } catch { /* offline */ }
    };
    tick();
    pollRef.current = window.setInterval(() => {
      void tick();
      void load(false);
    }, 5000);
    return () => { if (pollRef.current) window.clearInterval(pollRef.current); };
  }, [load]);

  /* ── Derived helpers ───────────────────────────────────────────────── */
  const rowIndex = useMemo(() => new Map((grid?.rows ?? []).map((r, i) => [r.roomTypeId, i])), [grid]);
  const todayISO = useMemo(() => grid?.dates[0] ?? "", [grid]);

  const cellState = (cell: GridCell): "open" | "low" | "soldout" | "closed" => {
    if (!cell.isOpen) return "closed";
    if (cell.availableCount === 0) return "soldout";
    if (cell.capacity > 0 && cell.availableCount / cell.capacity <= 0.25) return "low";
    return "open";
  };

  // Excel-style month band: contiguous runs of the same month get one cell.
  const monthBands = useMemo(() => {
    if (!grid) return [] as { label: string; short: string; span: number }[];
    const bands: { label: string; short: string; span: number }[] = [];
    for (const d of grid.dates) {
      const dt = parseISO(d);
      const label = `${MONTHS_FULL[dt.getMonth()]} ${dt.getFullYear()}`;
      const last = bands[bands.length - 1];
      if (last && last.label === label) last.span++;
      else bands.push({ label, short: `${MONTHS[dt.getMonth()]} ${String(dt.getFullYear()).slice(-2)}`, span: 1 });
    }
    return bands;
  }, [grid]);

  /* ── Selection (drag rectangle across the grid) ────────────────────── */
  const startDrag = (r: number, c: number) => {
    if (!grid) return;
    draggingRef.current = true;
    movedRef.current = false;
    anchorRef.current = { r, c };
    const row = grid.rows[r];
    if (!row) return;
    setSelected(new Set([cellKey(row.roomTypeId, grid.dates[c])]));
  };
  const extendDrag = (r: number, c: number) => {
    if (!draggingRef.current || !anchorRef.current || !grid) return;
    movedRef.current = true;
    const a = anchorRef.current;
    const r1 = Math.min(a.r, r), r2 = Math.max(a.r, r);
    const c1 = Math.min(a.c, c), c2 = Math.max(a.c, c);
    const next = new Set<string>();
    for (let ri = r1; ri <= r2; ri++) {
      const row = grid.rows[ri];
      if (!row) continue;
      for (let ci = c1; ci <= c2; ci++) next.add(cellKey(row.roomTypeId, grid.dates[ci]));
    }
    setSelected(next);
  };
  // Mouseup: no movement over a single cell → schedule an open/close toggle
  // (~280ms, cancelled by a double-click that opens the count editor);
  // a real drag keeps the rectangle selection for the bulk toolbar.
  const gridRef = useRef<GridPayload | null>(null);
  gridRef.current = grid;
  const toggleRef = useRef<(rt: string, date: string) => void>(() => {});
  const cancelPendingToggle = () => {
    if (pendingToggleRef.current) {
      window.clearTimeout(pendingToggleRef.current.timer);
      pendingToggleRef.current = null;
    }
  };
  useEffect(() => {
    const up = () => {
      if (draggingRef.current && !movedRef.current && anchorRef.current && gridRef.current) {
        const { r, c } = anchorRef.current;
        const row = gridRef.current.rows[r];
        if (row) {
          const rt = row.roomTypeId;
          const date = gridRef.current.dates[c];
          cancelPendingToggle();
          const timer = window.setTimeout(() => {
            pendingToggleRef.current = null;
            toggleRef.current(rt, date);
          }, 280);
          pendingToggleRef.current = { rt, date, timer };
        }
        setSelected(new Set());
      }
      draggingRef.current = false;
      anchorRef.current = null;
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const clearSelection = () => setSelected(new Set());

  /* ── Mutations ─────────────────────────────────────────────────────── */
  const toggleCell = async (rt: string, date: string) => {
    const key = cellKey(rt, date);
    setSavingCell(key);
    try {
      const res = await api<{ cells: { isOpen: boolean }[]; queued: number }>("/api/channel-inventory", {
        method: "POST",
        body: JSON.stringify({ mode: "toggle", roomTypeId: rt, date }),
      });
      toast({
        title: res.cells[0]?.isOpen ? "Dates opened" : "Dates closed",
        description: `${res.queued} channel push${res.queued === 1 ? "" : "es"} queued — sync runs in background.`,
      });
      await load(false);
    } catch (e) {
      toast({ title: "Toggle failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSavingCell(null);
    }
  };
  toggleRef.current = (rt, date) => { void toggleCell(rt, date); };

  const applyBulk = async (isOpen: boolean) => {
    if (selected.size === 0 || !grid) return;
    const rts = [...new Set([...selected].map((k) => k.split("|")[0]))];
    const dates = [...selected].map((k) => k.split("|")[1]).sort();
    setBulkBusy(true);
    try {
      const res = await api<{ queued: number; cells: unknown[] }>("/api/channel-inventory", {
        method: "POST",
        body: JSON.stringify({
          mode: "bulk", roomTypeIds: rts, dateFrom: dates[0], dateTo: dates[dates.length - 1], isOpen,
        }),
      });
      toast({
        title: `Bulk ${isOpen ? "open" : "close"} applied`,
        description: `${res.cells.length} room-type-days updated · ${res.queued} channel pushes queued.`,
      });
      clearSelection();
      await load(false);
    } catch (e) {
      toast({ title: "Bulk action failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const applyBulkCount = async () => {
    if (selected.size === 0 || !grid) return;
    const v = Number(bulkCount);
    if (!Number.isInteger(v) || v < 0) {
      toast({ title: "Enter a whole number of rooms", variant: "destructive" });
      return;
    }
    const rts = [...new Set([...selected].map((k) => k.split("|")[0]))];
    const dates = [...selected].map((k) => k.split("|")[1]).sort();
    setBulkBusy(true);
    try {
      const res = await api<{ queued: number; cells: unknown[] }>("/api/channel-inventory", {
        method: "POST",
        body: JSON.stringify({
          mode: "bulk-count", roomTypeIds: rts, dateFrom: dates[0], dateTo: dates[dates.length - 1], availableCount: v,
        }),
      });
      toast({
        title: `Availability set to ${v}`,
        description: `${res.cells.length} room-type-days updated (clamped to each type's capacity) · ${res.queued} channel pushes queued.`,
      });
      setBulkCount("");
      clearSelection();
      await load(false);
    } catch (e) {
      toast({ title: "Bulk count failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setBulkBusy(false);
    }
  };

  const saveRate = async (rt: string, date: string, value: number) => {
    const key = cellKey(rt, date);
    setSavingCell(key);
    setRateEdit(null);
    try {
      const res = await api<{ queued: number }>("/api/channel-inventory", {
        method: "POST",
        body: JSON.stringify({ mode: "rate", roomTypeId: rt, date, rate: value }),
      });
      toast({ title: "Rate updated", description: `Pushed to channels — ${res.queued} job${res.queued === 1 ? "" : "s"} queued.` });
      await load(false);
    } catch (e) {
      toast({ title: "Rate update failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSavingCell(null);
    }
  };

  const saveCount = async (rt: string, date: string, value: number) => {
    const key = cellKey(rt, date);
    setSavingCell(key);
    setCountEdit(null);
    try {
      const res = await api<{ queued: number }>("/api/channel-inventory", {
        method: "POST",
        body: JSON.stringify({ mode: "count", roomTypeId: rt, date, availableCount: value }),
      });
      toast({ title: "Availability updated", description: `${value} rooms sellable — ${res.queued} channel push${res.queued === 1 ? "" : "es"} queued.` });
      await load(false);
    } catch (e) {
      toast({ title: "Availability update failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    } finally {
      setSavingCell(null);
    }
  };

  const retryJob = async (jobId: string) => {
    try {
      await api("/api/channel-inventory", { method: "PUT", body: JSON.stringify({ jobId }) });
      toast({ title: "Re-queued", description: "The push will retry in a few seconds." });
      if (jobsCell) setJobsCell({ ...jobsCell, loading: true });
    } catch (e) {
      toast({ title: "Retry failed", description: e instanceof Error ? e.message : "", variant: "destructive" });
    }
  };

  const openJobsCell = async (cell: GridCell, roomTypeName: string) => {
    setJobsCell({ cell, roomTypeName, jobs: [], loading: true });
    try {
      const data = await api<{ items: JobRow[] }>(`/api/channel-inventory/jobs${qs({ inventoryId: cell.inventoryId })}`);
      setJobsCell({ cell, roomTypeName, jobs: data.items, loading: false });
    } catch {
      setJobsCell({ cell, roomTypeName, jobs: [], loading: false });
    }
  };

  /* ── Render ────────────────────────────────────────────────────────── */
  if (loading && !grid) {
    return (
      <div className="panel p-10 flex flex-col items-center gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-brass" />
        <p className="text-sm text-muted-ink">Provisioning inventory…</p>
      </div>
    );
  }
  if (!grid) return null;

  const s = grid.summary;
  const colWidth = 58;
  const ROW_HEAD_W = 220;

  return (
    <div className="space-y-4 select-none">
      {/* Summary bar */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2.5">
        <SummaryChip icon={Layers} label="Total rooms" value={String(s.totalRooms)} tone="pine" />
        <SummaryChip icon={LockOpen} label="Open today" value={String(s.openToday)} tone="ok" />
        <SummaryChip icon={Lock} label="Closed today" value={String(s.closedToday)} tone="danger" />
        <SummaryChip
          icon={RefreshCw} label="Pushes syncing" value={String(s.syncing)}
          tone={s.syncing > 0 ? "brass" : "muted"} pulse={s.syncing > 0}
        />
        <SummaryChip icon={AlertTriangle} label="Pushes failed" value={String(s.failed)} tone={s.failed > 0 ? "danger" : "muted"} />
        <SummaryChip icon={Wifi} label="Channels active" value={`${s.channelsActive}/${s.channelsConnected}`} tone="pine" />
      </div>

      {/* Control bar */}
      <div className="panel">
        <div className="px-4 py-3 border-b border-line flex flex-wrap items-center gap-3">
          {/* Tabs */}
          <div className="inline-flex rounded-md border border-line-strong bg-plaster/60 p-0.5" role="tablist" aria-label="Grid mode">
            <button
              role="tab" aria-selected={tab === "inventory"}
              onClick={() => setTab("inventory")}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
                tab === "inventory" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
              )}
            >
              <Grid3X3 className="h-3.5 w-3.5" /> Inventory
            </button>
            <button
              role="tab" aria-selected={tab === "rate"}
              onClick={() => setTab("rate")}
              className={cn(
                "inline-flex items-center gap-1.5 h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
                tab === "rate" ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
              )}
            >
              <IndianRupee className="h-3.5 w-3.5" /> Rates
            </button>
          </div>

          {/* Range toggle */}
          <div className="inline-flex rounded-md border border-line-strong bg-plaster/60 p-0.5" aria-label="Grid length">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r}
                onClick={() => setDays(r)}
                aria-pressed={days === r}
                className={cn(
                  "h-7 px-3 rounded-[5px] text-[12px] font-medium transition",
                  days === r ? "bg-pine-700 text-panel" : "text-muted-ink hover:text-pine"
                )}
              >
                {r}d
              </button>
            ))}
          </div>

          <p className="text-[11px] text-muted-ink hidden md:flex items-center gap-1.5">
            <Info className="h-3.5 w-3.5" />
            {tab === "inventory"
              ? "Click = open/close instantly · double-click = edit rooms · drag = bulk actions"
              : "Click a cell to edit the channel rate · overrides push to every active channel"}
          </p>

          <div className="ml-auto flex items-center gap-2">
            <button className="btn-outline h-8 text-[12px]" onClick={() => load(true)} disabled={loading}>
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> Refresh
            </button>
          </div>
        </div>

        {/* Legend */}
        <div className="px-4 py-2 border-b border-line flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-ink">
          <span className="font-semibold uppercase tracking-wider text-[10px]">Legend</span>
          <LegendDot cls="bg-ok/70" label={`Open`} />
          <LegendDot cls="bg-warn/60" label="Low availability" />
          <LegendDot cls="bg-line-strong" label="Sold out" />
          <LegendDot cls="bg-danger/70" label="Closed" />
          <span className="inline-flex items-center gap-1"><Check className="h-3 w-3 text-ok" /> synced</span>
          <span className="inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin text-brass" /> syncing…</span>
          <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-danger" /> failed — click to retry</span>
          <span className="ml-auto hidden lg:inline-flex items-center gap-1.5 text-[10.5px]">
            <Keyboard className="h-3 w-3" /> all edits push to every connected channel
          </span>
        </div>

        {/* Grid — spreadsheet-meets-calendar with Excel-style month band */}
        <div className="overflow-x-auto scroll-slim" onMouseLeave={() => { /* keep drag alive across gaps */ }}>
          <table className="border-separate border-spacing-0" style={{ minWidth: ROW_HEAD_W + grid.dates.length * colWidth }}>
            <thead>
              {/* Month band — spans each month's run of day columns */}
              <tr>
                <th
                  rowSpan={2}
                  className={cn(
                    "sticky left-0 z-40 bg-panel border-b border-r border-line-strong px-3 text-left align-bottom w-[220px] min-w-[220px]",
                    tab === "inventory" ? "pb-2" : "pb-2"
                  )}
                  style={{ top: 0 }}
                >
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-ink block">Room type</span>
                  <span className="text-[10px] text-muted-ink/70 font-normal block mt-0.5">
                    {grid.rows.length} types · {grid.dates.length} nights · {tab === "inventory" ? "availability" : "rates"}
                  </span>
                </th>
                {monthBands.map((b, bi) => {
                  return (
                    <th
                      key={b.label}
                      colSpan={b.span}
                      className={cn(
                        "sticky z-30 bg-plaster/90 border-b border-line text-center h-7",
                        bi > 0 && "border-l border-l-line-strong",
                        "border-r border-r-line/40"
                      )}
                      style={{ top: 0, minWidth: colWidth }}
                    >
                      <span className="text-[9.5px] font-semibold uppercase tracking-[0.14em] text-pine-700 inline-flex items-center gap-1 leading-none">
                        <span className="h-1 w-1 rounded-full bg-brass/80" aria-hidden />
                        {b.label}
                        <span className="h-1 w-1 rounded-full bg-brass/80" aria-hidden />
                      </span>
                    </th>
                  );
                })}
              </tr>
              {/* Date header row — three stacked tiers (weekday · day · month) on
                  fixed lines so every column aligns perfectly, Excel-style. Weeks
                  are chunked with a subtle vertical rule before each Sunday. */}
              <tr>
                {grid.dates.map((d, ci) => {
                  const isToday = d === todayISO;
                  const newMonth = ci === 0 || dayNum(d) === 1;
                  const weekStart = dow(d) === 0;
                  return (
                    <th
                      key={d}
                      scope="col"
                      aria-label={`${WDAYS[dow(d)]}, ${dayNum(d)} ${MONTHS[parseISO(d).getMonth()]}`}
                      className={cn(
                        "sticky z-30 border-b border-r border-line px-0 pt-1.5 pb-1.5 text-center font-normal bg-panel",
                        isWeekend(d) && "bg-plaster/70",
                        isToday && "bg-pine-100/90",
                        newMonth && "border-l-2 border-l-line-strong",
                        !newMonth && weekStart && "border-l border-l-line/80"
                      )}
                      style={{ top: 28, minWidth: colWidth, width: colWidth, maxWidth: colWidth }}
                    >
                      {/* Tier 1 — weekday */}
                      <span className={cn(
                        "block text-[9px] font-semibold uppercase tracking-[0.12em] leading-none",
                        isToday ? "text-pine" : isWeekend(d) ? "text-brass" : "text-muted-ink"
                      )}>
                        {WDAYS[dow(d)]}
                      </span>
                      {/* Tier 2 — day number; today wears a pine pill */}
                      <span className="mt-1 flex items-center justify-center">
                        {isToday ? (
                          <span className="inline-flex h-[21px] min-w-[24px] items-center justify-center rounded-md bg-pine px-1 text-[13px] font-bold leading-none text-panel tabular-nums">
                            {dayNum(d)}
                          </span>
                        ) : (
                          <span className={cn("block text-[14px] font-bold leading-none tabular-nums", isWeekend(d) ? "text-pine-700" : "text-ink")}>
                            {dayNum(d)}
                          </span>
                        )}
                      </span>
                      {/* Tier 3 — month; emphasised on the 1st, whisper otherwise */}
                      <span className={cn(
                        "block text-[8px] uppercase tracking-[0.14em] leading-none mt-1 tabular-nums",
                        newMonth ? "font-bold text-brass" : "text-muted-ink/70"
                      )}>
                        {MONTHS[parseISO(d).getMonth()]}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, ri) => (
                <tr key={row.roomTypeId} className={cn(ri % 2 === 1 && "bg-plaster/20")}>
                  <th
                    scope="row"
                    className="sticky left-0 z-20 bg-panel border-b border-r border-line-strong px-3 py-2 text-left align-middle"
                  >
                    <p className="text-[13px] font-medium text-pine leading-tight">{row.name}</p>
                    <p className="text-[10.5px] text-muted-ink">{row.code} · {row.capacity} rooms</p>
                  </th>
                  {row.cells.map((cell, ci) => {
                    const key = cellKey(row.roomTypeId, cell.date);
                    const state = cellState(cell);
                    const isSelected = selected.has(key);
                    const isToday = cell.date === todayISO;
                    const newMonth = ci === 0 || dayNum(cell.date) === 1;
                    const lastCol = ci === grid.dates.length - 1;
                    const busy = savingCell === key || cell.pending > 0;
                    return (
                      <td
                        key={cell.date}
                        className={cn(
                          "p-0 border-b border-r border-line/50 relative",
                          isWeekend(cell.date) && "bg-plaster/40",
                          isToday && "bg-pine-100/40",
                          newMonth && "border-l-2 border-l-line-strong",
                          !newMonth && dow(cell.date) === 0 && "border-l border-l-line/60",
                          lastCol && "border-r-line-strong"
                        )}
                        style={{ minWidth: colWidth, width: colWidth, maxWidth: colWidth }}
                      >
                        <GridCellButton
                          cell={cell}
                          state={state}
                          tab={tab}
                          busy={busy}
                          isSelected={isSelected}
                          rateEditing={rateEdit?.rt === row.roomTypeId && rateEdit?.date === cell.date}
                          rateValue={rateEdit?.rt === row.roomTypeId && rateEdit?.date === cell.date ? rateEdit.value : ""}
                          countEditing={countEdit?.rt === row.roomTypeId && countEdit?.date === cell.date}
                          countValue={countEdit?.rt === row.roomTypeId && countEdit?.date === cell.date ? countEdit.value : ""}
                          onToggle={() => toggleCell(row.roomTypeId, cell.date)}
                          onDragStart={() => tab === "inventory" && startDrag(ri, ci)}
                          onDragEnter={() => tab === "inventory" && extendDrag(ri, ci)}
                          onRateStart={() => { cancelPendingToggle(); setRateEdit({ rt: row.roomTypeId, date: cell.date, value: String(Math.round(cell.rate)) }); }}
                          onRateChange={(v) => setRateEdit({ rt: row.roomTypeId, date: cell.date, value: v })}
                          onRateCommit={() => {
                            const v = Number(rateEdit?.value);
                            if (Number.isFinite(v) && v >= 0 && v !== cell.rate) void saveRate(row.roomTypeId, cell.date, v);
                            else setRateEdit(null);
                          }}
                          onRateCancel={() => setRateEdit(null)}
                          onCountStart={() => {
                            cancelPendingToggle();
                            setSelected(new Set());
                            setCountEdit({ rt: row.roomTypeId, date: cell.date, value: String(cell.availableCount) });
                          }}
                          onCountChange={(v) => setCountEdit({ rt: row.roomTypeId, date: cell.date, value: v })}
                          onCountCommit={() => {
                            const v = Number(countEdit?.value);
                            if (Number.isInteger(v) && v >= 0 && v <= 99 && v !== cell.availableCount) void saveCount(row.roomTypeId, cell.date, v);
                            else setCountEdit(null);
                          }}
                          onCountCancel={() => setCountEdit(null)}
                          onFailClick={() => openJobsCell(cell, row.name)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bulk action floating bar */}
      {selected.size > 0 && tab === "inventory" && (
        <div className="sticky bottom-4 z-40 flex justify-center pointer-events-none">
          <div className="pointer-events-auto expand-in panel border-line-strong bg-panel px-4 py-2.5 flex items-center gap-3 rounded-lg flex-wrap" role="toolbar" aria-label="Bulk actions">
            <div className="leading-tight">
              <p className="text-[13px] font-semibold text-pine">{selected.size} cell{selected.size === 1 ? "" : "s"} selected</p>
              <p className="text-[10.5px] text-muted-ink">Drag across the grid to change the selection</p>
            </div>
            <div className="h-8 w-px bg-line" />
            <button className="btn-pine h-8 text-[12px]" onClick={() => applyBulk(true)} disabled={bulkBusy}>
              <LockOpen className="h-3.5 w-3.5" /> Open all
            </button>
            <button className="btn-danger h-8 text-[12px]" onClick={() => applyBulk(false)} disabled={bulkBusy}>
              <Lock className="h-3.5 w-3.5" /> Close all
            </button>
            <div className="h-8 w-px bg-line" />
            <label className="flex items-center gap-1.5 text-[11px] text-muted-ink" htmlFor="bulk-count-input">
              Set rooms
              <input
                id="bulk-count-input"
                type="number"
                min={0}
                max={99}
                value={bulkCount}
                onChange={(e) => setBulkCount(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void applyBulkCount(); }}
                placeholder="0–99"
                className="w-16 h-8 rounded-sm border border-line-strong bg-panel px-1.5 text-center text-[12px] font-semibold text-pine focus:outline-none focus:ring-2 focus:ring-brass/50"
              />
            </label>
            <button className="btn-outline h-8 text-[12px]" onClick={applyBulkCount} disabled={bulkBusy || bulkCount === ""}>
              <Layers className="h-3.5 w-3.5" /> Apply
            </button>
            <button className="btn-ghost h-8 text-[12px]" onClick={clearSelection} aria-label="Clear selection">
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {/* Failed-jobs retry popover */}
      {jobsCell && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6" role="dialog" aria-label="Failed pushes for this cell">
          <div className="absolute inset-0 bg-pine/50" onClick={() => setJobsCell(null)} />
          <div className="relative panel border-line-strong w-full sm:max-w-md max-h-[70vh] flex flex-col expand-in">
            <div className="panel-header">
              <div>
                <p className="panel-title">Channel pushes · {jobsCell.roomTypeName}</p>
                <p className="text-[11px] text-muted-ink">
                  {jobsCell.cell.date} · {jobsCell.cell.isOpen ? "Open" : "Closed"} · {jobsCell.cell.availableCount} available
                </p>
              </div>
              <button className="btn-ghost px-1.5 h-6" onClick={() => setJobsCell(null)} aria-label="Close">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="overflow-y-auto scroll-slim divide-y divide-line/70">
              {jobsCell.loading && (
                <div className="px-4 py-6 flex items-center justify-center gap-2 text-sm text-muted-ink">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </div>
              )}
              {!jobsCell.loading && jobsCell.jobs.length === 0 && (
                <div className="px-4 py-6 text-sm text-muted-ink text-center">No queued or failed pushes for this cell.</div>
              )}
              {!jobsCell.loading && jobsCell.jobs.map((j) => (
                <div key={j.id} className="px-4 py-3 flex items-start gap-3">
                  <span className={cn(
                    "mt-0.5 h-7 w-7 shrink-0 rounded-md flex items-center justify-center",
                    j.status === "failed" ? "bg-danger/15 text-danger" : "bg-brass/15 text-brass"
                  )}>
                    {j.status === "failed" ? <AlertTriangle className="h-3.5 w-3.5" /> : <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] text-ink">
                      <span className="font-medium capitalize">{j.channel.replace("_", " ")}</span>
                      <span className="text-muted-ink"> · {j.action.replace("_", " ")} · attempt {j.attempts}/3</span>
                    </p>
                    <p className="text-[11px] text-muted-ink mt-0.5 break-words">{j.lastError || "Waiting in queue…"}</p>
                  </div>
                  {j.status === "failed" && (
                    <button
                      className="btn-outline h-7 px-2.5 text-[11px] shrink-0"
                      onClick={() => retryJob(j.id)}
                    >
                      <RotateCcw className="h-3 w-3" /> Retry
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="border-t border-line px-4 py-2.5 text-[11px] text-muted-ink">
              Every attempt is recorded in Channels → Sync Log. Retries re-enter the async queue — no channel is contacted from the browser.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Sub-components ──────────────────────────────────────────────────── */

function SummaryChip({
  icon: Icon, label, value, tone, pulse,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string;
  tone: "pine" | "ok" | "danger" | "brass" | "muted";
  pulse?: boolean;
}) {
  const tones: Record<string, string> = {
    pine: "bg-pine-100/60 text-pine-700",
    ok: "bg-ok/12 text-ok",
    danger: "bg-danger/12 text-danger",
    brass: "bg-brass/12 text-brass",
    muted: "bg-plaster/70 text-muted-ink",
  };
  return (
    <div className={cn("panel px-2.5 py-2 flex items-center gap-2 min-w-0", pulse && "live-ping")}>
      <span className={cn("h-7 w-7 rounded-md flex items-center justify-center shrink-0", tones[tone])}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 leading-tight">
        <p className="font-display font-semibold text-pine text-[17px] tracking-tight truncate">{value}</p>
        <p className="text-[9px] text-muted-ink uppercase tracking-[0.08em] whitespace-nowrap truncate">{label}</p>
      </div>
    </div>
  );
}

function LegendDot({ cls, label }: { cls: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-sm inline-block", cls)} /> {label}
    </span>
  );
}

const CELL_TONES: Record<string, string> = {
  open: "bg-ok/12 hover:bg-ok/20 border-transparent",
  low: "bg-warn/15 hover:bg-warn/25 border-transparent",
  soldout: "bg-line/60 hover:bg-line/90 border-transparent",
  closed: "bg-danger/15 hover:bg-danger/25 border-transparent",
};
const CELL_TEXT: Record<string, string> = {
  open: "text-ink", low: "text-ink", soldout: "text-muted-ink", closed: "text-danger",
};

function GridCellButton({
  cell, state, tab, busy, isSelected,
  rateEditing, rateValue, countEditing, countValue,
  onToggle, onDragStart, onDragEnter,
  onRateStart, onRateChange, onRateCommit, onRateCancel,
  onCountStart, onCountChange, onCountCommit, onCountCancel,
  onFailClick,
}: {
  cell: GridCell;
  state: "open" | "low" | "soldout" | "closed";
  tab: "inventory" | "rate";
  busy: boolean;
  isSelected: boolean;
  rateEditing: boolean;
  rateValue: string;
  countEditing: boolean;
  countValue: string;
  onToggle: () => void;
  onDragStart: () => void;
  onDragEnter: () => void;
  onRateStart: () => void;
  onRateChange: (v: string) => void;
  onRateCommit: () => void;
  onRateCancel: () => void;
  onCountStart: () => void;
  onCountChange: (v: string) => void;
  onCountCommit: () => void;
  onCountCancel: () => void;
  onFailClick: () => void;
}) {
  if (rateEditing) {
    return (
      <div className="p-0.5">
        <input
          autoFocus
          type="number"
          min={0}
          value={rateValue}
          onChange={(e) => onRateChange(e.target.value)}
          onBlur={onRateCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRateCommit();
            if (e.key === "Escape") onRateCancel();
          }}
          className="w-full h-8 rounded-sm border border-brass bg-panel px-1 text-center text-[12px] font-semibold text-pine focus:outline-none focus:ring-2 focus:ring-brass/50"
          aria-label={`Rate for ${cell.date}`}
        />
      </div>
    );
  }

  if (countEditing) {
    return (
      <div className="p-0.5">
        <input
          autoFocus
          type="number"
          min={0}
          max={99}
          value={countValue}
          onChange={(e) => onCountChange(e.target.value)}
          onBlur={onCountCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCountCommit();
            if (e.key === "Escape") onCountCancel();
          }}
          className="w-full h-8 rounded-sm border border-pine-700 bg-panel px-1 text-center text-[12px] font-semibold text-pine focus:outline-none focus:ring-2 focus:ring-pine-700/40"
          aria-label={`Rooms available on ${cell.date} (0–${cell.capacity})`}
          title={`0–${cell.capacity} (physical capacity)`}
        />
      </div>
    );
  }

  return (
    <button
      type="button"
      draggable={false}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        // Prevent the default focus-on-mousedown: otherwise the browser focuses
        // the (about-to-be-replaced) button after an input mounts, blurring it
        // instantly and closing the editor. Also keeps drag-selection clean.
        e.preventDefault();
        if (tab === "inventory") onDragStart(); else onRateStart();
      }}
      onMouseEnter={onDragEnter}
      onDoubleClick={() => { if (tab === "inventory") onCountStart(); }}
      onKeyDown={(e) => { if (e.key === "Enter" && tab === "inventory") { e.preventDefault(); onToggle(); } }}
      className={cn(
        "w-full h-11 flex flex-col items-center justify-center relative transition-colors",
        tab === "inventory" ? CELL_TONES[state] : "bg-brass-50/60 hover:bg-brass/20",
        tab === "rate" && state === "closed" && "opacity-50",
        isSelected && "ring-2 ring-inset ring-brass bg-brass/20",
        tab === "inventory" ? "cursor-pointer" : "cursor-text"
      )}
      aria-label={`${cell.date}: ${cell.isOpen ? "open" : "closed"}, ${cell.availableCount} available${cell.failed > 0 ? ", has failed pushes" : ""}`}
      title={`${cell.date} — ${cell.isOpen ? "Open" : "Closed"} · ${cell.availableCount}/${cell.capacity} available · click = toggle${cell.isOpen ? ", double-click = edit count" : ""}${tab === "rate" ? ` · ${money(cell.rate)}` : ""}`}
    >
      {tab === "inventory" ? (
        <>
          <span className={cn(
            "text-[13px] font-semibold leading-none tabular-nums",
            CELL_TEXT[state],
            cell.availableCount !== cell.capacity && cell.isOpen && "underline decoration-brass/60 decoration-dotted underline-offset-2"
          )}>
            {cell.availableCount}
          </span>
          <span className={cn("text-[8.5px] uppercase tracking-wider leading-none mt-0.5", state === "closed" ? "text-danger/80" : "text-muted-ink/80")}>
            {cell.isOpen ? (state === "soldout" ? "full" : "open") : "closed"}
          </span>
        </>
      ) : (
        <span className="text-[12px] font-semibold text-pine leading-none flex items-center gap-0.5">
          {money(cell.rate)}
          {cell.rateOverride && <span className="h-1.5 w-1.5 rounded-full bg-brass" title="Manual override" />}
        </span>
      )}

      {/* Sync status badge — a span (never a nested <button>) with click isolation */}
      <span className="absolute top-0.5 right-0.5 leading-none">
        {busy ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin text-brass" aria-label="syncing" />
        ) : cell.failed > 0 ? (
          <span
            role="button"
            tabIndex={0}
            className="h-3 w-3 rounded-full bg-danger text-panel flex items-center justify-center hover:scale-125 transition-transform cursor-pointer"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); onFailClick(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onFailClick(); } }}
            aria-label={`${cell.failed} failed push — inspect and retry`}
            title={`${cell.failed} failed push${cell.failed === 1 ? "" : "es"} — click to inspect & retry`}
          >
            <AlertTriangle className="h-2 w-2" />
          </span>
        ) : cell.pending === 0 ? (
          <Check className="h-2.5 w-2.5 text-ok/70" aria-label="synced" />
        ) : null}
      </span>
    </button>
  );
}
