"use client";

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/api-client";
import { fmtDateTime, STATUS_LABELS } from "@/lib/format";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  BellRing, ChevronDown, ChevronUp, Clock, Loader2, MessageCircle, PlugZap, RefreshCw, Search, Send, Settings2, Sparkles, TicketCheck,
} from "lucide-react";

interface WhatsAppMessage {
  id: string;
  toPhone: string;
  templateName: string;
  body: string;
  status: string;
  reservationId: string | null;
  providerId: string;
  createdAt: string;
  reservation?: { confirmationNumber: string } | null;
}
interface StatusResponse {
  provider: "cloud_api" | "mock";
  phoneIdSet: boolean;
  fromNumber: string;
}
interface TriggerResponse {
  sent: number;
  eligible: number;
  skippedNoPhone: number;
  skippedAlreadyMessaged?: number;
}
interface TemplateInfo {
  name: "booking_confirmation" | "pre_arrival" | "post_stay";
  body: string | null; // null → built-in default copy
  custom: boolean;
  placeholders: string[];
  sample: string | null; // rendered preview from the server (custom bodies)
  auto: boolean;
}

const TEMPLATE_META: Record<string, { label: string; badge: string }> = {
  booking_confirmation: { label: "Booking Conf.", badge: "border-pine-700/30 bg-pine-100 text-pine-700" },
  pre_arrival: { label: "Pre-arrival", badge: "border-brass/40 bg-brass-50 text-brass" },
  post_stay: { label: "Post-stay", badge: "border-ok/40 bg-ok/10 text-ok" },
  custom: { label: "Custom", badge: "border-line-strong bg-plaster text-muted-ink" },
};
const STATUS_BADGE: Record<string, string> = {
  mock: "border-brass/40 bg-brass-50 text-brass",
  sent: "border-ok/40 bg-ok/10 text-ok",
  queued: "border-line-strong bg-plaster text-muted-ink",
  failed: "border-danger/30 bg-danger/10 text-danger",
};

/** Client-side placeholder renderer — mirrors the server's renderWaTemplate. */
function renderPreview(body: string, vars: Record<string, string | number>): string {
  return body.replace(/\{(\w+)\}/g, (m, key: string) => (key in vars ? String(vars[key]) : m));
}

