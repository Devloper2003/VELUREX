import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { logPlatformAction, nextInvoiceNumber, platformGstRate } from "@/lib/platform";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/billing — invoice ledger. Filters: status, propertyId, search,
 * month (YYYY-MM). Pagination. Includes payment summary.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "";
  const propertyId = sp.get("propertyId") ?? "";
  const search = sp.get("search")?.trim() ?? "";
  const month = sp.get("month") ?? "";
  const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(50, Math.max(5, parseInt(sp.get("pageSize") ?? "12", 10) || 12));

  const where: Record<string, unknown> = { ...notDemoTenant(scope) };
  if (status) where.status = status;
  if (propertyId) where.propertyId = { equals: propertyId, notIn: scope.demoIds };
  if (search) where.number = { contains: search, mode: "insensitive" };
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    where.createdAt = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
  }

  const [total, invoices, agg] = await Promise.all([
    db.invoice.count({ where }),
    db.invoice.findMany({
      where,
      include: {
        property: { select: { id: true, name: true, city: true } },
        payments: true,
        items: true,
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    db.invoice.groupBy({ by: ["status"], where: notDemoTenant(scope), _count: true, _sum: { totalAmount: true } }),
  ]);

  const summary = {
    paid: agg.find((a) => a.status === "paid")?._sum.totalAmount ?? 0,
    paidCount: agg.find((a) => a.status === "paid")?._count ?? 0,
    pending: agg.find((a) => a.status === "pending")?._sum.totalAmount ?? 0,
    pendingCount: agg.find((a) => a.status === "pending")?._count ?? 0,
    overdue: agg.find((a) => a.status === "overdue")?._sum.totalAmount ?? 0,
    overdueCount: agg.find((a) => a.status === "overdue")?._count ?? 0,
  };

  return NextResponse.json({
    invoices: invoices.map((inv) => ({
      id: inv.id,
      number: inv.number,
      property: inv.property,
      type: inv.type,
      status: inv.status,
      subtotal: inv.subtotal,
      discountAmount: inv.discountAmount,
      taxAmount: inv.taxAmount,
      totalAmount: inv.totalAmount,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      dueDate: inv.dueDate,
      paidAt: inv.paidAt,
      notes: inv.notes,
      items: inv.items,
      payments: inv.payments.map((p) => ({
        id: p.id, amount: p.amount, method: p.method, status: p.status, kind: p.kind,
        reference: p.reference, paidAt: p.paidAt, createdAt: p.createdAt,
      })),
      createdAt: inv.createdAt,
    })),
    summary, total, page, pageSize, pages: Math.ceil(total / pageSize),
  });
}

/**
 * POST /api/owner/billing — create a manual invoice.
 * Body: { propertyId, description, amount, dueInDays?, notes? }
 */
export async function POST(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const owner = auth.session;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const propertyId = String(body.propertyId ?? "");
  const amount = Number(body.amount ?? 0);
  const description = String(body.description ?? "Manual invoice").trim();
  if (!propertyId || amount <= 0)
    return NextResponse.json({ error: "propertyId and a positive amount are required" }, { status: 400 });

  const property = await db.property.findUnique({ where: { id: propertyId } });
  if (!property) return NextResponse.json({ error: "Business not found" }, { status: 404 });

  const gst = await platformGstRate();
  const tax = Math.round(amount * (gst / 100) * 100) / 100;
  const number = await nextInvoiceNumber();
  const dueInDays = Math.max(0, parseInt(String(body.dueInDays ?? "7"), 10) || 7);

  const invoice = await db.invoice.create({
    data: {
      number, propertyId, type: "manual", status: "pending",
      subtotal: amount, taxAmount: tax, totalAmount: Math.round((amount + tax) * 100) / 100,
      dueDate: new Date(Date.now() + dueInDays * 86400000),
      notes: String(body.notes ?? ""),
    },
  });
  await db.invoiceItem.create({
    data: { invoiceId: invoice.id, description, qty: 1, unitPrice: amount, taxRate: gst, amount },
  });

  await logPlatformAction({
    actorId: owner.sub, actorName: owner.email, action: "INVOICE_CREATED",
    entity: "invoice", entityId: invoice.id, propertyId,
    details: `Manual invoice ${number} for ${property.name} — ₹${invoice.totalAmount} (GST ${gst}%)`,
  });

  return NextResponse.json({ ok: true, invoice: { id: invoice.id, number } }, { status: 201 });
}
