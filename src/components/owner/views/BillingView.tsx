"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Plus, Download, MoreHorizontal, Eye, Wallet, Link2, Undo2, FileText,
  Ban, CheckCircle2, ReceiptText, Printer, Loader2,
} from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { printHtml } from "@/lib/print";
import { useSession } from "@/lib/store";
import { useToast } from "@/hooks/use-toast";
import {
  useOwnerApi, inr, fmtDate, fmtDateTime, StatusBadge,
  EmptyState, Loading, ErrorState, StatCard,
} from "@/components/owner/shared";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PropertyRef { id: string; name: string; city: string; }

interface InvoiceItemRow {
  id: string; description: string; qty: number; unitPrice: number; taxRate: number; amount: number;
}

interface InvoicePaymentRow {
  id: string; amount: number; method: string; status: string; kind: string;
  reference: string; paidAt: string | null; createdAt: string;
}

interface InvoiceRow {
  id: string;
  number: string;
  property: PropertyRef;
  type: string;
  status: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  periodStart: string | null;
  periodEnd: string | null;
  dueDate: string | null;
  paidAt: string | null;
  notes: string;
  items: InvoiceItemRow[];
  payments: InvoicePaymentRow[];
  createdAt: string;
}

interface BillingSummary {
  paid: number; paidCount: number; pending: number; pendingCount: number;
  overdue: number; overdueCount: number;
}

interface BillingList {
  invoices: InvoiceRow[]; summary: BillingSummary;
  total: number; page: number; pageSize: number; pages: number;
}

interface BillingDetail {
  invoice: InvoiceRow;
  company: { name: string; gstin: string; termsUrl: string };
}

const hesc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hdate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
    : "—";
const hmoney = (n: number) =>
  `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Standalone print document for a platform (SaaS) invoice — printed via the hidden-frame pipeline. */
function platformInvoiceHtml(detail: BillingDetail): string {
  const { invoice: inv, company } = detail;
  const rows = inv.items
    .map(
      (it) => `<tr>
        <td>${hesc(it.description)}</td>
        <td class="r">${it.qty}</td>
        <td class="r">${hmoney(it.unitPrice)}</td>
        <td class="r">${it.taxRate}%</td>
        <td class="r">${hmoney(it.amount)}</td>
      </tr>`
    )
    .join("");
  const pays = inv.payments.length
    ? inv.payments
        .map(
          (p) =>
            `<tr><td>${hesc(p.kind)} · ${hesc(p.method)}${p.reference ? ` · ref ${hesc(p.reference)}` : ""}</td><td>${hdate(p.paidAt ?? p.createdAt)}</td><td class="r">${p.kind === "refund" ? "−" : ""}${hmoney(p.amount)}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="dim">No payments recorded yet.</td></tr>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"/><title>${hesc(inv.number)}</title>
