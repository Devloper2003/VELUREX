"use client";

import { useCallback, useEffect, useState } from "react";
import { MoreHorizontal, Plus, TicketPercent, Pencil, Trash2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useOwnerApi, inr, fmtDate, pct, StatusBadge, EmptyState, Loading, ErrorState,
} from "@/components/owner/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

interface CouponRedemption { at: string; property: string; }

interface CouponRow {
  id: string;
  code: string;
  description: string;
  discountType: string;
  discountValue: number;
  maxUses: number;
  usedCount: number;
  validFrom: string | null;
  validTo: string | null;
  planCode: string;
  trialDays: number;
  active: boolean;
  redemptions: CouponRedemption[];
}

interface CouponForm {
  code: string;
  description: string;
  discountType: string;
  discountValue: string;
  maxUses: string;
  validTo: string;
  planCode: string;
  trialDays: string;
}

const EMPTY_FORM: CouponForm = {
  code: "", description: "", discountType: "percent", discountValue: "",
  maxUses: "100", validTo: "", planCode: "all", trialDays: "0",
};

const PLAN_OPTIONS = [
  { value: "all", label: "All plans" },
  { value: "basic", label: "Basic" },
  { value: "pro", label: "Pro" },
  { value: "enterprise", label: "Enterprise" },
];

