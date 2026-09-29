"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone, Plus, MoreHorizontal, Trash2, Radio } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useOwnerApi, fmtDateTime, StatusBadge, EmptyState, Loading, ErrorState } from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AnnouncementRow {
  id: string;
  title: string;
  body: string;
  audience: string;
  planCode: string;
  propertyIds: string;
  channel: string;
  active: boolean;
  createdBy: string;
  createdAt: string;
  readBy: string[];
  readCount: number;
}

interface BusinessRef { id: string; name: string; }

const AUDIENCE_LABELS: Record<string, string> = {
  all: "All tenants",
  plan: "By plan",
  tenants: "Selected tenants",
};

const CHANNEL_LABELS: Record<string, string> = {
  in_app: "In-app",
  email: "Email",
  whatsapp: "WhatsApp",
};

function parsePropertyIds(raw: string): string[] {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function AnnouncementsView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [announcements, setAnnouncements] = useState<AnnouncementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [deleting, setDeleting] = useState<AnnouncementRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ announcements: AnnouncementRow[] }>("/api/owner/announcements");
      setAnnouncements(res.announcements);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(a: AnnouncementRow) {
    try {
      const res = await api<{ ok: boolean; active: boolean }>(`/api/owner/announcements/${a.id}`, { method: "PATCH" });
      setAnnouncements((list) => list.map((x) => (x.id === a.id ? { ...x, active: res.active } : x)));
      toast({ title: res.active ? "Announcement re-activated" : "Announcement deactivated", description: a.title });
    } catch (e) {
      toast({ title: "Toggle failed", description: errText(e), variant: "destructive" });
    }
  }

  async function remove(a: AnnouncementRow) {
    setBusy(true);
    try {
      await api(`/api/owner/announcements/${a.id}`, { method: "DELETE" });
      toast({ title: "Announcement deleted", description: a.title });
      setDeleting(null);
      await load();
    } catch (e) {
      toast({ title: "Delete failed", description: errText(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel p-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-ink">
          {announcements.length} announcement{announcements.length === 1 ? "" : "s"} · {announcements.filter((a) => a.active).length} live
        </p>
        <div className="flex-1" />
        <button className="btn-pine" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" />
          New announcement
        </button>
      </div>

      {/* Cards */}
      {loading ? (
        <Loading label="Loading announcements…" />
      ) : error ? (
        <ErrorState message={error} onRetry={() => void load()} />
      ) : announcements.length === 0 ? (
        <div className="panel">
          <EmptyState icon={Megaphone} title="No announcements yet" hint="Broadcast product updates, maintenance windows or offers to your tenants." />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {announcements.map((a) => {
            const targeted = a.audience === "tenants" ? parsePropertyIds(a.propertyIds).length : null;
            return (
              <div key={a.id} className={`panel p-4 ${a.active ? "" : "opacity-70"}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-pine truncate">{a.title}</p>
                    <p className="text-xs text-muted-ink mt-0.5">{fmtDateTime(a.createdAt)} · by {a.createdBy}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Switch checked={a.active} onCheckedChange={() => void toggle(a)} aria-label={`Toggle ${a.title}`} />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="btn-ghost px-2" aria-label={`Actions for ${a.title}`}>
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleting(a)}>
                          <Trash2 className="h-4 w-4" /> Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                <p className="text-sm text-ink line-clamp-2 mt-2">{a.body}</p>
                <div className="flex flex-wrap items-center gap-1.5 mt-3">
                  <span className="badge border-pine/30 bg-pine/5 text-pine">{AUDIENCE_LABELS[a.audience] ?? a.audience}</span>
                  {a.audience === "plan" && a.planCode && (
                    <span className="badge border-brass/40 bg-brass/10 text-brass capitalize">{a.planCode} plan</span>
                  )}
                  {a.audience === "tenants" && targeted !== null && (
                    <span className="badge border-line-strong bg-plaster text-muted-ink">{targeted} business{targeted === 1 ? "" : "es"}</span>
                  )}
                  <span className="badge border-line-strong bg-plaster text-muted-ink flex items-center gap-1">
                    <Radio className="h-3 w-3" /> {CHANNEL_LABELS[a.channel] ?? a.channel}
                  </span>
                  <StatusBadge status={a.active ? "active" : "cancelled"} />
                  <span className="text-[11px] text-muted-ink ml-auto">Read by {a.readCount}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* New announcement dialog */}
      <NewAnnouncementDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(recipients) => { setNewOpen(false); void load(); if (recipients !== null) toast({ title: "Announcement sent", description: `Reached ${recipients} recipient${recipients === 1 ? "" : "s"}.` }); }}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>Tenants will no longer see this announcement. The deletion is audited.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (deleting) void remove(deleting); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── New announcement dialog ─────────────────────────────────────────────────

function NewAnnouncementDialog({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (recipients: number | null) => void;
}) {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("all");
  const [planCode, setPlanCode] = useState("pro");
  const [channel, setChannel] = useState("in_app");
  const [businesses, setBusinesses] = useState<BusinessRef[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle("");
    setBody("");
    setAudience("all");
    setPlanCode("pro");
    setChannel("in_app");
    setSelected(new Set());
    api<{ businesses: BusinessRef[] }>("/api/owner/businesses?pageSize=50")
      .then((r) => setBusinesses(r.businesses))
      .catch(() => setBusinesses([]));
  }, [open, api]);

  function toggleBusiness(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setSaving(true);
    try {
      const res = await api<{ ok: boolean; id: string; recipients: number }>("/api/owner/announcements", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          audience,
          planCode: audience === "plan" ? planCode : undefined,
          propertyIds: audience === "tenants" ? Array.from(selected) : undefined,
          channel,
        }),
      });
      onCreated(res.recipients);
    } catch (e) {
      toast({ title: "Could not send announcement", description: errText(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const ready =
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (audience !== "plan" || planCode.length > 0) &&
    (audience !== "tenants" || selected.size > 0);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New announcement</DialogTitle>
          <DialogDescription>
            Broadcast to every tenant, a plan tier, or a hand-picked list.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="an-title">Title</Label>
            <Input id="an-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. New: Channel Manager is live" />
          </div>
          <div>
            <Label htmlFor="an-body">Body</Label>
            <Textarea id="an-body" rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What should tenants know?" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Audience</Label>
              <Select value={audience} onValueChange={setAudience}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All tenants</SelectItem>
                  <SelectItem value="plan">By plan</SelectItem>
                  <SelectItem value="tenants">Selected tenants</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Channel</Label>
              <Select value={channel} onValueChange={setChannel}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in_app">In-app</SelectItem>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="whatsapp">WhatsApp</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {audience === "plan" && (
            <div>
              <Label>Plan tier</Label>
              <Select value={planCode} onValueChange={setPlanCode}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="basic">Basic</SelectItem>
                  <SelectItem value="pro">Pro</SelectItem>
                  <SelectItem value="enterprise">Enterprise</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          {audience === "tenants" && (
            <div>
              <Label>Select businesses ({selected.size} chosen)</Label>
              {businesses.length === 0 ? (
                <p className="text-sm text-muted-ink">Loading businesses…</p>
              ) : (
                <div className="max-h-40 overflow-y-auto scroll-slim rounded-md border border-line divide-y divide-line/70">
                  {businesses.map((b) => (
                    <label key={b.id} className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-plaster/60">
                      <Checkbox checked={selected.has(b.id)} onCheckedChange={() => toggleBusiness(b.id)} />
                      {b.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
          {channel !== "in_app" && (
            <p className="text-[11px] text-warn">
              email/WhatsApp delivery is a stub until providers are configured in Platform Settings — the announcement is stored and tracked, but no message actually goes out yet.
            </p>
          )}
        </div>
        <DialogFooter>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-pine" disabled={saving || !ready} onClick={() => void submit()}>
            Send announcement
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
