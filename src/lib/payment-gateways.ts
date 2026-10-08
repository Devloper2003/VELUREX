import { createHmac, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { decryptJSON } from "@/lib/crypto";
import { logActivity } from "@/lib/business";
import { fetchRetry429 } from "@/lib/http-429";

/**
 * Tenant-owned payment gateway integration.
 *
 * The tenant links THEIR OWN gateway account (Razorpay / Stripe / …) from
 * Settings → Payments. Secrets are encrypted at rest (AES-256-GCM via
 * @/lib/crypto) and only ever decrypted server-side, milliseconds before a
 * gateway API call. When a guest pays — POS settle, folio payment, booking
 * widget, payment link — the charge is created against the TENANT's gateway
 * account, so the money settles into the tenant's own bank account.
 *
 * Sandbox behaviour: gateways without a full credential pair (key id + key
 * secret) fall back to a clearly-labelled simulated checkout so the whole
 * flow stays demoable without live keys.
 */

// ─── Provider metadata ───────────────────────────────────────────────────────

export type GatewayProviderMeta = {
  label: string;
  desc: string;
  /** supports a hosted checkout / payment-link flow (real online collection) */
  online: boolean;
  /** label for the non-secret key/merchant id field */
  idLabel: string;
  /** label for the secret key field */
  secretLabel: string;
  /** where the tenant finds these credentials */
  consoleHint: string;
};

export const GATEWAY_PROVIDERS: Record<string, GatewayProviderMeta> = {
  razorpay: {
    label: "Razorpay",
    desc: "UPI · cards · netbanking · wallets — India's most popular gateway",
    online: true,
    idLabel: "Key ID",
    secretLabel: "Key Secret",
    consoleHint: "Razorpay Dashboard → Settings → API Keys → Generate Test/Live Key",
  },
  stripe: {
    label: "Stripe",
    desc: "International cards & wallets — best for foreign guests",
    online: true,
    idLabel: "Publishable Key",
    secretLabel: "Secret Key",
    consoleHint: "Stripe Dashboard → Developers → API keys",
  },
  cashfree: {
    label: "Cashfree",
    desc: "UPI-first Indian gateway with instant settlements",
    online: true,
    idLabel: "App ID",
    secretLabel: "Secret Key",
    consoleHint: "Cashfree Merchant Dashboard → API Keys",
  },
  payu: {
    label: "PayU",
    desc: "Cards, UPI & EMI — widely used by Indian hotels",
    online: true,
    idLabel: "Merchant Key",
    secretLabel: "Merchant Salt",
    consoleHint: "PayU Dashboard → Settings → Configuration",
  },
  paytm: {
    label: "Paytm",
    desc: "Paytm UPI, wallet & cards",
    online: true,
    idLabel: "Merchant ID",
    secretLabel: "Merchant Key",
    consoleHint: "Paytm Business Dashboard → Developer Settings → API Keys",
  },
  phonepe: {
    label: "PhonePe",
    desc: "PhonePe UPI gateway for Indian guests",
    online: true,
    idLabel: "Merchant ID",
    secretLabel: "Salt Key",
    consoleHint: "PhonePe Business Dashboard → Credentials",
  },
  upi_qr: {
    label: "UPI QR (static)",
    desc: "Show your own UPI QR / VPA — guest pays, staff confirms manually",
    online: false,
    idLabel: "UPI VPA (yourname@bank)",
    secretLabel: "Not required",
    consoleHint: "Your bank / UPI app — copy your VPA",
  },
  bank_transfer: {
    label: "Bank Transfer (NEFT/RTGS)",
    desc: "Share account details; mark received after the transfer lands",
    online: false,
    idLabel: "Account / IFSC note",
    secretLabel: "Not required",
    consoleHint: "Your bank passbook or net-banking profile",
  },
  custom: {
    label: "Custom / Other",
    desc: "Any other provider — record payments with a reference",
    online: false,
    idLabel: "Reference / merchant note",
    secretLabel: "Not required",
    consoleHint: "Your provider's console",
  },
};

export const ONLINE_PROVIDERS = Object.entries(GATEWAY_PROVIDERS)
  .filter(([, m]) => m.online)
  .map(([k]) => k);

export function isOnlineProvider(provider: string): boolean {
  return GATEWAY_PROVIDERS[provider]?.online ?? false;
}

// ─── Credentials ─────────────────────────────────────────────────────────────

export type GatewayCreds = { keyId: string; keySecret: string; webhookSecret: string };

/**
 * Decrypt a gateway row's secret blob. Accepts both storage shapes:
 *   owner console  → { secret }
 *   tenant console → { keySecret, webhookSecret }
 */
export function gatewayCreds(secretBlob: string | null | undefined, merchantId: string): GatewayCreds {
  const dec = decryptJSON<{ secret?: string; keySecret?: string; webhookSecret?: string }>(secretBlob);
  return {
    keyId: (merchantId || "").trim(),
    keySecret: (dec.keySecret || dec.secret || "").trim(),
    webhookSecret: (dec.webhookSecret || "").trim(),
  };
}

export function hasLiveCreds(g: { merchantId: string; secret: string }): boolean {
  const c = gatewayCreds(g.secret, g.merchantId);
  return Boolean(c.keyId) && Boolean(c.keySecret);
}

// ─── Razorpay REST helpers ───────────────────────────────────────────────────

const RZP_API = "https://api.razorpay.com/v1";

function rzpAuth(c: GatewayCreds): string {
  return `Basic ${Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64")}`;
}

export type RazorpayOrder = {
  ok: boolean;
  mock?: boolean;
  orderId?: string;
  error?: string;
};

/**
 * Create a Razorpay order against the TENANT's account.
 * Falls back to a mock order when credentials are absent so flows remain
 * testable in development (clearly flagged `mock: true`).
 */
export async function createRazorpayOrder(
  g: { merchantId: string; secret: string; mode: string; provider: string },
  opts: { amount: number; receipt: string; notes?: Record<string, string>; customer?: { name?: string; phone?: string; email?: string } }
): Promise<RazorpayOrder> {
  const c = gatewayCreds(g.secret, g.merchantId);
  if (!c.keyId || !c.keySecret) {
    return { ok: true, mock: true, orderId: `order_mock_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` };
  }
  try {
    const res = await fetchRetry429(`${RZP_API}/orders`, {
      method: "POST",
      headers: { Authorization: rzpAuth(c), "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(opts.amount * 100), // paise
        currency: "INR",
        receipt: opts.receipt.slice(0, 40),
        notes: opts.notes ?? {},
      }),
      signal: AbortSignal.timeout(12000),
    });
    const d = (await res.json().catch(() => ({}))) as { id?: string; error?: { description?: string } };
    if (res.ok && d.id) return { ok: true, orderId: d.id };
    if (res.status === 429) return { ok: false, error: "Razorpay is busy (rate limit) — wait about a minute and try the payment again." };
    return { ok: false, error: d.error?.description || `Razorpay rejected the order (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `Could not reach Razorpay: ${e.message}` : "Could not reach Razorpay" };
  }
}

export type RazorpayLink = {
  ok: boolean;
  mock?: boolean;
  linkId?: string;
  shortUrl?: string;
  error?: string;
};

/** Create a hosted Razorpay Payment Link — guest pays on Razorpay's page, money lands in the tenant's account. */
export async function createRazorpayPaymentLink(
  g: { merchantId: string; secret: string; mode: string },
  opts: { amount: number; description: string; customer: { name?: string; phone?: string; email?: string }; referenceId: string }
): Promise<RazorpayLink> {
  const c = gatewayCreds(g.secret, g.merchantId);
  if (!c.keyId || !c.keySecret) return { ok: false, error: "This gateway has no API keys saved yet — open Settings → Payments and save the Key ID + Key Secret first." };
  const customer = opts.customer.phone || opts.customer.email ? opts.customer : undefined;
  try {
    const res = await fetchRetry429(`${RZP_API}/payment_links`, {
      method: "POST",
      headers: { Authorization: rzpAuth(c), "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: Math.round(opts.amount * 100),
        currency: "INR",
        accept_partial: false,
        reference_id: opts.referenceId.slice(0, 40),
        description: opts.description.slice(0, 200),
        customer: customer
          ? { name: customer.name || undefined, contact: customer.phone || undefined, email: customer.email || undefined }
          : undefined,
        notes: { source: "velurex-hms" },
      }),
      signal: AbortSignal.timeout(12000),
    });
    const d = (await res.json().catch(() => ({}))) as { id?: string; short_url?: string; error?: { description?: string } };
    if (res.ok && d.id && d.short_url) return { ok: true, linkId: d.id, shortUrl: d.short_url };
    if (res.status === 429) return { ok: false, error: "Razorpay is busy (rate limit) — wait about a minute and create the link again." };
    return { ok: false, error: d.error?.description || `Razorpay rejected the payment link (HTTP ${res.status})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? `Could not reach Razorpay: ${e.message}` : "Could not reach Razorpay" };
  }
}