function rewardLabel(c: CouponRow): string {
  const parts: string[] = [];
  if (c.trialDays > 0) parts.push(`+${c.trialDays} trial days`);
  if (c.discountValue > 0) parts.push(c.discountType === "percent" ? `${c.discountValue}% off` : `${inr(c.discountValue)} off`);
  return parts.length ? parts.join(" · ") : "—";
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function CouponsView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [coupons, setCoupons] = useState<CouponRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CouponRow | null>(null);
  const [deleting, setDeleting] = useState<CouponRow | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api<{ coupons: CouponRow[] }>("/api/owner/coupons");
      setCoupons(res.coupons);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  async function toggle(c: CouponRow) {
    try {
      const res = await api<{ ok: boolean; active: boolean }>(`/api/owner/coupons/${c.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "toggle" }),
      });
      setCoupons((list) => list.map((x) => (x.id === c.id ? { ...x, active: res.active } : x)));
      toast({ title: res.active ? "Coupon activated" : "Coupon deactivated", description: c.code });
    } catch (e) {
      toast({ title: "Toggle failed", description: errText(e), variant: "destructive" });
    }
  }

  async function remove(c: CouponRow) {
    setBusy(true);
    try {
      await api(`/api/owner/coupons/${c.id}`, { method: "DELETE" });
      toast({ title: "Coupon deleted", description: c.code });
      setDeleting(null);
      await load();
    } catch (e) {
      toast({ title: "Cannot delete coupon", description: errText(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="panel p-3 flex flex-wrap items-center gap-2">
        <p className="text-sm text-muted-ink">
          {coupons.length} coupon{coupons.length === 1 ? "" : "s"} · {coupons.filter((c) => c.active).length} active
        </p>
        <div className="flex-1" />
        <button className="btn-pine" onClick={() => { setEditing(null); setDialogOpen(true); }}>
          <Plus className="h-4 w-4" />
          New coupon
        </button>
      </div>

      {/* Coupons table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><TicketPercent className="h-4 w-4 text-brass" /> Coupons & offers</p>
          <p className="text-xs text-muted-ink">Codes are auto-uppercased · trial-day codes extend trials</p>
        </div>
        {loading ? (
          <Loading label="Loading coupons…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : coupons.length === 0 ? (
          <EmptyState icon={TicketPercent} title="No coupons yet" hint="Create a discount or trial-extension code to use on the Add Business flow." />
        ) : (
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[880px]">
              <thead>
                <tr>
                  <th className="th">Code</th>
                  <th className="th">Description</th>
                  <th className="th">Reward</th>
                  <th className="th">Scope</th>
                  <th className="th w-44">Usage</th>
                  <th className="th">Valid till</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.id} className="hover:bg-plaster/50 transition">
                    <td className="td font-mono font-semibold text-pine">{c.code}</td>
                    <td className="td max-w-48">
                      <span className="block truncate" title={c.description}>{c.description || "—"}</span>
                    </td>
                    <td className="td">
                      <span className={c.trialDays > 0 ? "text-brass font-medium" : "text-ink"}>{rewardLabel(c)}</span>
                    </td>
                    <td className="td text-muted-ink">
                      {c.planCode && c.planCode !== "all" ? <span className="badge border-brass/40 bg-brass/10 text-brass capitalize">{c.planCode}</span> : "All plans"}
                    </td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <Progress value={pct(c.usedCount, c.maxUses)} className="h-1.5 w-24" />
                        <span className="text-xs text-muted-ink whitespace-nowrap">{c.usedCount}/{c.maxUses === -1 ? "∞" : c.maxUses}</span>
                      </div>
                    </td>
                    <td className="td text-muted-ink">{c.validTo ? fmtDate(c.validTo) : "No expiry"}</td>
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <Switch checked={c.active} onCheckedChange={() => void toggle(c)} aria-label={`Toggle ${c.code}`} />
                        <StatusBadge status={c.active ? "active" : "cancelled"} />
                      </div>
                    </td>
                    <td className="td text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="btn-ghost px-2" aria-label={`Actions for ${c.code}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { setEditing(c); setDialogOpen(true); }}>
                            <Pencil className="h-4 w-4" /> Edit
                          </DropdownMenuItem>
                          <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => setDeleting(c)}>
                            <Trash2 className="h-4 w-4" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / edit dialog */}
      <CouponDialog
        open={dialogOpen}
        editing={editing}
        onClose={() => setDialogOpen(false)}
        onSaved={() => { setDialogOpen(false); void load(); }}
      />

      {/* Delete confirm */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete coupon {deleting?.code}?</AlertDialogTitle>
            <AlertDialogDescription>
              Coupons with redemptions cannot be deleted — deactivate them instead. This action is audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              disabled={busy}
              onClick={(e) => { e.preventDefault(); if (deleting) void remove(deleting); }}
            >
              Delete coupon
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── Create / edit dialog ────────────────────────────────────────────────────

function CouponDialog({ open, editing, onClose, onSaved }: {
  open: boolean;
  editing: CouponRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const api = useOwnerApi();
  const { toast } = useToast();
  const [form, setForm] = useState<CouponForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        code: editing.code,
        description: editing.description,
        discountType: editing.discountType,
        discountValue: String(editing.discountValue ?? ""),
        maxUses: String(editing.maxUses ?? "100"),
        validTo: editing.validTo ? editing.validTo.slice(0, 10) : "",
        planCode: editing.planCode || "all",
        trialDays: String(editing.trialDays ?? "0"),
      });
    } else {
      setForm(EMPTY_FORM);
    }
  }, [open, editing]);

  const set = (k: keyof CouponForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    setSaving(true);
    try {
      if (editing) {
        await api(`/api/owner/coupons/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            description: form.description,
            discountValue: Number(form.discountValue) || 0,
            maxUses: Number(form.maxUses) || 100,
            validTo: form.validTo || null,
          }),
        });
        toast({ title: "Coupon updated", description: editing.code });
      } else {
        await api("/api/owner/coupons", {
          method: "POST",
          body: JSON.stringify({
            code: form.code.trim(),
            description: form.description,
            discountType: form.discountType,
            discountValue: Number(form.discountValue) || 0,
            maxUses: Number(form.maxUses) || 100,
            validTo: form.validTo || null,
            planCode: form.planCode === "all" ? "" : form.planCode,
            trialDays: Number(form.trialDays) || 0,
          }),
        });
        toast({ title: "Coupon created", description: form.code.toUpperCase() });
      }
      onSaved();
    } catch (e) {
      toast({ title: editing ? "Update failed" : "Could not create coupon", description: errText(e), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const codeOk = /^[A-Za-z0-9_-]{3,24}$/.test(form.code.trim());

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit coupon — ${editing.code}` : "New coupon"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "The code is fixed after creation; limits and description can be changed."
              : "Codes are auto-uppercased. A trial-day code extends the trial instead of discounting."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="cp-code">Code</Label>
              <Input
                id="cp-code"
                className="font-mono uppercase"
                value={form.code}
                onChange={(e) => set("code", e.target.value.toUpperCase())}
                placeholder="LAUNCH25"
                disabled={!!editing}
              />
              {!editing && form.code.length > 0 && !codeOk && (
                <p className="text-[11px] text-danger mt-1">3–24 chars: A–Z, 0–9, - or _</p>
              )}
            </div>
            <div>
              <Label htmlFor="cp-value">Discount value</Label>
              <Input id="cp-value" type="number" min="0" step="any" value={form.discountValue} onChange={(e) => set("discountValue", e.target.value)} placeholder={form.discountType === "percent" ? "10 (→ 10% off)" : "500 (→ ₹500 off)"} />
            </div>
          </div>
          <div>
            <Label htmlFor="cp-desc">Description</Label>
            <Input id="cp-desc" value={form.description} onChange={(e) => set("description", e.target.value)} placeholder="Shown to the onboarding agent" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label>Type</Label>
              <Select value={form.discountType} onValueChange={(v) => set("discountType", v)} disabled={!!editing}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="percent">Percent %</SelectItem>
                  <SelectItem value="flat">Flat ₹</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cp-max">Max uses</Label>
              <Input id="cp-max" type="number" min="1" value={form.maxUses} onChange={(e) => set("maxUses", e.target.value)} />
            </div>
            <div>
              <Label htmlFor="cp-valid">Valid till</Label>
              <Input id="cp-valid" type="date" value={form.validTo} onChange={(e) => set("validTo", e.target.value)} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Scope</Label>
              <Select value={form.planCode} onValueChange={(v) => set("planCode", v)} disabled={!!editing}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLAN_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="cp-trial">Trial days</Label>
              <Input id="cp-trial" type="number" min="0" value={form.trialDays} onChange={(e) => set("trialDays", e.target.value)} />
              <p className="text-[11px] text-muted-ink mt-1">trial-extension code — grants extra trial days at signup</p>
            </div>
          </div>
        </div>
        <DialogFooter>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-pine"
            disabled={saving || (!editing && !codeOk)}
            onClick={() => void submit()}
          >
            {editing ? "Save changes" : "Create coupon"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
