"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  LifeBuoy, Lock, Send, StickyNote, Timer, CheckCircle2, AlertCircle, Search, UserCheck,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  useOwnerApi, fmtDateTime, relativeDays, StatusBadge, EmptyState, Loading, ErrorState, StatCard,
} from "@/components/owner/shared";
import { useToast } from "@/hooks/use-toast";

// ─── Types ───────────────────────────────────────────────────────────────────

interface TicketProperty { id: string; name: string; city: string; subscriptionStatus: string; }

interface TicketRow {
  id: string;
  subject: string;
  category: string;
  priority: string;
  status: string;
  createdByName: string;
  assignedTo: string;
  property: TicketProperty;
  messageCount: number;
  lastMessage: { body: string; authorType: string; internal: boolean; at: string } | null;
  firstResponseAt: string | null;
  responseTimeMins: number | null;
  ageHours: number;
  resolvedAt: string | null;
  createdAt: string;
}

interface TicketMessage {
  id: string;
  authorType: string;
  authorName: string;
  body: string;
  internal: boolean;
  createdAt: string;
}

interface TicketDetail {
  ticket: TicketRow & { property: TicketProperty & { planName: string } };
  messages: TicketMessage[];
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: "bg-danger",
  high: "bg-warn",
  normal: "bg-line-strong",
  low: "bg-muted-ink/40",
};

const STATUSES = ["open", "in_progress", "waiting", "resolved", "closed"] as const;
const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const OPEN_SET = new Set(["open", "in_progress", "waiting"]);

