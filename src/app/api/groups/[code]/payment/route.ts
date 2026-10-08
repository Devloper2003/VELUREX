import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";
import { emitRealtime } from "@/lib/realtime-server";
import { round2 } from "@/app/api/invoice/_shared";
import { handleRoute } from "@/lib/route-error";

/**
 * POST /api/groups/[code]/payment — collect a payment against a group.
 *
 * Body: { amount, method, reference?, mode: "master" | "distribute" }
 *
 * mode "master":     a single payment recorded on the designated master (payer)
 *                    folio. Overpayments are allowed (advance deposit).
 * mode "distribute": the amount is auto-split across member folios by
 *                    outstanding balance (largest balance first, waterfall
 *                    allocation). Capped at the total group balance — use
 *                    "master" mode for advance deposits.
 *
 * Every allocation creates a Payment row with provenance in `reference` and
 * increments the member's paidAmount transactionally. Idempotent replays are
 * supported via clientRef (derived per allocation from the request clientRef).
 */

const PAYMENT_METHODS = ["cash", "upi", "card", "netbanking", "razorpay"];
const toPaise = (r: number) => Math.round(r * 100);

export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  return handleRoute("groups.payment", () => groupPayPost(req, { params }));
}

async function groupPayPost(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> }
): Promise<NextResponse> {
  const auth = await requireAuth(req, ["hotel_admin", "front_desk"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;
  const { code } = await params;
  const groupCode = decodeURIComponent(code).trim();
  if (!groupCode) return NextResponse.json({ error: "Group code is required" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const amount = Number(body.amount);
  const method = typeof body.method === "string" ? body.method : "";
  const reference = typeof body.reference === "string" ? body.reference.trim() : "";
  const mode = body.mode === "distribute" ? "distribute" : body.mode === "master" ? "master" : "";
  const clientRef = typeof body.clientRef === "string" ? body.clientRef.trim() : "";

  if (!Number.isFinite(amount) || amount <= 0) {
    return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 });
  }
  if (!PAYMENT_METHODS.includes(method)) {
    return NextResponse.json({ error: `Invalid method — must be one of: ${PAYMENT_METHODS.join(", ")}` }, { status: 400 });
  }
  if (!mode) {
    return NextResponse.json({ error: 'mode must be "master" or "distribute"' }, { status: 400 });
  }

  const members = await db.reservation.findMany({
    where: { propertyId, groupCode },
    include: { guest: { select: { fullName: true } }, room: { select: { number: true } } },
    orderBy: [{ room: { number: "asc" } }, { createdAt: "asc" }],
  });
  if (members.length === 0) {
    return NextResponse.json({ error: `No reservations found for group "${groupCode}"` }, { status: 404 });
  }

  // Idempotent replay: same clientRef → return the original allocations
  if (clientRef) {
    const priorRefs = members.map((m) => `${clientRef}:${m.id}`);
    const existing = await db.payment.findMany({
      where: { propertyId, clientRef: { in: priorRefs }, reservationId: { in: members.map((m) => m.id) } },
    });
    if (existing.length > 0) {
      const totals = await groupTotals(members.map((m) => m.id));
      return NextResponse.json({
        mode,
        payments: existing.map((p) => ({ id: p.id, reservationId: p.reservationId })),
        allocations: existing.map((p) => ({ reservationId: p.reservationId, amount: p.amount })),
        totals,
        idempotentReplay: true,
      });
    }
  }

  const balanceOf = new Map<string, number>();
  for (const m of members) {
    const agg = await db.folioItem.aggregate({ where: { reservationId: m.id }, _sum: { amount: true } });
    balanceOf.set(m.id, round2((agg._sum.amount ?? 0) - m.paidAmount));
  }
  const totalBalance = round2([...balanceOf.values()].reduce((s, b) => s + b, 0));

  let allocations: { reservationId: string; amount: number }[] = [];

  if (mode === "master") {
    const master = members.find((m) => m.groupMaster);
    if (!master) {
      return NextResponse.json(
        { error: "Designate a master payer folio first — or use auto-distribute to split the payment across rooms" },
        { status: 400 }
      );
    }
    allocations = [{ reservationId: master.id, amount: round2(amount) }];
  } else {
    if (totalBalance <= 0) {
      return NextResponse.json({ error: "Group has no outstanding balance to distribute against" }, { status: 400 });
    }
    if (round2(amount) > totalBalance) {
      return NextResponse.json(
        { error: `Amount ₹${round2(amount).toFixed(2)} exceeds the total group balance ₹${totalBalance.toFixed(2)} — collect the excess against the master folio instead` },
        { status: 400 }
      );
    }
    // Waterfall: settle the largest outstanding balances first (paise-exact)
    let remaining = toPaise(Math.min(amount, totalBalance));
    const sorted = members
      .filter((m) => (balanceOf.get(m.id) ?? 0) > 0)
      .sort((a, b) => (balanceOf.get(b.id) ?? 0) - (balanceOf.get(a.id) ?? 0));
    for (const m of sorted) {
      if (remaining <= 0) break;
      const bal = toPaise(balanceOf.get(m.id) ?? 0);
      const give = Math.min(bal, remaining);
      if (give > 0) {
        allocations.push({ reservationId: m.id, amount: give / 100 });
        remaining -= give;
      }
    }
    allocations = allocations.map((a) => ({ ...a, amount: round2(a.amount) }));
  }

  const shareRef = (rid: string) =>
    mode === "master"
      ? reference
      : `${reference ? `${reference} · ` : ""}Group ${groupCode} auto-split`;

  const created = await db.$transaction(async (tx) => {
    const rows: { paymentId: string; reservationId: string }[] = [];
    for (const a of allocations) {
      const payment = await tx.payment.create({
        data: {
          propertyId,
          reservationId: a.reservationId,
          amount: a.amount,
          method,
          status: "success",
          reference: shareRef(a.reservationId),
          receivedBy: auth.session.name,
          clientRef: clientRef ? `${clientRef}:${a.reservationId}` : "",
        },
      });
      await tx.reservation.update({
        where: { id: a.reservationId },
        data: { paidAmount: { increment: a.amount } },
      });
      rows.push({ paymentId: payment.id, reservationId: a.reservationId });
    }
    return rows;
  });

  const payeeNames = new Map(members.map((m) => [m.id, `${m.guest.fullName} (${m.room?.number ?? m.confirmationNumber})`]));
  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "GROUP_PAYMENT",
    entity: "payment",
    entityId: created[0]?.paymentId ?? groupCode,
    details:
      mode === "master"
        ? `Group ${groupCode}: ₹${round2(amount).toFixed(2)} via ${method.toUpperCase()} collected on master folio (${payeeNames.get(allocations[0].reservationId) ?? ""})${reference ? ` · ref ${reference}` : ""}`
        : `Group ${groupCode}: ₹${round2(amount).toFixed(2)} via ${method.toUpperCase()} auto-distributed across ${created.length} room folio(s) — ${allocations.map((a) => `${payeeNames.get(a.reservationId)} ₹${a.amount.toFixed(2)}`).join(", ")}`,
  });

  for (const a of allocations) {
    emitRealtime("global", "folio:update", { reservationId: a.reservationId, kind: "group-payment", amount: a.amount });
  }

  const totals = await groupTotals(members.map((m) => m.id));
  return NextResponse.json(
    {
      mode,
      payments: created.map((c) => ({ id: c.paymentId, reservationId: c.reservationId })),
      allocations,
      totals,
    },
    { status: 201 }
  );
}

async function groupTotals(ids: string[]) {
  const [res, folio] = await Promise.all([
    db.reservation.findMany({ where: { id: { in: ids } }, select: { id: true, paidAmount: true } }),
    db.folioItem.groupBy({ by: ["reservationId"], where: { reservationId: { in: ids } }, _sum: { amount: true } }),
  ]);
  const chargesBy = new Map(folio.map((f) => [f.reservationId, f._sum.amount ?? 0]));
  let charges = 0;
  let paid = 0;
  for (const r of res) {
    charges += chargesBy.get(r.id) ?? 0;
    paid += r.paidAmount;
  }
  charges = round2(charges);
  paid = round2(paid);
  return { charges, paid, balance: round2(charges - paid) };
}
