"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  BedDouble, Layers, Plus, Pencil, Trash2, Loader2, DoorOpen, Search,
} from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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

interface RoomType {
  id: string;
  name: string;
  code: string;
  description: string;
  baseRate: number;
  maxOccupancy: number;
  sizeSqft: number;
  bedType: string;
  amenities: string[];
  _count?: { rooms: number };
}

interface Room {
  id: string;
  number: string;
  floor: number;
  status: string;
  note: string;
  roomType: { id: string; name: string; code: string; baseRate: number };
  currentReservation: {
    id: string;
    confirmationNumber: string;
    checkIn: string;
    checkOut: string;
    guest: { id: string; fullName: string; phone: string };
  } | null;
}

const STATUS_BADGE: Record<string, string> = {
  vacant: "border-ok/40 bg-ok/10 text-ok",
  occupied: "border-pine-700/30 bg-pine-100 text-pine-700",
  dirty: "border-warn/40 bg-warn/10 text-warn",
  clean: "border-[#7ea08c]/40 bg-[#7ea08c]/10 text-[#7ea08c]",
  out_of_order: "border-danger/30 bg-danger/10 text-danger",
};

const CHIPS: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "vacant", label: "Vacant" },
  { key: "occupied", label: "Occupied" },
  { key: "dirty", label: "Dirty" },
  { key: "clean", label: "Clean" },
  { key: "out_of_order", label: "Out of Order" },
];

const QUICK_STATUSES = ["vacant", "dirty", "clean", "out_of_order"] as const;

