import { NextRequest, NextResponse } from "next/server";
import { validatePromo } from "../_shared";

/**
 * POST /api/booking-engine/promo — public: validate a promo code against an
 * order amount. Always 200; `valid` carries the outcome so the widget can show
 * inline feedback.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { code?: string; amount?: number } | null;
  if (!body) return NextResponse.json({ valid: false, message: "Invalid JSON body" });

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0)
    return NextResponse.json({ valid: false, message: "A positive order amount is required" });

  const result = await validatePromo(String(body.code ?? ""), amount);
  if (!result.valid) return NextResponse.json({ valid: false, message: result.message });

  return NextResponse.json({
    valid: true,
    code: result.code,
    description: result.description,
    discount: result.discount,
  });
}
