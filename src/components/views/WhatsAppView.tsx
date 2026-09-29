"use client";

import { useCallback, useEffect, useState } from "react";
import { api, qs } from "@/lib/api-client";
import { fmtDateTime, STATUS_LABELS } from "@/lib/format";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  BellRing, ChevronDown, ChevronUp, Clock, Loader2, MessageCircle, PlugZap, RefreshCw, Send, Sparkles, TicketCheck,
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

export default function WhatsAppView() {
  const { toast } = useToast();

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [messages, setMessages] = useState<WhatsAppMessage[] | null>(null);
  const [templateFilter, setTemplateFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState<string | null>(null);

  // custom send dialog
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customPhone, setCustomPhone] = useState("");
  const [customBody, setCustomBody] = useState("");
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, m] = await Promise.all([
        api<StatusResponse>("/api/whatsapp/status"),
        api<{ messages: WhatsAppMessage[] }>(
          `/api/whatsapp/messages${qs({ template: templateFilter, status: statusFilter })}`
        ),
      ]);
      setStatus(s);
      setMessages(m.messages);
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
                  : "Set WHATSAPP_TOKEN + WHATSAPP_PHONE_ID to go live — messages are logged as Simulated meanwhile"}
              </span>
            </>
          )}
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
          footer={<span className="text-[11px] text-muted-ink">Automatic on booking_engine bookings</span>}
        />
        <TemplateCard
          icon={<BellRing className="h-4 w-4 text-brass" />}
          title="Pre-arrival Reminder"
          description="Goes to tomorrow's confirmed arrivals — offers airport pickup and early check-in. Fires automatically at night audit; duplicates are never sent."
          lastSent={lastSent("pre_arrival")}
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
          footer={
            <button className="btn-outline h-8 text-xs" onClick={() => triggerBulk("post_stay")} disabled={bulkBusy === "post_stay"}>
              {bulkBusy === "post_stay" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send bulk now
            </button>
          }
        />
      </div>

      {/* Message log */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title">Message log</p>
          <div className="flex items-center gap-2">
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
              {(messages ?? []).map((m) => (
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
  icon, title, description, lastSent, footer,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  lastSent: string | null;
  footer: React.ReactNode;
}) {
  return (
    <div className="panel p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2.5">
        <div className="h-8 w-8 rounded-md bg-plaster-deep/60 flex items-center justify-center shrink-0">{icon}</div>
        <p className="font-display font-semibold text-pine">{title}</p>
      </div>
      <p className="text-xs text-muted-ink flex-1">{description}</p>
      {lastSent && (
        <p className="text-[11px] text-muted-ink flex items-center gap-1.5">
          <Clock className="h-3 w-3" /> Last sent {fmtDateTime(lastSent)}
        </p>
      )}
      <div>{footer}</div>
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
