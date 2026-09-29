"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtDate, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  Plus, Search, Loader2, Pencil, Eye, Users, Phone, Mail, MapPin, StickyNote, History, Camera, ImageOff,
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";

interface Guest {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  photoUrl: string;
  idType: string;
  idNumber: string;
  address: string;
  city: string;
  nationality: string;
  notes: string;
  createdAt: string;
  totalStays?: number;
  lastStayAt?: string | null;
}

interface HistoryRow {
  id: string;
  confirmationNumber: string;
  roomNumber: string;
  roomTypeName: string;
  status: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  totalAmount: number;
  source: string;
}

const STATUS_BADGE: Record<string, string> = {
  confirmed: "border-pine-700/30 bg-pine-100 text-pine-700",
  checked_in: "border-ok/40 bg-ok/10 text-ok",
  checked_out: "border-line-strong bg-plaster text-muted-ink",
  cancelled: "border-danger/30 bg-danger/10 text-danger",
  no_show: "border-danger/40 bg-danger/15 text-danger",
  hold: "border-warn/40 bg-warn/10 text-warn",
};

function maskId(g: Guest): string {
  if (!g.idNumber) return "—";
  const digits = g.idNumber.trim();
  if (digits.length <= 4) return `${g.idType ? `${g.idType.toUpperCase()} ` : ""}••••`;
  return `${g.idType ? `${g.idType.toUpperCase()} ` : ""}••••${digits.slice(-4)}`;
}

