"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BedDouble, CalendarCheck, CheckCircle2, Circle, Network, PhoneCall, Plus, Rocket,
  Route, TriangleAlert, Users, X, XCircle, BadgeCheck,
} from "lucide-react";
import {
  useOwnerApi, fmtDate, relativeDays, StatusBadge, EmptyState, Loading, ErrorState, usePolling,
} from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/* ─── types (API contracts) ──────────────────────────────────────────────── */

type LeadStatus = "demo_requested" | "demo_done" | "trial_started" | "converted" | "lost";

interface Lead {
  id: string; businessName: string; contactName: string; email: string; phone: string;
  city: string; status: LeadStatus; notes: string; propertyId: string | null;
  createdAt: string; updatedAt: string;
}

interface OnbChecklist {
  propertyId: string; name: string; status: string; plan: string; startedAt: string | null;
  steps: { roomsAdded: boolean; staffCreated: boolean; otaConnected: boolean; firstBooking: boolean; credentialsSent: boolean; whatsappConnected: boolean };
  completion: number; stuck: boolean; stuckDays: number; trialAgeDays: number | null;
}

interface OnbResp { leads: Lead[]; checklists: OnbChecklist[]; stuckCount: number }

const STAGES: { key: LeadStatus; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "demo_requested", label: "Demo requested", icon: PhoneCall },
  { key: "demo_done", label: "Demo done", icon: CalendarCheck },
  { key: "trial_started", label: "Trial started", icon: Rocket },
  { key: "converted", label: "Converted", icon: BadgeCheck },
  { key: "lost", label: "Lost", icon: XCircle },
];

const STEPS: { key: keyof OnbChecklist["steps"]; label: string }[] = [
  { key: "roomsAdded", label: "Rooms added" },
  { key: "staffCreated", label: "Staff created" },
  { key: "otaConnected", label: "OTA connected" },
  { key: "firstBooking", label: "First booking" },
  { key: "whatsappConnected", label: "WhatsApp API connected" },
];

const EMPTY_LEAD = { businessName: "", contactName: "", email: "", phone: "", city: "", status: "demo_requested" as LeadStatus, notes: "" };