export default function WhatsAppView() {
  const { toast } = useToast();
  const user = useSession((s) => s.user);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [templateFilter, setTemplateFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  // custom send dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customPhone, setCustomPhone] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [sending, setSending] = useState(false);

  // customize-template dialog
  const [editName, setEditName] = useState<TemplateInfo["name"] | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m, t] = await Promise.all([
        api<StatusResponse>("/api/whatsapp/status"),
        api<{ messages: WhatsAppMessage[] }>(
          `/api/whatsapp/messages${qs({ template: templateFilter, status: statusFilter })}`
        ),
        api<{ templates: TemplateInfo[] }>("/api/whatsapp/templates").catch(() => null),
      ]);
      setStatus(s);
      setMessages(m.messages);
      if (t) setTemplates(t.templates);
    } catch {
      /* keep stale */
    }
  }, [templateFilter, statusFilter]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  const lastSent = (template: string) =>
    messages?.find((m) => m.templateName === template)?.createdAt ?? null;

  const tplByName = (name: TemplateInfo["name"]) => templates?.find((t) => t.name === name);

  const toggleAuto = async (name: TemplateInfo["name"], auto: boolean) => {
    setTemplates((prev) => prev?.map((t) => (t.name === name ? { ...t, auto } : t)) ?? prev);
    try {
      await api("/api/whatsapp/templates", { method: "PATCH", body: JSON.stringify({ templateName: name, auto }) });
      toast({ title: auto ? "Automatic sending on" : "Automatic sending off", description: `${TEMPLATE_META[name].label} — ${auto ? "guests get it automatically" : "only when you send it manually"}` });
    } catch (e) {
      setTemplates((prev) => prev?.map((t) => (t.name === name ? { ...t, auto: !auto } : t)) ?? prev);
      toast({ title: "Could not update", description: (e as Error).message, variant: "destructive" });
    }
  };

  const openCustomize = (name: TemplateInfo["name"]) => {
    const t = tplByName(name);
    setEditName(name);
    setEditBody(t?.body ?? ""); // stored copy; empty shows the default hint
  };

  const saveTemplate = async (reset = false) => {
    if (!editName) return;
    setSavingTpl(true);
    try {
      await api("/api/whatsapp/templates", {
        method: "PATCH",
        body: JSON.stringify({ templateName: editName, body: reset ? "" : editBody }),
      });
      toast({ title: reset ? "Template reset to default" : "Template saved" });
      setEditName(null);
      load();
    } catch (e) {
      toast({ title: "Save failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSavingTpl(false);
    }
  };

  /** Live preview for the customize dialog (sample guest data). */
  const editPreview = () => {
    const t = editName ? tplByName(editName) : null;
    if (!t || !editName) return "";
    const tomorrow = new Date(Date.now() + 86400000);
    const vars: Record<string, string | number> = {
      hotel: user?.propertyName || "Your Hotel",
      guest: "Rahul",
      confirmation: "VX-24816",
      room: "Deluxe Room",
      checkin: tomorrow.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }),
      nights: 2,
      amount: "₹8,500",
    };
    if (!editBody.trim()) return "(Using the built-in default — start typing to customize)";
    return renderPreview(editBody, vars);
  };

  const triggerBulk = async (kind: "pre_arrival" | "post_stay") => {
    setBulkBusy(kind);
    try {
      const res = await api<TriggerResponse>("/api/whatsapp/trigger", {
        method: "POST",
        body: JSON.stringify({ kind }),
      });
      toast({
        title:
          res.sent === 0
            ? `No new ${kind === "pre_arrival" ? "pre-arrival" : "post-stay"} messages needed`
            : `Sent ${res.sent} ${kind === "pre_arrival" ? "pre-arrival" : "post-stay"} message${res.sent === 1 ? "" : "s"}`,
        description:
          res.sent === 0 && res.skippedAlreadyMessaged
            ? `${res.skippedAlreadyMessaged} guest${res.skippedAlreadyMessaged === 1 ? " was" : "s were"} already messaged — no duplicates sent.`
            : [
                res.eligible ? `${res.eligible} eligible` : kind === "pre_arrival" ? "No confirmed arrivals tomorrow." : "No check-outs today.",
                res.skippedNoPhone ? `${res.skippedNoPhone} skipped (no phone)` : "",
                res.skippedAlreadyMessaged ? `${res.skippedAlreadyMessaged} already messaged` : "",
              ]
                .filter(Boolean)
                .join(" · ") || undefined,
      });
      load();
    } catch (e) {
      toast({ title: "Trigger failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBulkBusy(null);
    }
  };

  const sendCustom = async () => {
    if (!customPhone.trim() || !customBody.trim()) {
      toast({ title: "Phone and message body are required", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      await api("/api/whatsapp/send", {
        method: "POST",
        body: JSON.stringify({ toPhone: customPhone.trim(), templateName: "custom", body: customBody.trim() }),
      });
      toast({ title: "Message sent" });
      setDialogOpen(false);
      setCustomPhone("");
      setCustomBody("");
      load();
    } catch (e) {
      toast({ title: "Send failed", description: (e as Error).message, variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const filteredMessages = (messages ?? []).filter((m) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return m.toPhone.toLowerCase().includes(q) || m.body.toLowerCase().includes(q) || (m.reservation?.confirmationNumber ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      {/* Header: provider status */}
      <div className="panel px-5 py-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-md bg-pine-100 flex items-center justify-center">
            <MessageCircle className="h-4.5 w-4.5 text-pine-700" />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold text-pine leading-tight">WhatsApp Business</h2>
            <p className="text-xs text-muted-ink">Guest lifecycle messaging — confirmations, reminders, feedback</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {status && (
            <>
              <span
                className={cn(
                  "badge",
                  status.provider === "cloud_api"
                    ? "border-ok/40 bg-ok/10 text-ok"
                    : "border-brass/40 bg-brass-50 text-brass"
                )}
              >
                <PlugZap className="h-3 w-3" />
                {status.provider === "cloud_api" ? "Cloud API connected" : "Simulation mode"}
              </span>
              <span className="text-[11px] text-muted-ink hidden md:block">
                {status.phoneIdSet
                  ? `Phone ID ${status.fromNumber}`
                  : "Connect your WhatsApp Cloud API from Settings → WhatsApp API to go live"}
              </span>
            </>
          )}
          <button
            type="button"
            className="btn-outline h-9 text-xs"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("velurex:navigate", { detail: "settings" }));
              toast({ title: "Opening Settings", description: "Use the WhatsApp API tab to connect your Cloud API credentials." });
            }}
          >
            <Settings2 className="h-4 w-4" /> Manage connection
          </button>
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button className="btn-brass h-9">
                <Send className="h-4 w-4" /> Send custom message
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="font-display text-pine">Send custom message</DialogTitle>
                <DialogDescription>Free-form WhatsApp message to any phone number.</DialogDescription>
              </DialogHeader>
              <div className="space-y-3">
                <div>
                  <label className="field-label">To (phone)</label>
                  <input
                    className="field"
                    placeholder="+91 98200 00000"
                    value={customPhone}
                    onChange={(e) => setCustomPhone(e.target.value)}
                  />
                </div>
                <div>
                  <label className="field-label">Message</label>
                  <Textarea
                    rows={4}
                    placeholder="Hi! …"
                    value={customBody}
                    onChange={(e) => setCustomBody(e.target.value)}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                <Button className="btn-brass" onClick={sendCustom} disabled={sending}>
                  {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Template cards */}
      <div className="grid md:grid-cols-3 gap-4">
        <TemplateCard
          icon={<TicketCheck className="h-4 w-4 text-pine-700" />}
          title="Booking Confirmation"
          description="Fires automatically the moment an online booking is confirmed — room, dates and amount included."
          lastSent={lastSent("booking_confirmation")}
          tpl={tplByName("booking_confirmation")}
          onToggleAuto={toggleAuto}
          onCustomize={openCustomize}
          footer={<span className="text-[11px] text-muted-ink">Automatic on booking_engine bookings</span>}
        />
        <TemplateCard
          icon={<BellRing className="h-4 w-4 text-brass" />}
          title="Pre-arrival Reminder"
          description="Goes to tomorrow's confirmed arrivals — offers airport pickup and early check-in. Fires automatically at night audit; duplicates are never sent."
          lastSent={lastSent("pre_arrival")}
          tpl={tplByName("pre_arrival")}
          onToggleAuto={toggleAuto}
          onCustomize={openCustomize}
          footer={
            <button className="btn-outline h-8 text-xs" onClick={() => triggerBulk("pre_arrival")} disabled={bulkBusy === "pre_arrival"}>
              {bulkBusy === "pre_arrival" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send bulk now
            </button>
          }
        />
        <TemplateCard
          icon={<Sparkles className="h-4 w-4 text-ok" />}
          title="Post-stay Feedback"
          description="Sent to guests who checked out today — asks for a 1-5 rating reply."
          lastSent={lastSent("post_stay")}
          tpl={tplByName("post_stay")}
          onToggleAuto={toggleAuto}
          onCustomize={openCustomize}
          footer={
            <button className="btn-outline h-8 text-xs" onClick={() => triggerBulk("post_stay")} disabled={bulkBusy === "post_stay"}>
              {bulkBusy === "post_stay" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send bulk now
            </button>
          }
        />
      </div>

      {/* Customize-template dialog */}
      <Dialog open={!!editName} onOpenChange={(o) => !o && setEditName(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display text-pine">
              Customize — {editName ? TEMPLATE_META[editName].label : ""}
            </DialogTitle>
            <DialogDescription>
              Personalise the copy. Use placeholders like <code className="text-pine font-mono text-[11px]">{"{guest}"}</code> — they fill in per guest automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {editName && (
              <div className="flex flex-wrap gap-1.5">
                {(tplByName(editName)?.placeholders ?? []).map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="badge border-line-strong bg-plaster text-[10.5px] text-muted-ink hover:text-pine hover:border-pine/40 transition cursor-pointer"
                    onClick={() => setEditBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}${p}`)}
                  >
                    {p}
                  </button>
                ))}
              </div>
            )}
            <Textarea
              rows={5}
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              placeholder={
                editName === "booking_confirmation"
                  ? "Hi {guest}! Your booking {confirmation} at {hotel} is confirmed. 🏨 Room: {room} · Check-in: {checkin} · {nights} night(s) · {amount}"
                  : editName === "pre_arrival"
                    ? "Hi {guest}, we look forward to welcoming you to {hotel} tomorrow! Your booking {confirmation} — check-in from 2 PM. Need an airport pickup or early check-in? Just reply here."
                    : "Thank you for staying with us at {hotel}, {guest}! We'd love your feedback — rate your stay 1-5 by replying to this message."
              }
              maxLength={1000}
            />
            <div className="rounded-md bg-plaster/60 border border-line px-3.5 py-3">
              <p className="text-[10.5px] uppercase tracking-[0.14em] text-muted-ink mb-1.5">Preview (sample data)</p>
              <p className="text-[13px] whitespace-pre-wrap text-ink">{editPreview()}</p>
            </div>
          </div>
          <DialogFooter className="justify-between">
            <Button variant="ghost" className="text-muted-ink" onClick={() => saveTemplate(true)} disabled={savingTpl}>
              Reset to default
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setEditName(null)}>Cancel</Button>
              <Button className="btn-brass" onClick={() => saveTemplate(false)} disabled={savingTpl}>
                {savingTpl ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Message log */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Message log</p>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-ink" />
              <input
                className="field h-8 w-40 pl-8 text-xs"
                placeholder="Search phone / text…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search messages"
              />
            </div>
            <select
              className="field h-8 w-auto text-xs py-0"
              value={templateFilter}
              onChange={(e) => setTemplateFilter(e.target.value)}
            >
              <option value="">All templates</option>
              {Object.entries(TEMPLATE_META).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
            <select
              className="field h-8 w-auto text-xs py-0"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">All statuses</option>
              {Object.keys(STATUS_BADGE).map((s) => (
                <option key={s} value={s}>{STATUS_LABELS[s] ?? s}</option>
              ))}
            </select>
            <button className="btn-ghost h-8 text-xs" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>
        <div className="overflow-x-auto scroll-slim">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr>
                <th className="th">Time</th>
                <th className="th">To</th>
                <th className="th">Template</th>
                <th className="th">Body</th>
                <th className="th">Reservation</th>
                <th className="th">Status</th>
                <th className="th"></th>
              </tr>
            </thead>
            <tbody>
              {filteredMessages.map((m) => (
                <WhatsAppRow
                  key={m.id}
                  m={m}
                  expanded={expandedId === m.id}
                  onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
                />
              ))}
              {messages && messages.length === 0 && (
                <tr>
                  <td className="td text-center text-muted-ink" colSpan={7}>
                    No messages yet — bookings and bulk triggers will appear here.
                  </td>
                </tr>
              )}
              {messages && messages.length > 0 && filteredMessages.length === 0 && (
                <tr>
                  <td className="td text-center text-muted-ink" colSpan={7}>
                    No messages match “{search}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-line px-4 py-2 text-[11px] text-muted-ink">
          Auto-refreshes every 30s · newest 100 messages
        </div>
      </div>
    </div>
  );
}

function TemplateCard({
  icon, title, description, lastSent, footer, tpl, onToggleAuto, onCustomize,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  lastSent: string | null;
  footer: React.ReactNode;
  tpl?: TemplateInfo;
  onToggleAuto: (name: TemplateInfo["name"], auto: boolean) => void;
  onCustomize: (name: TemplateInfo["name"]) => void;
}) {
  return (
    <div className="panel p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-md bg-plaster-deep/60 flex items-center justify-center shrink-0">{icon}</div>
        <p className="font-display font-semibold text-pine flex-1">{title}</p>
        {tpl?.custom && (
          <span className="badge border-pine-700/30 bg-pine-100 text-pine-700 text-[10px]">Customized</span>
        )}
      </div>
      <p className="text-xs text-muted-ink flex-1">{description}</p>
      {lastSent && (
        <p className="text-[11px] text-muted-ink flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> Last sent {fmtDateTime(lastSent)}
        </p>
      )}
      {tpl && (
        <div className="flex items-center justify-between gap-2 rounded-md bg-plaster/60 border border-line px-3 py-2">
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-ink leading-tight">Auto-send</p>
            <p className="text-[10.5px] text-muted-ink leading-tight">{tpl.auto ? "On — fires automatically" : "Off — manual only"}</p>
          </div>
          <Switch
            checked={tpl.auto}
            onCheckedChange={(v) => onToggleAuto(tpl.name, v)}
            aria-label={`Toggle automatic sending for ${title}`}
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-2">
        {tpl ? (
          <button className="btn-ghost h-8 text-xs" onClick={() => onCustomize(tpl.name)}>
            <Settings2 className="h-3.5 w-3.5" /> Customize
          </button>
        ) : (
          <span />
        )}
        {footer}
      </div>
    </div>
  );
}

function WhatsAppRow({ m, expanded, onToggle }: { m: WhatsAppMessage; expanded: boolean; onToggle: () => void }) {
  const meta = TEMPLATE_META[m.templateName] ?? TEMPLATE_META.custom;
  return (
    <>
      <tr className="hover:bg-plaster/50 align-top">
        <td className="td whitespace-nowrap text-xs text-muted-ink">{fmtDateTime(m.createdAt)}</td>
        <td className="td whitespace-nowrap font-medium text-pine">{m.toPhone}</td>
        <td className="td">
          <span className={cn("badge", meta.badge)}>{meta.label}</span>
        </td>
        <td className="td max-w-[320px]">
          <p className={cn("text-[13px] text-ink", !expanded && "truncate")}>{m.body}</p>
        </td>
        <td className="td whitespace-nowrap text-xs text-muted-ink">
          {m.reservation?.confirmationNumber ?? "—"}
        </td>
        <td className="td">
          <span className={cn("badge", STATUS_BADGE[m.status] ?? "")}>{STATUS_LABELS[m.status] ?? m.status}</span>
        </td>
        <td className="td text-right">
          <button className="btn-ghost h-7 px-2 text-xs" onClick={onToggle} aria-label="Toggle full message">
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="px-4 pb-4">
            <div className="rounded-md bg-plaster/60 border border-line px-4 py-3">
              <p className="text-[13px] whitespace-pre-wrap text-ink">{m.body}</p>
              {m.providerId && <p className="text-[11px] text-muted-ink mt-2">Provider ID: {m.providerId}</p>}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