<style>
  @page { margin: 12mm; }
  body { font-family: Georgia, 'Times New Roman', serif; color: #1c2622; background: #fff; margin: 24px auto; max-width: 720px; padding: 0 12px;
    -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  h1 { color: #0f2622; font-size: 22px; margin: 0; }
  .tag { color: #b9873e; letter-spacing: 3px; font-size: 16px; font-weight: bold; }
  .head { border-bottom: 3px solid #0f2622; padding-bottom: 12px; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .dim { color: #7a6f5d; font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
  th { text-align: left; border-bottom: 2px solid #d3c3a4; padding: 6px 8px; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #7a6f5d; }
  td { border-bottom: 1px solid #e3d7c1; padding: 7px 8px; }
  .r { text-align: right; white-space: nowrap; }
  .grand { border-top: 3px solid #0f2622; font-weight: bold; font-size: 15px; color: #0f2622; }
  .totals { margin-top: 12px; margin-left: auto; width: 260px; }
  .totals td { border: none; padding: 3px 8px; }
  .foot { margin-top: 24px; border-top: 1px solid #e3d7c1; padding-top: 10px; color: #7a6f5d; font-size: 11px; text-align: center; }
</style></head>
<body>
  <div class="head">
    <div><h1>${hesc(company.name)}</h1>${company.gstin ? `<p class="dim">GSTIN ${hesc(company.gstin)}</p>` : ""}</div>
    <div style="text-align:right"><p class="tag">TAX INVOICE</p><p class="dim">No: <b style="color:#1c2622">${hesc(inv.number)}</b><br/>Issued: ${hdate(inv.createdAt)} · Due: ${hdate(inv.dueDate)}${inv.paidAt ? `<br/><b style="color:#177a53">Paid ${hdate(inv.paidAt)}</b>` : ""}<br/>${hesc(TYPE_LABELS[inv.type] ?? inv.type)}${inv.periodStart || inv.periodEnd ? ` · ${hdate(inv.periodStart)} → ${hdate(inv.periodEnd)}` : ""}</p></div>
  </div>
  <p class="dim" style="margin:14px 0 0"><b style="color:#1c2622">${hesc(inv.property.name)}</b>${inv.property.city ? ` · ${hesc(inv.property.city)}` : ""}</p>
  <table><thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">GST</th><th class="r">Amount</th></tr></thead><tbody>${rows}</tbody></table>
  <table class="totals">
    <tr><td>Subtotal</td><td class="r">${hmoney(inv.subtotal)}</td></tr>
    ${inv.discountAmount > 0 ? `<tr><td>Discount</td><td class="r">−${hmoney(inv.discountAmount)}</td></tr>` : ""}
    <tr><td>GST</td><td class="r">${hmoney(inv.taxAmount)}</td></tr>
    <tr class="grand"><td>Total</td><td class="r">${hmoney(inv.totalAmount)}</td></tr>
  </table>
  <table><thead><tr><th>Payments</th><th>Date</th><th class="r">Amount</th></tr></thead><tbody>${pays}</tbody></table>
  ${inv.notes ? `<p class="dim" style="margin-top:14px;white-space:pre-line">${hesc(inv.notes)}</p>` : ""}
  <p class="foot">This GST invoice was generated by Velurex Technologies · ${hesc(inv.number)}</p>
</body></html>`;
}

interface BusinessRef { id: string; name: string; }

const TYPE_LABELS: Record<string, string> = {
  subscription: "Subscription",
  addon: "Add-on",
  setup: "Setup",
  manual: "Manual",
  credit_note: "Credit note",
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function BillingView() {
  const api = useOwnerApi();
  const token = useSession((s) => s.token);
  const { toast } = useToast();

  const [data, setData] = useState<BillingList | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [businesses, setBusinesses] = useState<BusinessRef[]>([]);

  const [status, setStatus] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const [search, setSearch] = useState("");
  const [month, setMonth] = useState("");
  const [page, setPage] = useState(1);

  const [detail, setDetail] = useState<BillingDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [payFor, setPayFor] = useState<InvoiceRow | null>(null);
  const [refundFor, setRefundFor] = useState<InvoiceRow | null>(null);
  const [creditFor, setCreditFor] = useState<InvoiceRow | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const qs = new URLSearchParams({ page: String(page), pageSize: "12" });
      if (status) qs.set("status", status);
      if (propertyId) qs.set("propertyId", propertyId);
      if (search.trim()) qs.set("search", search.trim());
      if (month) qs.set("month", month);
      const res = await api<BillingList>(`/api/owner/billing?${qs.toString()}`);
      setData(res);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [api, page, status, propertyId, search, month]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api<{ businesses: BusinessRef[] }>("/api/owner/businesses?pageSize=50")
      .then((r) => setBusinesses(r.businesses))
      .catch(() => setBusinesses([]));
  }, [api]);

  const openDetail = useCallback(async (id: string) => {
    setDetailOpen(true);
    setDetail(null);
    try {
      setDetail(await api<BillingDetail>(`/api/owner/billing/${id}`));
    } catch (e) {
      toast({ title: "Could not load invoice", description: errText(e), variant: "destructive" });
      setDetailOpen(false);
    }
  }, [api, toast]);

  async function act(inv: InvoiceRow, body: Record<string, unknown>, done: () => void) {
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; mode?: string; note?: string; link?: string }>(`/api/owner/billing/${inv.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (body.action === "send_payment_link") {
        if (res.mode === "stub") {
          toast({ title: "Payment link (stub)", description: res.note, variant: "destructive" });
        } else {
          toast({ title: "Payment link ready", description: res.note ?? res.link });
        }
      } else {
        toast({ title: "Done", description: `Invoice ${inv.number} updated.` });
      }
      done();
      await load();
      if (detailOpen) await openDetail(inv.id);
    } catch (e) {
      toast({ title: "Action failed", description: errText(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    try {
      const qs = month ? `?month=${month}` : "";
      const res = await fetch(`/api/owner/billing/export${qs}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `velurex-revenue-${month || new Date().toISOString().slice(0, 7)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast({ title: "Export ready", description: "Revenue CSV downloaded." });
    } catch (e) {
      toast({ title: "Export failed", description: errText(e), variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  const s = data?.summary;

  return (
    <div className="space-y-4">
      {/* KPI strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <StatCard label="Collected" value={inr(s?.paid)} sub={`${s?.paidCount ?? 0} invoices paid`} valueClass="text-ok" />
        <StatCard label="Pending" value={inr(s?.pending)} sub={`${s?.pendingCount ?? 0} awaiting payment`} valueClass="text-warn" />
        <StatCard label="Overdue" value={inr(s?.overdue)} sub={`${s?.overdueCount ?? 0} past due date`} valueClass="text-danger" />
      </div>

      {/* Toolbar */}
      <div className="panel p-3 flex flex-wrap items-center gap-2">
        <Select value={status} onValueChange={(v) => { setStatus(v === "all" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-36 h-9"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="paid">Paid</SelectItem>
            <SelectItem value="overdue">Overdue</SelectItem>
            <SelectItem value="refunded">Refunded</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
        <Select value={propertyId} onValueChange={(v) => { setPropertyId(v === "all" ? "" : v); setPage(1); }}>
          <SelectTrigger className="w-48 h-9"><SelectValue placeholder="All businesses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All businesses</SelectItem>
            {businesses.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-44 h-9"
          placeholder="Invoice no. e.g. VXL-2025…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
        />
        <Input type="month" className="w-40 h-9" value={month} onChange={(e) => { setMonth(e.target.value); setPage(1); }} aria-label="Filter by month" />
        <div className="flex-1" />
        <button className="btn-outline" onClick={() => void exportCsv()} disabled={exporting}>
          {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
          Export CSV{month ? ` · ${month}` : ""}
        </button>
        <button className="btn-pine" onClick={() => setNewOpen(true)}>
          <Plus className="h-4 w-4" />
          New invoice
        </button>
      </div>

      {/* Invoice table */}
      <div className="panel">
        <div className="panel-header">
          <p className="panel-title flex items-center gap-2"><ReceiptText className="h-4 w-4 text-brass" /> Invoices</p>
          <p className="text-xs text-muted-ink">{data ? `${data.total} invoice${data.total === 1 ? "" : "s"}` : "…"}</p>
        </div>
        {loading ? (
          <Loading label="Loading invoices…" />
        ) : error ? (
          <ErrorState message={error} onRetry={() => void load()} />
        ) : !data || data.invoices.length === 0 ? (
          <EmptyState icon={ReceiptText} title="No invoices match" hint="Adjust the filters above, or create a manual invoice for a business." />
        ) : (
          <div className="overflow-x-auto scroll-slim">
            <table className="w-full min-w-[860px]">
              <thead>
                <tr>
                  <th className="th">Number</th>
                  <th className="th">Business</th>
                  <th className="th">Type</th>
                  <th className="th">Amount</th>
                  <th className="th">GST</th>
                  <th className="th">Status</th>
                  <th className="th">Due</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.id} className="hover:bg-plaster/50 transition">
                    <td className="td font-medium text-pine">{inv.number}</td>
                    <td className="td">
                      <span className="block">{inv.property.name}</span>
                      <span className="text-xs text-muted-ink">{inv.property.city}</span>
                    </td>
                    <td className="td"><span className="badge border-line-strong bg-plaster text-muted-ink">{TYPE_LABELS[inv.type] ?? inv.type}</span></td>
                    <td className="td font-medium">{inr(inv.totalAmount)}</td>
                    <td className="td text-muted-ink">{inr(inv.taxAmount)}</td>
                    <td className="td"><StatusBadge status={inv.status} /></td>
                    <td className="td text-muted-ink">{fmtDate(inv.dueDate)}</td>
                    <td className="td text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="btn-ghost px-2" aria-label={`Actions for ${inv.number}`}>
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52">
                          <DropdownMenuItem onClick={() => void openDetail(inv.id)}>
                            <Eye className="h-4 w-4" /> View invoice
                          </DropdownMenuItem>
                          {(inv.status === "pending" || inv.status === "overdue") && (
                            <>
                              <DropdownMenuItem onClick={() => setPayFor(inv)}>
                                <Wallet className="h-4 w-4" /> Record payment
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void act(inv, { action: "send_payment_link" }, () => {})}>
                                <Link2 className="h-4 w-4" /> Send payment link
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => void act(inv, { action: "mark_paid" }, () => {})}>
                                <CheckCircle2 className="h-4 w-4" /> Mark paid
                              </DropdownMenuItem>
                            </>
                          )}
                          {inv.status === "paid" && (
                            <DropdownMenuItem onClick={() => setRefundFor(inv)}>
                              <Undo2 className="h-4 w-4" /> Refund
                            </DropdownMenuItem>
                          )}
                          {(inv.status === "pending" || inv.status === "overdue" || inv.status === "paid") && (
                            <DropdownMenuItem onClick={() => setCreditFor(inv)}>
                              <FileText className="h-4 w-4" /> Credit note
                            </DropdownMenuItem>
                          )}
                          {(inv.status === "pending" || inv.status === "overdue") && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-danger focus:text-danger" onClick={() => void act(inv, { action: "cancel" }, () => {})}>
                                <Ban className="h-4 w-4" /> Cancel invoice
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-line">
            <p className="text-xs text-muted-ink">Page {data.page} of {data.pages}</p>
            <div className="flex gap-2">
              <button className="btn-outline h-8" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
              <button className="btn-outline h-8" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {/* Detail / print dialog */}
      <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
        <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {detail ? detail.invoice.number : "Invoice"}
              {detail && <StatusBadge status={detail.invoice.status} />}
            </DialogTitle>
            <DialogDescription>
              {detail ? `${detail.invoice.property.name}${detail.invoice.property.city ? ` · ${detail.invoice.property.city}` : ""}` : "Loading…"}
            </DialogDescription>
          </DialogHeader>
          {!detail ? (
            <Loading label="Loading invoice…" />
          ) : (
            <div className="space-y-4">
              {/* Company header */}
              <div className="panel p-4 bg-plaster/60">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-display text-base font-semibold text-pine">{detail.company.name}</p>
                    {detail.company.gstin && <p className="text-xs text-muted-ink mt-0.5">GSTIN {detail.company.gstin}</p>}
                  </div>
                  <div className="text-right text-xs text-muted-ink">
                    <p>Issued {fmtDate(detail.invoice.createdAt)}</p>
                    <p>Due {fmtDate(detail.invoice.dueDate)}</p>
                    {detail.invoice.paidAt && <p className="text-ok">Paid {fmtDate(detail.invoice.paidAt)}</p>}
                  </div>
                </div>
                {(detail.invoice.periodStart || detail.invoice.periodEnd) && (
                  <p className="text-xs text-muted-ink mt-2">
                    Period {fmtDate(detail.invoice.periodStart)} → {fmtDate(detail.invoice.periodEnd)}
                  </p>
                )}
              </div>

              {/* Line items */}
              <div className="overflow-x-auto scroll-slim">
                <table className="w-full min-w-[420px]">
                  <thead>
                    <tr>
                      <th className="th">Description</th>
                      <th className="th text-right">Qty</th>
                      <th className="th text-right">Unit price</th>
                      <th className="th text-right">GST</th>
                      <th className="th text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.invoice.items.map((it) => (
                      <tr key={it.id} className="transition-colors hover:bg-plaster/40">
                        <td className="td">{it.description}</td>
                        <td className="td text-right">{it.qty}</td>
                        <td className="td text-right">{inr(it.unitPrice)}</td>
                        <td className="td text-right text-muted-ink">{it.taxRate}%</td>
                        <td className="td text-right font-medium">{inr(it.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Totals */}
              <div className="ml-auto w-full sm:w-64 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-muted-ink">Subtotal</span><span>{inr(detail.invoice.subtotal)}</span></div>
                <div className="flex justify-between"><span className="text-muted-ink">Discount</span><span>−{inr(detail.invoice.discountAmount)}</span></div>
                <div className="flex justify-between"><span className="text-muted-ink">GST</span><span>{inr(detail.invoice.taxAmount)}</span></div>
                <Separator />
                <div className="flex justify-between font-semibold text-pine"><span>Total</span><span>{inr(detail.invoice.totalAmount)}</span></div>
              </div>

              {/* Payments */}
              <div>
                <p className="field-label">Payments</p>
                {detail.invoice.payments.length === 0 ? (
                  <EmptyState icon={Wallet} title="No payments recorded yet" />
                ) : (
                  <div className="max-h-40 overflow-y-auto scroll-slim space-y-1.5">
                    {detail.invoice.payments.map((p) => (
                      <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm">
                        <div className="flex items-center gap-2">
                          <span className="badge border-line-strong bg-plaster text-muted-ink capitalize">{p.kind}</span>
                          <span className="capitalize">{p.method}</span>
                          {p.reference && <span className="text-xs text-muted-ink">ref {p.reference}</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-muted-ink">{fmtDateTime(p.paidAt ?? p.createdAt)}</span>
                          <span className={`font-medium ${p.kind === "refund" ? "text-danger" : "text-ok"}`}>{p.kind === "refund" ? "−" : ""}{inr(p.amount)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {detail.invoice.notes && (
                <p className="text-xs text-muted-ink whitespace-pre-line border border-line rounded-md p-3 bg-plaster/50">{detail.invoice.notes}</p>
              )}

              <p className="text-[11px] text-muted-ink print:mt-2">
                This GST invoice was generated by Velurex Technologies. Use Print → “Save as PDF” to email it to the business.
              </p>
            </div>
          )}
          <DialogFooter>
            <button
              className="btn-outline"
              onClick={() => detail && printHtml(platformInvoiceHtml(detail), detail.invoice.number)}
            >
              <Printer className="h-4 w-4" /> Print
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Record payment dialog — key remounts to reset fields per invoice */}
      <PayDialog
        key={`pay-${payFor?.id ?? "none"}`}
        invoice={payFor}
        busy={busy}
        onClose={() => setPayFor(null)}
        onSubmit={(body) => payFor ? act(payFor, body, () => setPayFor(null)) : Promise.resolve()}
      />

      {/* Refund dialog (AlertDialog confirm) — key remounts to reset fields */}
      <RefundDialog
        key={`refund-${refundFor?.id ?? "none"}`}
        invoice={refundFor}
        busy={busy}
        onClose={() => setRefundFor(null)}
        onSubmit={(body) => (refundFor ? act(refundFor, body, () => setRefundFor(null)) : Promise.resolve())}
      />

      {/* Credit note dialog — key remounts to reset fields */}
      <CreditDialog
        key={`credit-${creditFor?.id ?? "none"}`}
        invoice={creditFor}
        busy={busy}
        onClose={() => setCreditFor(null)}
        onSubmit={(body) => (creditFor ? act(creditFor, body, () => setCreditFor(null)) : Promise.resolve())}
      />

      {/* New manual invoice dialog */}
      <NewInvoiceDialog
        open={newOpen}
        businesses={businesses}
        busy={busy}
        onClose={() => setNewOpen(false)}
        onCreated={async () => { setNewOpen(false); await load(); }}
      />
    </div>
  );
}

// ─── Record payment dialog ───────────────────────────────────────────────────

function PayDialog({ invoice, busy, onClose, onSubmit }: {
  invoice: InvoiceRow | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  // Initialisers run on every remount (parent passes a key per invoice).
  const [amount, setAmount] = useState(() => String(invoice?.totalAmount ?? ""));
  const [method, setMethod] = useState("upi");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

  return (
    <Dialog open={!!invoice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment — {invoice?.number}</DialogTitle>
          <DialogDescription>Log an offline payment received from {invoice?.property.name}.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="pay-amount">Amount (₹)</Label>
            <Input id="pay-amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label>Method</Label>
            <Select value={method} onValueChange={setMethod}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="upi">UPI</SelectItem>
                <SelectItem value="bank">Bank transfer</SelectItem>
                <SelectItem value="razorpay">Razorpay</SelectItem>
                <SelectItem value="cash">Cash</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="pay-ref">Reference (UTR / txn id)</Label>
            <Input id="pay-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="optional" />
          </div>
          <div>
            <Label htmlFor="pay-notes">Notes</Label>
            <Textarea id="pay-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <DialogFooter>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-pine"
            disabled={busy || !Number(amount)}
            onClick={() => void onSubmit({ action: "record_payment", amount: Number(amount), method, reference, notes })}
          >
            Record payment
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Refund dialog (AlertDialog confirm) ─────────────────────────────────────

function RefundDialog({ invoice, busy, onClose, onSubmit }: {
  invoice: InvoiceRow | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  // Initialisers run on every remount (parent passes a key per invoice).
  const [amount, setAmount] = useState(() => String(invoice?.totalAmount ?? ""));
  const [notes, setNotes] = useState("");

  return (
    <AlertDialog open={!!invoice} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Refund invoice {invoice?.number}</AlertDialogTitle>
          <AlertDialogDescription>
            This issues a refund to {invoice?.property.name} and marks the invoice refunded. The action is written to the audit trail.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="refund-amount">Refund amount (₹)</Label>
            <Input id="refund-amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="refund-notes">Note (optional)</Label>
            <Input id="refund-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. goodwill credit" />
          </div>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep invoice</AlertDialogCancel>
          <AlertDialogAction
            className="bg-danger text-white hover:bg-danger/90"
            disabled={busy || !Number(amount)}
            onClick={(e) => {
              e.preventDefault();
              void onSubmit({ action: "refund", amount: Number(amount), notes });
            }}
          >
            Issue refund
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Credit note dialog ──────────────────────────────────────────────────────

function CreditDialog({ invoice, busy, onClose, onSubmit }: {
  invoice: InvoiceRow | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
}) {
  // Initialisers run on every remount (parent passes a key per invoice).
  const [amount, setAmount] = useState(() => String(invoice?.totalAmount ?? ""));
  const [reason, setReason] = useState("");

  return (
    <Dialog open={!!invoice} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Credit note — {invoice?.number}</DialogTitle>
          <DialogDescription>Applies a credit to {invoice?.property.name} and cancels the invoice.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label htmlFor="credit-amount">Credit amount (₹)</Label>
            <Input id="credit-amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="credit-reason">Reason</Label>
            <Input id="credit-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. service outage on 12 Mar" />
          </div>
        </div>
        <DialogFooter>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-pine"
            disabled={busy || !Number(amount) || !reason.trim()}
            onClick={() => void onSubmit({ action: "credit_note", amount: Number(amount), reason: reason.trim() })}
          >
            Apply credit note
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── New manual invoice dialog ───────────────────────────────────────────────

function NewInvoiceDialog({ open, businesses, busy, onClose, onCreated }: {
  open: boolean;
  businesses: BusinessRef[];
  busy: boolean;
  onClose: () => void;
  onCreated: () => void | Promise<void>;
}) {
  const api = useOwnerApi();
  const { toast } = useToast();
  const [propertyId, setPropertyId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [dueInDays, setDueInDays] = useState("7");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setPropertyId(businesses[0]?.id ?? "");
      setDescription("");
      setAmount("");
      setDueInDays("7");
      setNotes("");
    }
  }, [open, businesses]);

  async function submit() {
    setSaving(true);
    try {
      const res = await api<{ ok: boolean; invoice: { number: string } }>("/api/owner/billing", {
        method: "POST",
        body: JSON.stringify({
          propertyId,
          description: description.trim() || "Manual invoice",
          amount: Number(amount),
          dueInDays: Number(dueInDays) || 0,
          notes,
        }),
      });
      toast({ title: "Invoice created", description: `${res.invoice.number} for ₹${amount} is pending.` });
      await onCreated();
    } catch (e) {
      toast({ title: "Could not create invoice", description: e instanceof Error ? e.message : "Try again", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New manual invoice</DialogTitle>
          <DialogDescription>One-off charge for a business. GST is applied at the configured rate.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div>
            <Label>Business</Label>
            <Select value={propertyId} onValueChange={setPropertyId}>
              <SelectTrigger className="w-full"><SelectValue placeholder="Select business" /></SelectTrigger>
              <SelectContent>
                {businesses.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="inv-desc">Description</Label>
            <Input id="inv-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. POS add-on — March" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="inv-amount">Amount (₹, excl. GST)</Label>
              <Input id="inv-amount" type="number" min="0" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
            </div>
            <div>
              <Label htmlFor="inv-due">Due in (days)</Label>
              <Input id="inv-due" type="number" min="0" value={dueInDays} onChange={(e) => setDueInDays(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="inv-notes">Notes</Label>
            <Textarea id="inv-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="optional" />
          </div>
        </div>
        <DialogFooter>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-pine" disabled={saving || busy || !propertyId || !Number(amount)} onClick={() => void submit()}>
            Create invoice
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