/** Brand avatar — guest photo when available, brass initials otherwise. */
export function GuestAvatar({ name, photoUrl, size = 32, className }: {
  name: string; photoUrl?: string; size?: number; className?: string;
}) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
  if (photoUrl) {
    return (
      <img
        src={photoUrl}
        alt={`Photo of ${name}`}
        style={{ width: size, height: size }}
        className={cn("shrink-0 rounded-full object-cover ring-1 ring-line-strong shadow-[0_1px_2px_rgba(15,38,34,0.12)]", className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
      className={cn(
        "shrink-0 rounded-full bg-pine-700 text-panel font-semibold inline-flex items-center justify-center tracking-wide ring-1 ring-pine-700/30 select-none",
        className
      )}
    >
      {initials}
    </span>
  );
}

const EMPTY_FORM = { fullName: "", phone: "", email: "", idType: "aadhaar", idNumber: "", city: "", address: "", nationality: "Indian", notes: "", photoUrl: "" };

export default function GuestsView() {
  const { toast } = useToast();
  const user = useSession((s) => s.user);
  const canEdit = user?.role === "hotel_admin" || user?.role === "front_desk";

  const [guests, setGuests] = useState<Guest[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const [viewGuest, setViewGuest] = useState<Guest | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [stats, setStats] = useState<{ totalStays: number; lastStayAt: string | null; lifetimeValue: number } | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [notesDraft, setNotesDraft] = useState("");
  const [savingNotes, setSavingNotes] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Guest | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ guests: Guest[] }>(`/api/guests${search ? `?search=${encodeURIComponent(search)}` : ""}`);
      setGuests(data.guests);
    } catch (e) {
      toast({ title: "Could not load guests", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [search, toast]);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => { load(); }, 300);
    return () => clearTimeout(t);
  }, [load]);

  const filtered = useMemo(() => guests, [guests]);

  async function openView(g: Guest) {
    setViewGuest(g);
    setNotesDraft(g.notes);
    setHistory([]);
    setStats(null);
    setHistoryLoading(true);
    try {
      const data = await api<{ history: HistoryRow[]; stats: { totalStays: number; lastStayAt: string | null; lifetimeValue: number } }>(`/api/guests/${g.id}`);
      setHistory(data.history);
      setStats(data.stats);
    } catch (e) {
      toast({ title: "Could not load stay history", description: (e as Error).message, variant: "destructive" });
    } finally {
      setHistoryLoading(false);
    }
  }

  async function saveNotes() {
    if (!viewGuest) return;
    setSavingNotes(true);
    try {
      await api(`/api/guests/${viewGuest.id}`, { method: "PATCH", body: JSON.stringify({ notes: notesDraft }) });
      toast({ title: "Notes saved", description: `${viewGuest.fullName}'s profile updated.` });
      setViewGuest(null);
      load();
    } catch (e) {
      toast({ title: "Could not save notes", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingNotes(false);
    }
  }

  function openAdd() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setEditOpen(true);
  }

  function openEdit(g: Guest) {
    setEditing(g);
    setForm({
      fullName: g.fullName, phone: g.phone, email: g.email, idType: g.idType || "aadhaar", idNumber: g.idNumber,
      city: g.city, address: g.address, nationality: g.nationality, notes: g.notes, photoUrl: g.photoUrl ?? "",
    });
    setEditOpen(true);
  }

  async function uploadPhoto(file: File) {
    if (file.size > 4 * 1024 * 1024) {
      toast({ title: "Image too large", description: "Please choose a photo under 4 MB.", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: useSession.getState().token ? { Authorization: `Bearer ${useSession.getState().token}` } : undefined,
        body: fd,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Upload failed (${res.status})`);
      const data = (await res.json()) as { url: string };
      setForm((f) => ({ ...f, photoUrl: data.url }));
      toast({ title: "Photo ready", description: "Remember to save the guest profile." });
    } catch (e) {
      toast({ title: "Upload failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/guests/${editing.id}`, { method: "PATCH", body: JSON.stringify(form) });
        toast({ title: "Guest updated", description: `${form.fullName}'s profile saved.` });
      } else {
        await api("/api/guests", { method: "POST", body: JSON.stringify(form) });
        toast({ title: "Guest added", description: `${form.fullName} added to the directory.` });
      }
      setEditOpen(false);
      load();
    } catch (e) {
      toast({ title: editing ? "Update failed" : "Could not add guest", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading && guests.length === 0) {
    return (
      <div className="panel p-6 space-y-3">
        {[...Array(6)].map((_, i) => <div key={i} className="skeleton h-10 rounded" />)}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="panel px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="relative lg:w-80">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" />
          <input
            className="field pl-8 h-9"
            placeholder="Search name, phone, email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <span className="text-xs text-muted-ink hidden md:block">{filtered.length} guest{filtered.length === 1 ? "" : "s"}</span>
        {canEdit && (
          <button className="btn-pine lg:ml-auto self-start" onClick={openAdd}><Plus className="h-4 w-4" /> Add Guest</button>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Guest Directory</p>
          <Users className="h-4 w-4 text-brass" />
        </div>
        <div className="overflow-x-auto scroll-slim">
          <table className="w-full min-w-[860px]">
            <thead>
              <tr>
                <th className="th">Name</th>
                <th className="th">Phone</th>
                <th className="th">Email</th>
                <th className="th">City</th>
                <th className="th">ID</th>
                <th className="th">Stays</th>
                <th className="th">Last Stay</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id} className="hover:bg-plaster/50">
                  <td className="td font-medium text-pine">
                    <div className="flex items-center gap-2.5">
                      <GuestAvatar name={g.fullName} photoUrl={g.photoUrl} size={34} />
                      <div className="leading-tight min-w-0">
                        <p className="truncate" title={g.fullName}>{g.fullName}</p>
                        <p className="text-[11px] text-muted-ink">{g.nationality}</p>
                      </div>
                    </div>
                  </td>
                  <td className="td">{g.phone}</td>
                  <td className="td text-muted-ink">{g.email || "—"}</td>
                  <td className="td">{g.city || "—"}</td>
                  <td className="td font-mono text-[12px] text-muted-ink">{maskId(g)}</td>
                  <td className="td"><span className="badge border-pine-700/30 bg-pine-100 text-pine-700">{g.totalStays ?? 0}</span></td>
                  <td className="td whitespace-nowrap">{g.lastStayAt ? fmtDate(g.lastStayAt) : "—"}</td>
                  <td className="td text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <button className="btn-ghost px-2 h-7" onClick={() => openView(g)} aria-label={`View ${g.fullName}`}>
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                      {canEdit && (
                        <button className="btn-ghost px-2 h-7" onClick={() => openEdit(g)} aria-label={`Edit ${g.fullName}`}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td className="td text-center text-muted-ink py-10" colSpan={8}>No guests found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* View dialog — profile + notes + history */}
      <Dialog open={!!viewGuest} onOpenChange={(o) => !o && setViewGuest(null)}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">{viewGuest?.fullName}</DialogTitle>
            <DialogDescription>
              Guest since {viewGuest ? fmtDate(viewGuest.createdAt) : "—"} · {stats ? `${stats.totalStays} stay(s) · lifetime ${inr(stats.lifetimeValue)}` : "…"}
            </DialogDescription>
          </DialogHeader>

          {viewGuest && (
            <>
              <div className="flex items-center gap-3 rounded-md border border-line bg-plaster/40 px-3 py-2.5">
                <GuestAvatar name={viewGuest.fullName} photoUrl={viewGuest.photoUrl} size={48} />
                <div className="min-w-0 text-[13px]">
                  <p className="font-medium text-pine truncate">{viewGuest.fullName}</p>
                  <p className="text-[11px] text-muted-ink">
                    {maskId(viewGuest)} · {viewGuest.nationality} · guest since {fmtDate(viewGuest.createdAt)}
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[13px]">
                <Info icon={<Phone className="h-3.5 w-3.5" />} label="Phone" value={viewGuest.phone} />
                <Info icon={<Mail className="h-3.5 w-3.5" />} label="Email" value={viewGuest.email || "—"} />
                <Info icon={<MapPin className="h-3.5 w-3.5" />} label="City" value={viewGuest.city || "—"} />
                <Info icon={<MapPin className="h-3.5 w-3.5" />} label="Address" value={viewGuest.address || "—"} />
                <Info icon={<StickyNote className="h-3.5 w-3.5" />} label="ID" value={maskId(viewGuest)} />
                <Info icon={<StickyNote className="h-3.5 w-3.5" />} label="Nationality" value={viewGuest.nationality} />
                <Info icon={<History className="h-3.5 w-3.5" />} label="Last stay" value={stats?.lastStayAt ? fmtDate(stats.lastStayAt) : "—"} />
                <Info icon={<History className="h-3.5 w-3.5" />} label="Lifetime value" value={stats ? inr(stats.lifetimeValue) : "—"} />
              </div>

              <div>
                <label className="field-label">Profile Notes (VIP preferences, allergies…)</label>
                <textarea className="field h-20 py-2" value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} placeholder="e.g. High floor, feather-free pillows" />
              </div>

              <div className="rounded-md border border-line">
                <div className="px-3 py-2 border-b border-line bg-plaster/50 text-[11px] font-semibold uppercase tracking-wider text-muted-ink">Stay History</div>
                {historyLoading ? (
                  <div className="p-4 flex items-center gap-2 text-sm text-muted-ink"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
                ) : history.length === 0 ? (
                  <div className="p-4 text-sm text-muted-ink">No stays yet.</div>
                ) : (
                  <div className="max-h-56 overflow-y-auto scroll-slim">
                    <table className="w-full">
                      <thead>
                        <tr>
                          <th className="th">Room</th>
                          <th className="th">Dates</th>
                          <th className="th">Status</th>
                          <th className="th text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.map((h) => (
                          <tr key={h.id}>
                            <td className="td">
                              <p className="font-medium text-pine">{h.roomNumber}</p>
                              <p className="text-[11px] text-muted-ink">{h.roomTypeName}</p>
                            </td>
                            <td className="td whitespace-nowrap text-[13px]">
                              {fmtDate(h.checkIn)} → {fmtDate(h.checkOut)}
                              <span className="block text-[11px] text-muted-ink">{h.nights}N · {h.confirmationNumber}</span>
                            </td>
                            <td className="td"><span className={cn("badge", STATUS_BADGE[h.status])}>{STATUS_LABELS[h.status] ?? h.status}</span></td>
                            <td className="td text-right font-medium">{inr(h.totalAmount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </>
          )}

          <DialogFooter>
            <button className="btn-outline" onClick={() => setViewGuest(null)}>Close</button>
            {canEdit && (
              <button className="btn-pine" onClick={saveNotes} disabled={savingNotes}>
                {savingNotes && <Loader2 className="h-4 w-4 animate-spin" />} Save Notes
              </button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add / Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">{editing ? `Edit ${editing.fullName}` : "Add Guest"}</DialogTitle>
            <DialogDescription>{editing ? "Update the guest profile." : "Create a guest profile for bookings and folios."}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <label className="field-label">Guest Photo</label>
              <div className="flex items-center gap-3">
                <GuestAvatar name={form.fullName || editing?.fullName || "New Guest"} photoUrl={form.photoUrl} size={52} />
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="btn-outline h-8 px-3 text-xs"
                      onClick={() => photoInputRef.current?.click()}
                      disabled={uploading}
                    >
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
                      {form.photoUrl ? "Change Photo" : "Upload Photo"}
                    </button>
                    {form.photoUrl && (
                      <button type="button" className="btn-ghost h-8 px-2 text-xs text-danger" onClick={() => setForm((f) => ({ ...f, photoUrl: "" }))}>
                        <ImageOff className="h-3.5 w-3.5" /> Remove
                      </button>
                    )}
                  </div>
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) uploadPhoto(file);
                      e.target.value = "";
                    }}
                  />
                  <p className="text-[11px] text-muted-ink">Printed on the registration card. JPG/PNG up to 4 MB.</p>
                </div>
              </div>
            </div>
            <div>
              <label className="field-label">Full Name *</label>
              <input className="field" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Phone *</label>
              <input className="field" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Email</label>
              <input className="field" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label className="field-label">City</label>
              <input className="field" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="field-label">ID Type</label>
                <select className="field" value={form.idType} onChange={(e) => setForm({ ...form, idType: e.target.value })}>
                  {["aadhaar", "passport", "dl", "pan"].map((t) => <option key={t} value={t} className="capitalize">{t.toUpperCase()}</option>)}
                </select>
              </div>
              <div>
                <label className="field-label">ID Number</label>
                <input className="field" value={form.idNumber} onChange={(e) => setForm({ ...form, idNumber: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="field-label">Nationality</label>
              <input className="field" value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="field-label">Address</label>
              <input className="field" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="field-label">Notes</label>
              <textarea className="field h-16 py-2" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setEditOpen(false)}>Cancel</button>
            <button className="btn-pine" onClick={submit} disabled={saving || !form.fullName.trim() || !form.phone.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />} {editing ? "Save Changes" : "Add Guest"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Info({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-md border border-line bg-plaster/40 px-3 py-2">
      <p className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-ink font-medium">{icon} {label}</p>
      <p className="text-[13px] text-ink mt-0.5 truncate" title={value}>{value}</p>
    </div>
  );
}
