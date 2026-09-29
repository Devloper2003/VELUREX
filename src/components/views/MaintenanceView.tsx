"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { fmtDate, STATUS_LABELS } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Wrench, Plus, Play, Check, RotateCcw, Loader2, Camera, X, ImageIcon, TriangleAlert, RefreshCw,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getStoredToken } from "@/lib/store";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Ticket {
  id: string; roomId: string | null; title: string; description: string; photoUrl: string;
  status: string; priority: string; reportedBy: string; resolvedAt: string | null; createdAt: string;
  room: { number: string } | null;
}
interface RoomLite { id: string; number: string; floor: number }
interface BoardData { floors: { floor: number; rooms: { id: string; number: string; floor: number }[] }[] }

const PRIORITY_BADGE: Record<string, string> = {
  high: "border-danger/40 bg-danger/10 text-danger",
  normal: "border-line-strong bg-plaster text-muted-ink",
  low: "border-line bg-transparent text-muted-ink",
};
const STATUS_BADGE: Record<string, string> = {
  open: "border-warn/40 bg-warn/10 text-warn",
  in_progress: "border-brass/40 bg-brass-50 text-brass",
  resolved: "border-ok/40 bg-ok/10 text-ok",
};

const EMPTY_FORM = { roomId: "", title: "", description: "", priority: "normal" };

// ─── View ────────────────────────────────────────────────────────────────────

