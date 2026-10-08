/**
 * fetch wrapper with transparent retry on HTTP 429 (rate limited).
 *
 * Gateways (Razorpay / Stripe / …) throttle keys that receive too many
 * requests in a short window — impatient "Test connection" clicks or a busy
 * key shared with another system both trigger it. A 429 response is always
 * safe to retry: the server did NOT process the request, so there is no risk
 * of double charges or duplicate orders.
 *
 * The sleep honours the server's Retry-After hint but is capped so API routes
 * stay snappy (worst case ≈ maxWaitMs × retries of added latency).
 */
export async function fetchRetry429(
  url: string,
  init: RequestInit = {},
  opts: { retries?: number; baseWaitMs?: number; maxWaitMs?: number } = {}
): Promise<Response> {
  const retries = Math.max(0, opts.retries ?? 2);
  const baseWaitMs = opts.baseWaitMs ?? 700;
  const maxWaitMs = opts.maxWaitMs ?? 2200;

  let res = await fetch(url, init);
  for (let attempt = 1; attempt <= retries && res.status === 429; attempt++) {
    const ra = Number(res.headers.get("retry-after"));
    let waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseWaitMs * 2 ** (attempt - 1);
    waitMs = Math.min(Math.max(waitMs, 300), maxWaitMs);
    await new Promise((r) => setTimeout(r, waitMs));
    res = await fetch(url, init);
  }
  return res;
}