export default function OnboardingView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [data, setData] = useState<OnbResp | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [leadForm, setLeadForm] = useState({ ...EMPTY_LEAD });
  const [savingLead, setSavingLead] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api<OnbResp>("/api/owner/onboarding");
      setData(d);
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  usePolling(() => { void load(); }, 30000);

  const moveLead = async (lead: Lead, status: LeadStatus) => {
    if (status === lead.status) return;
    setMovingId(lead.id);
    try {
      await api<{ ok: boolean }>("/api/owner/onboarding", { method: "PATCH", body: JSON.stringify({ id: lead.id, status }) });
      toast({ title: "Lead moved", description: `${lead.businessName} → ${status.replace(/_/g, " ")}` });
      await load();
    } catch (e) {
      toast({ title: "Could not move lead", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setMovingId(null);
    }
  };

  const submitLead = async () => {
    if (!leadForm.businessName.trim() || !leadForm.contactName.trim()) {
      toast({ title: "Business name and contact name are required", variant: "destructive" });
      return;
    }
    setSavingLead(true);
    try {
      await api<{ ok: boolean }>("/api/owner/onboarding", { method: "POST", body: JSON.stringify(leadForm) });
      toast({ title: "Lead added", description: leadForm.businessName });
      setAddOpen(false);
      setLeadForm({ ...EMPTY_LEAD });
      await load();
    } catch (e) {
      toast({ title: "Could not add lead", description: String((e as Error).message), variant: "destructive" });
    } finally {
      setSavingLead(false);
    }
  };

  if (loading && !data) return <Loading label="Loading onboarding pipeline…" />;
  if (err && !data) return <ErrorState message={err} onRetry={() => void load()} />;

  const leads = data?.leads ?? [];
  const checklists = data?.checklists ?? [];
  const stuckCount = data?.stuckCount ?? 0;

  return (
    <div className="space-y-4">
      {/* stuck alert strip */}
      {stuckCount > 0 && (
        <div className="flex items-center gap-2.5 rounded-md border border-warn/50 bg-warn/10 px-4 py-3" role="alert">
          <TriangleAlert className="h-4.5 w-4.5 text-warn shrink-0" />
          <p className="text-[13px] text-warn font-medium">
            {stuckCount} {stuckCount === 1 ? "business is" : "businesses are"} stuck 7+ days in onboarding — check the activation checklist below.
          </p>
        </div>
      )}

      {/* leads pipeline */}
      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title flex items-center gap-2">
            <Route className="h-4 w-4 text-brass" /> Leads pipeline
            <span className="badge border-line-strong bg-plaster text-muted-ink">{leads.length}</span>
          </h2>
          <button className="btn-pine h-8" onClick={() => setAddOpen(true)}>
            <Plus className="h-3.5 w-3.5" /> Add lead
          </button>
        </div>
        {leads.length === 0 ? (
          <EmptyState
            icon={Route}
            title="No leads in the pipeline yet"
            hint="Capture demo requests here and move them toward trial and conversion."
          />
        ) : (
          <div className="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
            {STAGES.map((stage) => {
              const stageLeads = leads.filter((l) => l.status === stage.key);
              return (
                <div key={stage.key} className="rounded-md border border-line bg-plaster/40 flex flex-col">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-line/70">
                    <stage.icon className="h-3.5 w-3.5 text-brass" />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink flex-1">{stage.label}</span>
                    <span className="badge border-line-strong bg-panel text-muted-ink">{stageLeads.length}</span>
                  </div>
                  <div className="p-2 space-y-2 max-h-96 overflow-y-auto scroll-slim min-h-[72px]">
                    {stageLeads.length === 0 ? (
                      <p className="text-[11px] text-muted-ink text-center py-3 border border-dashed border-line-strong rounded-md">No leads</p>
                    ) : (
                      stageLeads.map((lead) => (
                        <div key={lead.id} className="rounded-md border border-line bg-panel px-2.5 py-2 group">
                          <div className="flex items-start justify-between gap-1">
                            <p className="text-[13px] font-semibold text-pine leading-snug">{lead.businessName}</p>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button
                                  className="btn-ghost h-6 w-6 p-0 shrink-0 opacity-60 group-hover:opacity-100"
                                  aria-label={`Move ${lead.businessName}`}
                                  disabled={movingId === lead.id}
                                >
                                  {movingId === lead.id ? <Plus className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3 rotate-45" />}
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-44">
                                <DropdownMenuLabel>Move to stage</DropdownMenuLabel>
                                <DropdownMenuSeparator />
                                {STAGES.filter((s) => s.key !== lead.status).map((s) => (
                                  <DropdownMenuItem key={s.key} onClick={() => void moveLead(lead, s.key)}>
                                    <s.icon className="h-3.5 w-3.5 mr-2" /> {s.label}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          <p className="text-[11px] text-muted-ink mt-0.5">{lead.contactName}</p>
                          <div className="flex items-center justify-between mt-1.5 text-[10px] text-muted-ink">
                            <span>{lead.city || "—"}</span>
                            <span>{relativeDays(lead.updatedAt)}</span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* activation checklists */}
      <div className="panel">
        <div className="panel-header">
          <h2 className="panel-title flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-brass" /> Activation checklists</h2>
          <span className="text-xs text-muted-ink">{checklists.length} businesses</span>
        </div>
        {checklists.length === 0 ? (
          <EmptyState icon={BedDouble} title="No active businesses" hint="Onboard a business to start tracking its activation checklist." />
        ) : (
          <div className="px-4 py-1 divide-y divide-line/70">
            {checklists.map((c) => (
              <div key={c.propertyId} className="py-3 flex flex-col lg:flex-row lg:items-center gap-2.5">
                <div className="flex-1 min-w-0 lg:max-w-[280px]">
                  <p className="text-[13px] font-medium text-pine truncate">{c.name}</p>
                  <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                    <span className="badge border-brass/40 bg-brass-50 text-brass">{c.plan}</span>
                    <StatusBadge status={c.status} />
                  </div>
                </div>

                <div className="flex items-center gap-3 lg:gap-4 flex-1" role="list" aria-label={`Setup steps for ${c.name}`}>
                  {STEPS.map((s) => {
                    const done = c.steps[s.key];
                    return (
                      <span key={s.key} role="listitem" className="flex items-center gap-1.5" title={`${s.label}: ${done ? "done" : "pending"}`}>
                        {done ? (
                          <CheckCircle2 className="h-4 w-4 text-ok" />
                        ) : (
                          <Circle className="h-4 w-4 text-line-strong" />
                        )}
                        <span className={`text-[11px] hidden xl:inline ${done ? "text-ink" : "text-muted-ink"}`}>{s.label}</span>
                      </span>
                    );
                  })}
                </div>

                <div className="flex items-center gap-2.5 lg:w-56">
                  <Progress value={c.completion} className="h-1.5 flex-1" aria-label={`${c.name} ${c.completion}% complete`} />
                  <span className="text-[11px] tabular-nums text-muted-ink w-8 text-right">{c.completion}%</span>
                  {c.stuck && (
                    <span className="badge border-warn/50 bg-warn/10 text-warn shrink-0" title={`In onboarding for ${c.stuckDays} days`}>
                      stuck {c.stuckDays}d
                    </span>
                  )}
                </div>

                <span className="text-[10px] text-muted-ink lg:w-24 lg:text-right whitespace-nowrap">
                  {c.startedAt ? `started ${fmtDate(c.startedAt)}` : "not started"}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* add lead dialog */}
      <Dialog open={addOpen} onOpenChange={(o) => { if (!o) setAddOpen(false); }}>
        <DialogContent className="max-w-md bg-panel">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">Add lead</DialogTitle>
            <DialogDescription>Capture a prospect into the pipeline — they can be moved through the stages as they progress.</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="sm:col-span-2">
              <Label className="field-label">Business name *</Label>
              <Input className="field" value={leadForm.businessName} onChange={(e) => setLeadForm({ ...leadForm, businessName: e.target.value })} placeholder="Sunset Resorts Goa" />
            </div>
            <div className="sm:col-span-2">
              <Label className="field-label">Contact name *</Label>
              <Input className="field" value={leadForm.contactName} onChange={(e) => setLeadForm({ ...leadForm, contactName: e.target.value })} placeholder="Priya Nair" />
            </div>
            <div>
              <Label className="field-label">Email</Label>
              <Input className="field" type="email" value={leadForm.email} onChange={(e) => setLeadForm({ ...leadForm, email: e.target.value })} />
            </div>
            <div>
              <Label className="field-label">Phone</Label>
              <Input className="field" value={leadForm.phone} onChange={(e) => setLeadForm({ ...leadForm, phone: e.target.value })} />
            </div>
            <div>
              <Label className="field-label">City</Label>
              <Input className="field" value={leadForm.city} onChange={(e) => setLeadForm({ ...leadForm, city: e.target.value })} />
            </div>
            <div>
              <Label className="field-label">Stage</Label>
              <Select value={leadForm.status} onValueChange={(v) => setLeadForm({ ...leadForm, status: v as LeadStatus })}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STAGES.map((s) => (
                    <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="sm:col-span-2">
              <Label className="field-label">Notes</Label>
              <Textarea className="min-h-[72px]" value={leadForm.notes} onChange={(e) => setLeadForm({ ...leadForm, notes: e.target.value })} placeholder="Met at FHRAI expo, wants demo next week…" />
            </div>
          </div>
          <DialogFooter>
            <button className="btn-outline" onClick={() => setAddOpen(false)}>Cancel</button>
            <button className="btn-pine" onClick={() => void submitLead()} disabled={savingLead || !leadForm.businessName.trim() || !leadForm.contactName.trim()}>
              <Users className="h-4 w-4" /> {savingLead ? "Adding…" : "Add lead"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