// ─── Signature verification ──────────────────────────────────────────────────

function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** Razorpay checkout handshake: HMAC_SHA256(order_id|payment_id, keySecret). */
export function verifyRazorpayCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  const expected = createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
  return safeEqualHex(expected, signature);
}

/** Razorpay webhook: HMAC_SHA256(rawBody, webhookSecret) compared to X-Razorpay-Signature. */
export function verifyRazorpayWebhookSignature(rawBody: string, signature: string, webhookSecret: string): boolean {
  if (!rawBody || !signature || !webhookSecret) return false;
  const expected = createHmac("sha256", webhookSecret).update(rawBody).digest("hex");
  return safeEqualHex(expected, signature);
}

// ─── Connection test ─────────────────────────────────────────────────────────

export type TestResult = { ok: boolean; message: string };

export async function testGatewayConnection(g: { provider: string; merchantId: string; secret: string; mode: string }): Promise<TestResult> {
  const c = gatewayCreds(g.secret, g.merchantId);
  const meta = GATEWAY_PROVIDERS[g.provider];

  if (g.provider === "razorpay") {
    if (!c.keyId || !c.keySecret) return { ok: false, message: "Save both the Key ID and Key Secret first, then test again." };
    try {
      const res = await fetchRetry429(`${RZP_API}/orders?count=1`, {
        headers: { Authorization: rzpAuth(c) },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true, message: `Connected — Razorpay accepted these ${g.mode.toUpperCase()} credentials.` };
      if (res.status === 401) return { ok: false, message: "Razorpay rejected these credentials (401 Unauthorized) — re-check the Key ID / Key Secret pair." };
      if (res.status === 429)
        return {
          ok: false,
          message: "Razorpay rate-limited this key (HTTP 429 — too many requests in a short window). Wait about a minute and test again; the saved keys are not the problem. If it keeps happening, another system may be sharing this key.",
        };
      return { ok: false, message: `Razorpay responded with HTTP ${res.status}.` };
    } catch (e) {
      return { ok: false, message: `Could not reach Razorpay from the server${e instanceof Error ? `: ${e.message}` : ""}.` };
    }
  }

  if (g.provider === "stripe") {
    if (!c.keySecret) return { ok: false, message: "Save the Stripe Secret Key first, then test again." };
    try {
      const res = await fetchRetry429("https://api.stripe.com/v1/balance", {
        headers: { Authorization: `Bearer ${c.keySecret}` },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true, message: `Connected — Stripe accepted this ${g.mode.toUpperCase()} secret key.` };
      if (res.status === 401) return { ok: false, message: "Stripe rejected this secret key (401) — re-check it." };
      if (res.status === 429)
        return {
          ok: false,
          message: "Stripe rate-limited this key (HTTP 429). Wait about a minute and test again; the saved key is not the problem.",
        };
      return { ok: false, message: `Stripe responded with HTTP ${res.status}.` };
    } catch (e) {
      return { ok: false, message: `Could not reach Stripe from the server${e instanceof Error ? `: ${e.message}` : ""}.` };
    }
  }

  if (!meta?.online) {
    return c.keyId
      ? { ok: true, message: "Saved. This is a manual method — payments are confirmed by staff." }
      : { ok: false, message: `Enter ${meta?.idLabel ?? "the identifier"} first.` };
  }

  return c.keyId && c.keySecret
    ? { ok: true, message: "Credentials saved. Live API test is available for Razorpay and Stripe." }
    : { ok: false, message: "Save both the key id and key secret to enable real charges." };
}

// ─── Finalize (shared by verify + webhook) ───────────────────────────────────

export type FinalizeInput = {
  paymentId: string;
  gatewayRef?: string;
  via: "checkout" | "webhook";
  actorName?: string;
  failureReason?: string;
};

/**
 * Flip a pending gateway payment to success and apply it to its target
 * (reservation paid-amount or POS order settle). Idempotent: an already
 * successful payment short-circuits.
 */
export async function finalizeGatewayPayment(input: FinalizeInput): Promise<{ ok: boolean; status: string; error?: string }> {
  const payment = await db.payment.findUnique({ where: { id: input.paymentId } });
  if (!payment) return { ok: false, status: "missing", error: "Payment not found" };
  if (payment.status === "success") return { ok: true, status: "success" }; // idempotent replay
  if (payment.status !== "pending") return { ok: false, status: payment.status, error: `Payment is ${payment.status}` };

  const updated = await db.payment.update({
    where: { id: payment.id },
    data: {
      status: "success",
      gatewayRef: input.gatewayRef || payment.gatewayRef,
    },
  });

  if (payment.reservationId) {
    await db.reservation.update({
      where: { id: payment.reservationId },
      data: { paidAmount: { increment: payment.amount } },
    });
  }
  if (payment.posOrderId) {
    await db.posOrder.updateMany({
      where: { id: payment.posOrderId, paymentStatus: "unpaid" },
      data: { paymentStatus: "paid", status: "completed" },
    });
  }

  await logActivity({
    propertyId: payment.propertyId,
    staffId: input.via === "webhook" ? "webhook" : undefined,
    staffName: input.actorName || (input.via === "webhook" ? "Gateway webhook" : "Staff"),
    action: "GATEWAY_PAYMENT",
    entity: "payment",
    entityId: payment.id,
    details: `₹${payment.amount.toFixed(2)} via ${payment.method.toUpperCase()}${updated.gatewayRef ? ` · ${updated.gatewayRef}` : ""} (${input.via})`,
  });

  return { ok: true, status: "success" };
}

/** Mark a pending gateway payment as failed (guest cancelled / verification failed). */
export async function failGatewayPayment(paymentId: string, reason: string): Promise<void> {
  const payment = await db.payment.findUnique({ where: { id: paymentId } });
  if (!payment || payment.status !== "pending") return;
  await db.payment.update({ where: { id: paymentId }, data: { status: "failed" } });
  await logActivity({
    propertyId: payment.propertyId,
    staffName: "System",
    action: "GATEWAY_PAYMENT_FAILED",
    entity: "payment",
    entityId: payment.id,
    details: `₹${payment.amount.toFixed(2)} via ${payment.method.toUpperCase()} — ${reason.slice(0, 160)}`,
  });
}