function ageLabel(hours: number): string {
  if (hours >= 48) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function TicketsView() {
  const api = useOwnerApi();
  const { toast } = useToast();

  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [status, setStatus] = useState("all_open");
  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");

  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams();
      // "all_open" cannot be expressed server-side (single status) — fetch all,
      // filter to the open set client-side below. Exact statuses go server-side.
      if (status !== "all_open") qs.set("status", status);
      if (priority) qs.set("priority", priority);
      if (search.trim()) qs.set("search", search.trim());
      const res = await api<{ tickets: TicketRow[]; total: number }>(`/api/owner/tickets?${qs.toString()}`);
      setTickets(status === "all_open" ? res.tickets.filter((t) => OPEN_SET.has(t.status)) : res.tickets);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api, status, priority, search]);

  useEffect(() => { void load(); }, [load]);

  const openTicket = tickets.find((t) => t.id === openId) ?? null;
  const responded = tickets.filter((t) => t.responseTimeMins !== null);
  const avgResponse = responded.length
    ? Math.round(responded.reduce((sum, t) => sum + (t.responseTimeMins ?? 0), 0) / responded.length)
    : null;

  const kpis: { label: string; value: string; tone?: string; chip: "brass" | "pine" | "ok" | "warn" | "danger"; icon: React.ComponentType<{ className?: string }> }[] = [
    { label: "Open", value: String(tickets.filter((t) => OPEN_SET.has(t.status)).length), tone: "text-danger", chip: "danger", icon: AlertCircle },
    { label: "Urgent", value: String(tickets.filter((t) => t.priority === "urgent").length), tone: "text-danger", chip: "danger", icon: LifeBuoy },
    { label: "Avg first response", value: avgResponse === null ? "—" : `${avgResponse} min`, tone: "text-warn", chip: "warn", icon: Timer },
    { label: "Resolved", value: String(tickets.filter((t) => t.status === "resolved").length), tone: "text-ok", chip: "ok", icon: CheckCircle2 },
  ];

  return (
    <div className="space-y-4">
      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {kpis.map((k) => (
          <StatCard key={k.label} label={k.label} value={k.value} icon={k.icon} tone={k.chip} valueClass={k.tone} />
        ))}
      </div>

      {/* Toolbar */}
      <div className="panel p-3 flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => setStatus(v)}>
          <SelectTrigger className="w-40 h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all_open">All open</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={priority} onValueChange={(v) => setPriority(v === "all" ? "" : v)}>
          <SelectTrigger className="w-36 h-9"><SelectValue placeholder="All priorities" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All priorities</SelectItem>
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="relative">
          <Search className="h-3.5 w-3.5 text-muted-ink absolute left-2.5 top-1/2 -translate-y-1/2" />
          <Input
            className="w-56 h-9 pl-8"
            placeholder="Search subject or business…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div className="flex-1" />
        <p className="text-xs text-muted-ink">{tickets.length} ticket{tickets.length === 1 ? "" : "s"}</p>
      </div>

      {/* Ticket list */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><LifeBuoy className="h-4 w-4 text-brass" /> Ticket queue</p>
          <p className="text-xs text-muted-ink">Ordered by priority, then age</p>
        </div>
        {loading ? (
          <Loading label="Loading tickets…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : tickets.length === 0 ? (
          <EmptyState icon={LifeBuoy} title="Queue is clear" hint="No tickets match the current filters." />
        ) : (
          <ul className="max-h-96 overflow-y-auto scroll-slim divide-y divide-line/70">
            {tickets.map((t) => (
              <li key={t.id}>
                <button
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-plaster/60 transition"
                  onClick={() => setOpenId(t.id)}
                >
                  <span className={`h-2 w-2 rounded-full shrink-0 ${PRIORITY_DOT[t.priority] ?? "bg-line-strong"}`} title={`Priority: ${t.priority}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-pine truncate">{t.subject}</span>
                    <span className="block text-xs text-muted-ink truncate">
                      {t.property.name} · {t.createdByName} · {t.messageCount} message{t.messageCount === 1 ? "" : "s"}
                      {t.lastMessage ? ` · last: ${t.lastMessage.internal ? "internal note" : t.lastMessage.authorType}` : ""}
                    </span>
                  </span>
                  <StatusBadge status={t.status} className="hidden sm:inline-flex" />
                  <span className="text-xs text-muted-ink w-10 text-right shrink-0">{ageLabel(t.ageHours)}</span>
                  <span className="hidden md:block text-xs text-muted-ink w-36 truncate text-right shrink-0" title={t.assignedTo || "Unassigned"}>
                    {t.assignedTo || "Unassigned"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Thread dialog */}
      <TicketThread
        ticketId={openId}
        onClose={() => setOpenId(null)}
        onChanged={() => { void load(); }}
        toastFn={toast}
      />
    </div>
  );
}

// ─── Thread dialog ───────────────────────────────────────────────────────────

function TicketThread({ ticketId, onClose, onChanged, toastFn }: {
  ticketId: string | null;
  onClose: () => void;
  onChanged: () => void;
  toastFn: ReturnType<typeof useToast>["toast"];
}) {
  const api = useOwnerApi();
  const [detail, setDetail] = useState<TicketDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [assignTo, setAssignTo] = useState("owner@velurex.in");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const fetchThread = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const res = await api<TicketDetail>(`/api/owner/tickets/${id}`);
      setDetail(res);
      setAssignTo(res.ticket.assignedTo || "owner@velurex.in");
    } catch (e) {
      toastFn({ title: "Could not load ticket", description: errText(e), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [api, toastFn]);

  useEffect(() => {
    if (ticketId) {
      setDetail(null);
      setReply("");
      void fetchThread(ticketId);
    } else {
      setDetail(null);
    }
  }, [ticketId, fetchThread]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [detail?.messages.length]);

  async function patch(body: Record<string, unknown>, okMsg: string) {
    if (!ticketId) return;
    setSending(true);
    try {
      await api(`/api/owner/tickets/${ticketId}`, { method: "PATCH", body: JSON.stringify(body) });
      toastFn({ title: okMsg });
      await fetchThread(ticketId);
      onChanged();
    } catch (e) {
      toastFn({ title: "Action failed", description: errText(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  }

  async function sendReply(internal: boolean) {
    const text = reply.trim();
    if (!text) return;
    await patch({ action: "reply", body: text, internal }, internal ? "Internal note added" : "Reply sent");
    setReply("");
  }

  const t = detail?.ticket;

  return (
    <Dialog open={!!ticketId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2 pr-6">
            {t?.subject ?? "Ticket"}
            {t && <StatusBadge status={t.status} />}
            {t && <span className={`badge capitalize ${t.priority === "urgent" ? "border-danger/50 bg-danger/10 text-danger" : t.priority === "high" ? "border-warn/50 bg-warn/10 text-warn" : "border-line-strong bg-plaster text-muted-ink"}`}>{t.priority}</span>}
          </DialogTitle>
          <DialogDescription>
            {t ? `${t.property.name}${t.property.city ? ` · ${t.property.city}` : ""} · ${t.property.planName} · opened ${fmtDateTime(t.createdAt)} (${relativeDays(t.createdAt)})` : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {loading && !t ? (
          <Loading label="Loading thread…" />
        ) : t ? (
          <>
            {/* Header controls */}
            <div className="flex flex-wrap items-end gap-2 border border-line rounded-md p-3 bg-plaster/50">
              <div className="flex-1 min-w-52">
                <p className="field-label">Assign to</p>
                <div className="flex gap-1.5">
                  <Input className="h-9" value={assignTo} onChange={(e) => setAssignTo(e.target.value)} />
                  <button className="btn-outline shrink-0" disabled={sending} onClick={() => void patch({ action: "assign", assignedTo: assignTo.trim() || "owner@velurex.in" }, "Ticket assigned")}>
                    <UserCheck className="h-4 w-4" /> Assign
                  </button>
                </div>
              </div>
              <div className="w-36">
                <p className="field-label">Status</p>
                <Select value={t.status} onValueChange={(v) => void patch({ action: "status", status: v }, `Status → ${v.replace(/_/g, " ")}`)}>
                  <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="w-32">
                <p className="field-label">Priority</p>
                <Select value={t.priority} onValueChange={(v) => void patch({ action: "priority", priority: v }, `Priority → ${v}`)}>
                  <SelectTrigger className="w-full h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map((p) => (
                      <SelectItem key={p} value={p}>{p}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Thread */}
            <div className="flex-1 min-h-40 max-h-80 overflow-y-auto scroll-slim space-y-3 rounded-md border border-line p-3">
              {detail!.messages.length === 0 && (
                <EmptyState icon={LifeBuoy} title="No messages in this thread yet" hint="Replies and internal notes will appear here." />
              )}
              {detail!.messages.map((m) => {
                if (m.authorType === "tenant") {
                  return (
                    <div key={m.id} className="flex justify-start">
                      <div className="max-w-[80%] rounded-lg rounded-bl-sm bg-plaster border border-line px-3 py-2">
                        <p className="text-[11px] text-muted-ink mb-1">{m.authorName} · {fmtDateTime(m.createdAt)}</p>
                        <p className="text-sm text-ink whitespace-pre-line">{m.body}</p>
                      </div>
                    </div>
                  );
                }
                if (m.internal) {
                  return (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[80%] rounded-lg rounded-br-sm bg-warn/10 border border-warn/40 px-3 py-2">
                        <p className="text-[11px] text-warn font-medium flex items-center gap-1 mb-1">
                          <Lock className="h-3 w-3" /> Internal note · {m.authorName} · {fmtDateTime(m.createdAt)}
                        </p>
                        <p className="text-sm text-ink whitespace-pre-line">{m.body}</p>
                      </div>
                    </div>
                  );
                }
                return (
                  <div key={m.id} className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg rounded-br-sm bg-pine text-panel px-3 py-2">
                      <p className="text-[11px] text-panel/60 mb-1">{m.authorName} · {fmtDateTime(m.createdAt)}</p>
                      <p className="text-sm whitespace-pre-line">{m.body}</p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>

            {/* Composer */}
            <div>
              <Textarea
                rows={3}
                placeholder="Write a reply to the tenant…"
                value={reply}
                onChange={(e) => setReply(e.target.value)}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 mt-2">
                <p className="text-[11px] text-muted-ink">A public reply moves the ticket to <span className="text-warn">waiting</span>; internal notes keep the status.</p>
                <div className="flex gap-2">
                  <button className="btn-outline" disabled={sending || !reply.trim()} onClick={() => void sendReply(true)}>
                    <StickyNote className="h-4 w-4" /> Add internal note
                  </button>
                  <button className="btn-pine" disabled={sending || !reply.trim()} onClick={() => void sendReply(false)}>
                    <Send className="h-4 w-4" /> Reply
                  </button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