export default function MaintenanceView() {
  const { toast } = useToast();

  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [rooms, setRooms] = useState<RoomLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("open");
  const [actingId, setActingId] = useState<string | null>(null);

  // New ticket dialog
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [photoUrl, setPhotoUrl] = useState("");
  const [preview, setPreview] = useState(""); // local object URL while uploading
  const fileRef = useRef<HTMLInputElement>(null);

  // Photo viewer
  const [photoView, setPhotoView] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([
        api<{ tickets: Ticket[] }>("/api/maintenance"),
        api<BoardData>("/api/housekeeping/board"),
      ]);
      setTickets(t.tickets);
      setRooms(b.floors.flatMap((f) => f.rooms.map((r) => ({ id: r.id, number: r.number, floor: r.floor }))));
    } catch {
      /* keep stale; error panel shows if nothing loaded */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 45000);
    return () => clearInterval(t);
  }, [load]);

  const visible = useMemo(
    () => (tab === "all" ? tickets : tickets.filter((t) => t.status === tab)),
    [tickets, tab]
  );
  const tabCount = (s: string) => (s === "all" ? tickets.length : tickets.filter((t) => t.status === s).length);

  const setStatus = async (ticket: Ticket, status: string) => {
    setActingId(ticket.id);
    try {
      await api(`/api/maintenance/${ticket.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast({ title: `Ticket ${STATUS_LABELS[status]?.toLowerCase() ?? status}` });
      await load();
    } catch (e) {
      toast({ title: "Could not update ticket", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setActingId(null);
    }
  };

  // ─── Photo upload ─────────────────────────────────────────────────────────

  const onPickFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Images only", description: "Pick a JPG, PNG or WebP photo.", variant: "destructive" });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "Photo too large", description: "Maximum size is 5MB.", variant: "destructive" });
      return;
    }
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const token = getStoredToken();
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error || `Upload failed (${res.status})`);
      setPhotoUrl(data.url);
      toast({ title: "Photo attached" });
    } catch (e) {
      setPreview("");
      toast({ title: "Upload failed", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const clearPhoto = () => {
    setPhotoUrl("");
    setPreview("");
    if (fileRef.current) fileRef.current.value = "";
  };

  // ─── Create ticket ────────────────────────────────────────────────────────

  const submit = async () => {
    if (!form.title.trim()) { toast({ title: "Title is required", variant: "destructive" }); return; }
    setSaving(true);
    try {
      await api("/api/maintenance", {
        method: "POST",
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description,
          priority: form.priority,
          roomId: form.roomId || null,
          ...(photoUrl ? { photoUrl } : {}),
        }),
      });
      toast({ title: "Ticket created" });
      setOpen(false);
      setForm(EMPTY_FORM);
      clearPhoto();
      await load();
    } catch (e) {
      toast({ title: "Could not create ticket", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading && tickets.length === 0) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-12 rounded-lg" />
        <div className="panel p-4 space-y-3">
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton h-16 rounded-md" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 pb-6">
      {/* Sticky header */}
      <div className="sticky top-0 z-20 bg-plaster/95 backdrop-blur-sm pt-1 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-xl font-semibold text-pine truncate">Maintenance</h2>
            <p className="text-xs text-muted-ink truncate">
              {tabCount("open")} open · {tabCount("in_progress")} in progress · {tabCount("resolved")} resolved
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="btn-ghost h-9 px-2" onClick={load} aria-label="Refresh"><RefreshCw className="h-4 w-4" /></button>
            <button className="btn-pine h-9" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" /><span className="hidden sm:inline">New Ticket</span>
            </button>
          </div>
        </div>
      </div>

      {/* Tickets */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Tickets</p>
          <span className="text-xs text-muted-ink hidden sm:inline">{tickets.length} total</span>
        </div>
        <div className="px-4 pt-3">
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="w-full sm:w-auto flex-wrap h-9">
              {["open", "in_progress", "resolved", "all"].map((key) => (
                <TabsTrigger key={key} value={key} className="flex-1 sm:flex-none px-2.5 text-[12px]">
                  {key === "all" ? "All" : STATUS_LABELS[key]}
                  <span className="ml-1.5 text-[10px] rounded-full bg-plaster-deep px-1.5 py-0.5 text-muted-ink">{tabCount(key)}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="p-4">
          {visible.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-ink">
              No {tab === "all" ? "" : STATUS_LABELS[tab]?.toLowerCase() + " "}tickets. All good!
            </div>
          ) : (
            <>
              {/* Mobile: stacked cards */}
              <div className="space-y-3 sm:hidden">
                {visible.map((t) => (
                  <TicketCard key={t.id} ticket={t} acting={actingId === t.id} onStatus={setStatus} onPhoto={setPhotoView} />
                ))}
              </div>
              {/* Desktop: table */}
              <div className="hidden sm:block overflow-x-auto scroll-slim">
                <table className="w-full min-w-[760px]">
                  <thead>
                    <tr>
                      <th className="th">Title</th>
                      <th className="th">Room</th>
                      <th className="th">Priority</th>
                      <th className="th">Status</th>
                      <th className="th">Reported by</th>
                      <th className="th">Created</th>
                      <th className="th">Photo</th>
                      <th className="th w-[200px]">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((t) => (
                      <TicketRow key={t.id} ticket={t} acting={actingId === t.id} onStatus={setStatus} onPhoto={setPhotoView} />
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* New ticket dialog */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) { setOpen(false); clearPhoto(); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">New Maintenance Ticket</DialogTitle>
            <DialogDescription>Report an issue — attach a photo so the fix is faster.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="field-label">Title *</label>
              <input className="field h-10" placeholder="e.g. AC not cooling" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
            </div>
            <div>
              <label className="field-label">Room (optional)</label>
              <Select value={form.roomId || "none"} onValueChange={(v) => setForm((f) => ({ ...f, roomId: v === "none" ? "" : v }))}>
                <SelectTrigger className="w-full h-10"><SelectValue placeholder="General / no room" /></SelectTrigger>
                <SelectContent className="max-h-64">
                  <SelectItem value="none">General / no room</SelectItem>
                  {rooms.map((r) => (
                    <SelectItem key={r.id} value={r.id}>{r.number} · Floor {r.floor}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
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
              <div>
                <label className="field-label">Photo (≤5MB)</label>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={(e) => onPickFile(e.target.files?.[0])} />
                <button type="button" className="btn-outline h-10 w-full" disabled={uploading} onClick={() => fileRef.current?.click()}>
                  {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                  {uploading ? "Uploading…" : photoUrl ? "Replace" : "Upload"}
                </button>
              </div>
            </div>
            {(preview || photoUrl) && (
              <div className="flex items-center gap-2">
                <img src={photoUrl || preview} alt="Attachment preview" className="h-16 w-16 rounded-md border border-line object-cover" />
                <button type="button" className="btn-ghost h-9 text-danger" onClick={clearPhoto}><X className="h-4 w-4" /> Remove</button>
                {preview && !photoUrl && <span className="text-[11px] text-muted-ink">uploading…</span>}
              </div>
            )}
            <div>
              <label className="field-label">Description</label>
              <Textarea rows={3} className="bg-panel" placeholder="What's wrong? Where exactly?" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-2">
            <button className="btn-ghost h-11 flex-1 sm:flex-none" onClick={() => { setOpen(false); clearPhoto(); }}>Cancel</button>
            <button className="btn-pine h-11 flex-1 sm:flex-none" disabled={saving || uploading} onClick={submit}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Create Ticket
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Photo viewer */}
      <Dialog open={!!photoView} onOpenChange={(o) => { if (!o) setPhotoView(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Attachment</DialogTitle>
            <DialogDescription>Reported photo</DialogDescription>
          </DialogHeader>
          <img src={photoView ?? ""} alt="Ticket attachment" className="w-full h-auto max-h-[70vh] rounded-md border border-line object-contain bg-plaster" />
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Ticket subcomponents ────────────────────────────────────────────────────

interface TicketProps {
  ticket: Ticket;
  acting: boolean;
  onStatus: (ticket: Ticket, status: string) => void;
  onPhoto: (url: string) => void;
}

function PriorityBadge({ priority }: { priority: string }) {
  return <span className={cn("badge", PRIORITY_BADGE[priority] || PRIORITY_BADGE.normal)}>{priority}</span>;
}

function StatusBadge({ status }: { status: string }) {
  return <span className={cn("badge", STATUS_BADGE[status] || "")}>{STATUS_LABELS[status] || status}</span>;
}

function TicketActions({ ticket, acting, onStatus }: { ticket: Ticket; acting: boolean } & Pick<TicketProps, "onStatus">) {
  const cls = "h-9 flex-1 text-[13px]";
  if (ticket.status === "resolved") {
    return (
      <div className="flex gap-2">
        <button className={cn("btn-outline", cls)} disabled={acting} onClick={() => onStatus(ticket, "open")}>
          <RotateCcw className="h-3.5 w-3.5" /> Reopen
        </button>
      </div>
    );
  }
  return (
    <div className="flex gap-2">
      {ticket.status === "open" && (
        <button className={cn("btn-pine", cls)} disabled={acting} onClick={() => onStatus(ticket, "in_progress")}>
          {acting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Start
        </button>
      )}
      <button className={cn("btn-outline", cls)} disabled={acting} onClick={() => onStatus(ticket, "resolved")}>
        {acting && ticket.status === "in_progress" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Resolve
      </button>
    </div>
  );
}

function PhotoThumb({ ticket, onPhoto }: Pick<TicketProps, "ticket" | "onPhoto">) {
  if (!ticket.photoUrl) {
    return (
      <span className="h-10 w-10 rounded-md border border-dashed border-line-strong flex items-center justify-center text-muted-ink">
        <ImageIcon className="h-4 w-4" />
      </span>
    );
  }
  return (
    <button onClick={() => onPhoto(ticket.photoUrl)} aria-label="View photo" className="shrink-0">
      <img src={ticket.photoUrl} alt={`${ticket.title} photo`} className="h-10 w-10 rounded-md border border-line object-cover transition hover:scale-105" />
    </button>
  );
}

function TicketRow({ ticket, acting, onStatus, onPhoto }: TicketProps) {
  return (
    <tr className={cn("hover:bg-plaster/50", ticket.status === "resolved" && "bg-ok/5")}>
      <td className="td">
        <div className="font-medium text-pine">{ticket.title}</div>
        {ticket.description && <div className="text-[11px] text-muted-ink line-clamp-1 max-w-[280px]">{ticket.description}</div>}
      </td>
      <td className="td">{ticket.room?.number ?? "—"}</td>
      <td className="td"><PriorityBadge priority={ticket.priority} /></td>
      <td className="td"><StatusBadge status={ticket.status} /></td>
      <td className="td text-[13px]">{ticket.reportedBy || "—"}</td>
      <td className="td text-[13px]">{fmtDate(ticket.createdAt)}</td>
      <td className="td"><PhotoThumb ticket={ticket} onPhoto={onPhoto} /></td>
      <td className="td"><TicketActions ticket={ticket} acting={acting} onStatus={onStatus} /></td>
    </tr>
  );
}

function TicketCard({ ticket, acting, onStatus, onPhoto }: TicketProps) {
  return (
    <div className={cn("panel p-3 space-y-2.5", ticket.status === "resolved" && "bg-ok/5 border-ok/30")}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2.5 min-w-0">
          <div className="h-10 w-10 rounded-md bg-brass-50 flex items-center justify-center shrink-0">
            <Wrench className="h-5 w-5 text-brass" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-pine leading-tight">{ticket.title}</p>
            <p className="text-[11px] text-muted-ink">
              {ticket.room ? `Room ${ticket.room.number}` : "General"} · {fmtDate(ticket.createdAt)} · {ticket.reportedBy || "—"}
            </p>
          </div>
        </div>
        <PhotoThumb ticket={ticket} onPhoto={onPhoto} />
      </div>
      {ticket.description && <p className="text-xs text-muted-ink border-l-2 border-line pl-2">{ticket.description}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <PriorityBadge priority={ticket.priority} />
        <StatusBadge status={ticket.status} />
        {ticket.status === "resolved" && ticket.resolvedAt && (
          <span className="text-[11px] text-ok">Resolved {fmtDate(ticket.resolvedAt)}</span>
        )}
      </div>
      <TicketActions ticket={ticket} acting={acting} onStatus={onStatus} />
    </div>
  );
}