export default function RoomsView() {
  const user = useSession((s) => s.user);
  const { toast } = useToast();
  const canManageRooms = user?.role === "hotel_admin" || user?.role === "front_desk";
  const isAdmin = user?.role === "hotel_admin";

  const [tab, setTab] = useState("rooms");
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [loading, setLoading] = useState(true);
  const [chip, setChip] = useState("all");
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);

  // Add / edit room dialog state
  const [roomDialogOpen, setRoomDialogOpen] = useState(false);
  const [editingRoom, setEditingRoom] = useState<Room | null>(null);
  const [roomForm, setRoomForm] = useState({ number: "", floor: "1", roomTypeId: "", status: "vacant", note: "" });

  const [deleteRoom, setDeleteRoom] = useState<Room | null>(null);

  // Room type dialog state
  const [rtDialogOpen, setRtDialogOpen] = useState(false);
  const [editingType, setEditingType] = useState<RoomType | null>(null);
  const [rtForm, setRtForm] = useState({
    name: "", code: "", baseRate: "", maxOccupancy: "2", sizeSqft: "250", bedType: "King", amenities: "", description: "",
  });
  const [deleteType, setDeleteType] = useState<RoomType | null>(null);

  const load = useCallback(async () => {
    try {
      const [roomsRes, typesRes] = await Promise.all([
        api<{ rooms: Room[] }>("/api/rooms"),
        api<{ roomTypes: RoomType[] }>("/api/room-types"),
      ]);
      setRooms(roomsRes.rooms);
      setRoomTypes(typesRes.roomTypes);
    } catch (e) {
      toast({ title: "Could not load rooms", description: (e as Error).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: rooms.length };
    for (const r of rooms) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rooms]);

  const filtered = useMemo(
    () =>
      rooms.filter(
        (r) =>
          (chip === "all" || r.status === chip) &&
          (!search || r.number.toLowerCase().includes(search.toLowerCase()))
      ),
    [rooms, chip, search]
  );

  async function quickStatus(room: Room, status: string) {
    try {
      await api(`/api/rooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ status }) });
      toast({ title: `Room ${room.number} → ${STATUS_LABELS[status] ?? status}` });
      load();
    } catch (e) {
      toast({ title: "Status change failed", description: (e as Error).message, variant: "destructive" });
    }
  }

  function openAddRoom() {
    setEditingRoom(null);
    setRoomForm({ number: "", floor: "1", roomTypeId: roomTypes[0]?.id ?? "", status: "vacant", note: "" });
    setRoomDialogOpen(true);
  }

  function openEditRoom(room: Room) {
    setEditingRoom(room);
    setRoomForm({ number: room.number, floor: String(room.floor), roomTypeId: room.roomType.id, status: room.status, note: room.note });
    setRoomDialogOpen(true);
  }

  async function submitRoom() {
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        number: roomForm.number.trim(),
        floor: Number(roomForm.floor),
        roomTypeId: roomForm.roomTypeId,
        status: roomForm.status,
        note: roomForm.note,
      };
      if (editingRoom) {
        await api(`/api/rooms/${editingRoom.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast({ title: "Room updated", description: `Room ${payload.number} saved.` });
      } else {
        await api("/api/rooms", { method: "POST", body: JSON.stringify(payload) });
        toast({ title: "Room added", description: `Room ${payload.number} created.` });
      }
      setRoomDialogOpen(false);
      load();
    } catch (e) {
      toast({ title: editingRoom ? "Update failed" : "Could not add room", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeleteRoom() {
    if (!deleteRoom) return;
    setSaving(true);
    try {
      await api(`/api/rooms/${deleteRoom.id}`, { method: "DELETE" });
      toast({ title: "Room deleted", description: `Room ${deleteRoom.number} removed.` });
      setDeleteRoom(null);
      load();
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function openAddType() {
    setEditingType(null);
    setRtForm({ name: "", code: "", baseRate: "", maxOccupancy: "2", sizeSqft: "250", bedType: "King", amenities: "", description: "" });
    setRtDialogOpen(true);
  }

  function openEditType(t: RoomType) {
    setEditingType(t);
    setRtForm({
      name: t.name, code: t.code, baseRate: String(t.baseRate), maxOccupancy: String(t.maxOccupancy),
      sizeSqft: String(t.sizeSqft), bedType: t.bedType, amenities: t.amenities.join(", "), description: t.description,
    });
    setRtDialogOpen(true);
  }

  async function submitType() {
    setSaving(true);
    try {
      const payload = {
        name: rtForm.name.trim(),
        code: rtForm.code.trim(),
        baseRate: Number(rtForm.baseRate),
        maxOccupancy: Number(rtForm.maxOccupancy),
        sizeSqft: Number(rtForm.sizeSqft),
        bedType: rtForm.bedType,
        amenities: rtForm.amenities.split(",").map((a) => a.trim()).filter(Boolean),
        description: rtForm.description,
      };
      if (editingType) {
        await api(`/api/room-types/${editingType.id}`, { method: "PATCH", body: JSON.stringify(payload) });
        toast({ title: "Room type updated" });
      } else {
        await api("/api/room-types", { method: "POST", body: JSON.stringify(payload) });
        toast({ title: "Room type created", description: `${payload.name} (${payload.code}) added.` });
      }
      setRtDialogOpen(false);
      load();
    } catch (e) {
      toast({ title: editingType ? "Update failed" : "Could not create room type", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  async function confirmDeleteType() {
    if (!deleteType) return;
    setSaving(true);
    try {
      await api(`/api/room-types/${deleteType.id}`, { method: "DELETE" });
      toast({ title: "Room type deleted" });
      setDeleteType(null);
      load();
    } catch (e) {
      toast({ title: "Delete failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="panel p-6 space-y-3">
        {[...Array(5)].map((_, i) => <div key={i} className="skeleton h-10 rounded" />)}
      </div>
    );
  }

  return (
    <Tabs value={tab} onValueChange={setTab} className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <TabsList className="bg-plaster-deep/70 border border-line">
          <TabsTrigger value="rooms" className="gap-1.5"><DoorOpen className="h-3.5 w-3.5" /> Rooms</TabsTrigger>
          <TabsTrigger value="types" className="gap-1.5"><Layers className="h-3.5 w-3.5" /> Room Types</TabsTrigger>
        </TabsList>
        {tab === "rooms" && canManageRooms && (
          <button className="btn-pine self-start" onClick={openAddRoom}><Plus className="h-4 w-4" /> Add Room</button>
        )}
        {tab === "types" && canManageRooms && (
          <button className="btn-pine self-start" onClick={openAddType}><Plus className="h-4 w-4" /> Add Room Type</button>
        )}
      </div>

      {/* ── Rooms tab ─────────────────────────────────────────── */}
      <TabsContent value="rooms" className="space-y-4 mt-0">
        <div className="panel px-4 py-3 flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {CHIPS.map((c) => (
              <button
                key={c.key}
                onClick={() => setChip(c.key)}
                className={cn(
                  "badge transition cursor-pointer",
                  chip === c.key
                    ? "border-pine-700 bg-pine-700 text-panel"
                    : "border-line-strong bg-panel text-muted-ink hover:border-brass hover:text-brass"
                )}
              >
                {c.label}
                <span className={cn("ml-1 font-semibold", chip === c.key ? "text-brass-light" : "text-pine-700")}>
                  {counts[c.key] ?? 0}
                </span>
              </button>
            ))}
          </div>
          <div className="relative lg:ml-auto lg:w-64">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" />
            <input
              className="field pl-8 h-8 text-[13px]"
              placeholder="Search room no…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <p className="panel-title">Room Inventory</p>
            <span className="text-xs text-muted-ink">{filtered.length} of {rooms.length} rooms</span>
          </div>
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[760px]">
              <thead>
                <tr>
                  <th className="th">Room No</th>
                  <th className="th">Type</th>
                  <th className="th">Floor</th>
                  <th className="th">Status</th>
                  <th className="th">Current Guest</th>
                  <th className="th">Note</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((room) => (
                  <tr key={room.id} className="hover:bg-plaster/50">
                    <td className="td font-display font-semibold text-pine">{room.number}</td>
                    <td className="td">
                      <span className="text-[13px]">{room.roomType.name}</span>
                      <span className="ml-1.5 text-[11px] text-muted-ink">{room.roomType.code}</span>
                    </td>
                    <td className="td">{room.floor}</td>
                    <td className="td">
                      <span className={cn("badge", STATUS_BADGE[room.status])}>
                        {STATUS_LABELS[room.status] ?? room.status}
                      </span>
                    </td>
                    <td className="td">
                      {room.currentReservation ? (
                        <div className="leading-tight">
                          <p className="text-[13px] font-medium text-pine">{room.currentReservation.guest.fullName}</p>
                          <p className="text-[11px] text-muted-ink">{room.currentReservation.guest.phone} · {room.currentReservation.confirmationNumber}</p>
                        </div>
                      ) : (
                        <span className="text-muted-ink">—</span>
                      )}
                    </td>
                    <td className="td max-w-[160px]"><span className="block truncate text-[13px] text-muted-ink" title={room.note}>{room.note || "—"}</span></td>
                    <td className="td">
                      <div className="flex items-center justify-end gap-2">
                        <Select value={room.status} onValueChange={(v) => v !== room.status && quickStatus(room, v)}>
                          <SelectTrigger size="sm" className="h-7 w-[130px] text-[12px] bg-panel" aria-label={`Change status for room ${room.number}`}>
                            <span className="truncate">{STATUS_LABELS[room.status] ?? room.status}</span>
                          </SelectTrigger>
                          <SelectContent>
                            {QUICK_STATUSES.map((s) => (
                              <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                            ))}
                            {room.status === "occupied" && (
                              <SelectItem value="occupied" disabled>Occupied (in-house)</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                        {canManageRooms && (
                          <button className="btn-ghost px-2 h-7" onClick={() => openEditRoom(room)} aria-label={`Edit room ${room.number}`}>
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {isAdmin && (
                          <button
                            className="btn-ghost px-2 h-7 text-danger hover:bg-danger/10"
                            onClick={() => setDeleteRoom(room)}
                            aria-label={`Delete room ${room.number}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td className="td text-center text-muted-ink py-8" colSpan={7}>No rooms match this filter.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </TabsContent>

      {/* ── Room Types tab ────────────────────────────────────── */}
      <TabsContent value="types" className="mt-0">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {roomTypes.map((t) => (
            <div key={t.id} className="panel p-4 flex flex-col gap-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-display font-semibold text-pine">{t.name}</p>
                  <span className="badge border-brass/40 bg-brass-50 text-brass mt-1">{t.code}</span>
                </div>
                <div className="h-9 w-9 rounded-md bg-pine-100 flex items-center justify-center shrink-0">
                  <BedDouble className="h-4 w-4 text-pine-700" />
                </div>
              </div>
              <p className="text-[13px] text-muted-ink line-clamp-2 min-h-[2.5rem]">{t.description || "—"}</p>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
                <span className="text-muted-ink">Base rate</span><span className="font-medium text-pine">{inr(t.baseRate)}</span>
                <span className="text-muted-ink">Max occupancy</span><span>{t.maxOccupancy} guests</span>
                <span className="text-muted-ink">Size</span><span>{t.sizeSqft} sq ft</span>
                <span className="text-muted-ink">Bed</span><span>{t.bedType}</span>
                <span className="text-muted-ink">Rooms</span><span>{t._count?.rooms ?? 0}</span>
              </div>
              {t.amenities.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {t.amenities.map((a) => (
                    <span key={a} className="badge border-line-strong bg-plaster text-muted-ink">{a}</span>
                  ))}
                </div>
              )}
              {isAdmin && (
                <div className="flex items-center gap-2 border-t border-line pt-3 mt-auto">
                  <button className="btn-outline flex-1" onClick={() => openEditType(t)}><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button className="btn-ghost text-danger hover:bg-danger/10" onClick={() => setDeleteType(t)}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
              )}
            </div>
          ))}
        </div>
      </TabsContent>

      {/* ── Room dialog ───────────────────────────────────────── */}
      <Dialog open={roomDialogOpen} onOpenChange={setRoomDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">{editingRoom ? `Edit Room ${editingRoom.number}` : "Add Room"}</DialogTitle>
            <DialogDescription>{editingRoom ? "Update room details and status." : "Create a new room in the inventory."}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Room Number</label>
              <input className="field" value={roomForm.number} onChange={(e) => setRoomForm({ ...roomForm, number: e.target.value })} placeholder="e.g. 401" />
            </div>
            <div>
              <label className="field-label">Floor</label>
              <input className="field" type="number" min={0} value={roomForm.floor} onChange={(e) => setRoomForm({ ...roomForm, floor: e.target.value })} />
            </div>
            <div className="col-span-2">
              <label className="field-label">Room Type</label>
              <Select value={roomForm.roomTypeId} onValueChange={(v) => setRoomForm({ ...roomForm, roomTypeId: v })}>
                <SelectTrigger className="w-full"><SelectValue placeholder="Select a type" /></SelectTrigger>
                <SelectContent>
                  {roomTypes.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name} · {inr(t.baseRate)}/night</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="field-label">Status</label>
              <Select value={roomForm.status} onValueChange={(v) => setRoomForm({ ...roomForm, status: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["vacant", "dirty", "clean", "out_of_order"].map((s) => (
                    <SelectItem key={s} value={s}>{STATUS_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="field-label">Note</label>
              <input className="field" value={roomForm.note} onChange={(e) => setRoomForm({ ...roomForm, note: e.target.value })} placeholder="Optional housekeeping / maintenance note" />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setRoomDialogOpen(false)}>Cancel</button>
            <button className="btn-pine" onClick={submitRoom} disabled={saving || !roomForm.number.trim() || !roomForm.roomTypeId}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingRoom ? "Save Changes" : "Add Room"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Room type dialog ──────────────────────────────────── */}
      <Dialog open={rtDialogOpen} onOpenChange={setRtDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">{editingType ? `Edit ${editingType.name}` : "Add Room Type"}</DialogTitle>
            <DialogDescription>{editingType ? "Update the category details and rate." : "Define a new room category with its base rate."}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="field-label">Name</label>
              <input className="field" value={rtForm.name} onChange={(e) => setRtForm({ ...rtForm, name: e.target.value })} placeholder="Deluxe King" />
            </div>
            <div>
              <label className="field-label">Code</label>
              <input className="field" value={rtForm.code} onChange={(e) => setRtForm({ ...rtForm, code: e.target.value.toUpperCase() })} placeholder="DLX" />
            </div>
            <div>
              <label className="field-label">Base Rate (₹/night)</label>
              <input className="field" type="number" min={0} value={rtForm.baseRate} onChange={(e) => setRtForm({ ...rtForm, baseRate: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Max Occupancy</label>
              <input className="field" type="number" min={1} value={rtForm.maxOccupancy} onChange={(e) => setRtForm({ ...rtForm, maxOccupancy: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Size (sq ft)</label>
              <input className="field" type="number" min={0} value={rtForm.sizeSqft} onChange={(e) => setRtForm({ ...rtForm, sizeSqft: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Bed Type</label>
              <Select value={rtForm.bedType} onValueChange={(v) => setRtForm({ ...rtForm, bedType: v })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["King", "Queen", "Twin", "Suite"].map((b) => <SelectItem key={b} value={b}>{b}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <label className="field-label">Amenities (comma separated)</label>
              <input className="field" value={rtForm.amenities} onChange={(e) => setRtForm({ ...rtForm, amenities: e.target.value })} placeholder="Wi-Fi, Mini Bar, Balcony" />
            </div>
            <div className="col-span-2">
              <label className="field-label">Description</label>
              <textarea className="field h-20 py-2" value={rtForm.description} onChange={(e) => setRtForm({ ...rtForm, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setRtDialogOpen(false)}>Cancel</button>
            <button className="btn-pine" onClick={submitType} disabled={saving || !rtForm.name.trim() || !rtForm.code.trim() || !rtForm.baseRate}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingType ? "Save Changes" : "Create Type"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirms ───────────────────────────────────── */}
      <AlertDialog open={!!deleteRoom} onOpenChange={(o) => !o && setDeleteRoom(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete room {deleteRoom?.number}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the room from inventory. Rooms with active reservations cannot be deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-outline h-9">Keep Room</AlertDialogCancel>
            <AlertDialogAction className="btn-danger" onClick={confirmDeleteRoom}><Trash2 className="h-4 w-4" /> Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteType} onOpenChange={(o) => !o && setDeleteType(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteType?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The category can only be deleted when no rooms use it. Rate plans referencing it stay in place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="btn-outline h-9">Keep Type</AlertDialogCancel>
            <AlertDialogAction className="btn-danger" onClick={confirmDeleteType}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
