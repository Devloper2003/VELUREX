import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/realtime/ping — minimal round-trip probe for the realtime client
 * (pingRealtime in src/lib/realtime.ts). Auth-gated by the proxy like every
 * other /api route; returns the server timestamp so clients can clock-skew
 * check or measure latency.
 */
export async function GET() {
  return NextResponse.json({ ok: true, t: Date.now() });
}
