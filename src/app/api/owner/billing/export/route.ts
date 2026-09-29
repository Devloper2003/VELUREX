import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireOwner } from "@/lib/auth";
import { getPlatformSetting } from "@/lib/platform";
import { demoScope, notDemoTenant } from "@/lib/owner-demo";

/**
 * GET /api/owner/billing/export?month=YYYY-MM — monthly revenue CSV (Excel-ready).
 * Honours the excel_export entitlement on the SOURCE tenant? No — this is the
 * platform owner's own export, always allowed.
 */
export async function GET(req: NextRequest) {
  const auth = await requireOwner(req);
  if ("error" in auth) return auth.error;
  const scope = await demoScope(auth.session, req);

  const month = req.nextUrl.searchParams.get("month") ?? "";
  let from: Date;
  let to: Date;
  if (/^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    from = new Date(y, m - 1, 1);
    to = new Date(y, m, 1);
  } else {
    const now = new Date();
    from = new Date(now.getFullYear(), now.getMonth(), 1);
    to = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  }

  const payments = await db.platformPayment.findMany({
    where: { createdAt: { gte: from, lt: to }, kind: "payment", ...notDemoTenant(scope) },
    include: { property: { select: { name: true, city: true } }, invoice: { select: { number: true, type: true, status: true } } },
    orderBy: { createdAt: "asc" },
  });

  const gst = Number(await getPlatformSetting("gst_rate").then((v) => v ?? "18")) || 18;

  const header = ["Date", "Invoice", "Business", "City", "Type", "Method", "Reference", "Net (₹)", `GST ${gst}% (₹)`, "Total (₹)"];
  const rows = payments.map((p): [string, string, string, string, string, string, string, number, number, number] => {
    const total = p.amount;
    const net = Math.round((total / (1 + gst / 100)) * 100) / 100;
    const tax = Math.round((total - net) * 100) / 100;
    return [
      p.createdAt.toISOString().slice(0, 10),
      p.invoice?.number ?? "—",
      p.property?.name ?? "—",
      p.property?.city ?? "",
      p.invoice?.type ?? "manual",
      p.method,
      p.reference || "—",
      net, tax, total,
    ];
  });
  const totalCol = rows.reduce((s, r) => s + r[9], 0);

  const csv = [
    header.join(","),
    ...rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")),
    `"TOTAL","","","","","","","${Math.round(totalCol / (1 + gst / 100))}","${Math.round(totalCol - totalCol / (1 + gst / 100))}","${Math.round(totalCol)}"`,
  ].join("\n");

  const monthLabel = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="velurex-revenue-${monthLabel}.csv"`,
    },
  });
}
