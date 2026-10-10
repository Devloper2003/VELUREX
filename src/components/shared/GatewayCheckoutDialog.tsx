"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2, Lock, ShieldCheck, X } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { inr } from "@/lib/format";

/**
 * GatewayCheckoutDialog — collects a payment through the property's OWN
 * online gateway (linked by the tenant in Settings → Payments).
 *
 * Real mode  : creates the order at the tenant's gateway and opens Razorpay's
 *              hosted checkout; the signature is verified server-side.
 * Sandbox    : gateways without a full credential pair get a clearly-labelled
 *              simulated confirmation so the flow stays demoable.
 */

/** Providers that support hosted online collection (mirrors GATEWAY_PROVIDERS.online). */
const ONLINE_PROVIDERS = ["razorpay", "stripe", "cashfree", "payu", "paytm", "phonepe"];

export interface GatewayOption {
  id: string;
  provider: string;
  label: string;
  mode: string;
  isDefault: boolean;
}

interface CheckoutPayload {
  paymentId: string;
  gateway: { id: string; provider: string; label: string; mode: string };
  checkout: {
    orderId: string;
    amount: number;
    keyId: string;
    currency: string;
    mock: boolean;
    description: string;
  };
}

export interface GatewayPaidInfo {
  provider: string;
  gatewayLabel: string;
  gatewayRef: string;
  amount: number;
  simulated: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  amount: number;
  description: string;
  reservationId?: string;
  posOrderId?: string;
  /** pre-select a specific gateway (e.g. picked in the folio pay dialog) */
  gatewayId?: string;
  onPaid: (info: GatewayPaidInfo) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: Record<string, unknown>) => { open: () => void };
  }
}

/**
 * Load Razorpay's checkout script exactly once (single-flight — parallel opens
 * or retries must not inject duplicate <script> tags). Resolves false if the
 * network blocks it (offline, ad-blocker, DNS) so the caller can show a
 * precise remediation message.
 */
let rzpScriptPromise: Promise<boolean> | null = null;
function loadRazorpayScript(): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  if (window.Razorpay) return Promise.resolve(true);
  if (rzpScriptPromise) return rzpScriptPromise;
  rzpScriptPromise = new Promise<boolean>((resolve) => {
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.async = true;
    s.onload = () => resolve(true);
    s.onerror = () => {
      rzpScriptPromise = null; // allow a genuine retry on the next attempt
      resolve(false);
    };
    document.body.appendChild(s);
  });
  return rzpScriptPromise;
}

export default function GatewayCheckoutDialog({
  open, onOpenChange, amount, description, reservationId, posOrderId, gatewayId, onPaid,
}: Props) {
  const { toast } = useToast();
  const [gateways, setGateways] = useState<GatewayOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string>("");
  const [sandbox, setSandbox] = useState<CheckoutPayload | null>(null); // awaiting simulated confirm
  const startedRef = useRef(false);

  const loadGateways = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ gateways: GatewayOption[] }>("/api/payments/gateways");
      const online = d.gateways.filter((g) => ONLINE_PROVIDERS.includes(g.provider));
      setGateways(online);
      setSelectedId(
        (prev) =>
          prev ||
          (gatewayId && online.some((g) => g.id === gatewayId) ? gatewayId : "") ||
          online.find((g) => g.isDefault)?.id ||
          online[0]?.id ||
          ""
      );
    } catch {
      setGateways([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setSandbox(null);
      startedRef.current = false;
      loadGateways();
    }
  }, [open, loadGateways]);

  const finish = (paymentId: string, gatewayRef: string, g: CheckoutPayload["gateway"], simulated: boolean) => {
    onPaid({
      provider: g.provider,
      gatewayLabel: g.label || g.provider,
      gatewayRef,
      amount,
      simulated,
    });
    toast({
      title: simulated ? "Simulated payment recorded" : "Payment received",
      description: `${inr(amount, { decimals: true })} via ${g.label || g.provider}${gatewayRef ? ` · ${gatewayRef}` : ""}`,
    });
    onOpenChange(false);
  };

  /** Real Razorpay checkout → verify signature server-side. */
  const runRealCheckout = async (payload: CheckoutPayload): Promise<void> => {
    let ready = await loadRazorpayScript();
    if (!ready) {
      // One retry after a short pause — transient network blips are common.
      await new Promise((r) => setTimeout(r, 1200));
      ready = await loadRazorpayScript();
    }
    if (!ready || !window.Razorpay) {
      toast({
        title: "Could not load the payment window",
        description: "Razorpay's checkout script did not load — check the internet connection, disable any ad-blocker for this site, and make sure the app is updated to v2.10.0 (older versions blocked the script via security headers). The order is safe; no money moved.",
        variant: "destructive",
      });
      return;
    }
    const payId = await new Promise<string | null>((resolve) => {
      const rzp = new window.Razorpay!({
        key: payload.checkout.keyId,
        order_id: payload.checkout.orderId,
        amount: Math.round(payload.checkout.amount * 100),
        currency: payload.checkout.currency || "INR",
        name: "Velurex HMS",
        description: payload.checkout.description || description,
        prefill: { method: payload.gateway.provider },
        theme: { color: "#17352c" },
        modal: { ondismiss: () => resolve(null) },
        handler: (resp: { razorpay_payment_id?: string; razorpay_order_id?: string; razorpay_signature?: string }) => {
          // Verify + apply server-side (never trust the browser).
          api<{ payment: { gatewayRef?: string } }>("/api/payments/verify", {
            method: "POST",
            body: JSON.stringify({
              paymentId: payload.paymentId,
              razorpay_payment_id: resp.razorpay_payment_id,
              razorpay_order_id: resp.razorpay_order_id,
              razorpay_signature: resp.razorpay_signature,
            }),
          })
            .then((v) => resolve(v.payment?.gatewayRef || resp.razorpay_payment_id || "verified"))
            .catch((e: Error) => {
              toast({ title: "Verification failed", description: e.message, variant: "destructive" });
              resolve(null);
            });
        },
      });
      rzp.open();
    });
    if (payId) finish(payload.paymentId, payId, payload.gateway, false);
    // dismissed / failed → dialog stays open for a retry
  };

  const startPayment = async () => {
    const gateway = gateways.find((g) => g.id === selectedId);
    if (!gateway) {
      toast({ title: "Choose a gateway first", variant: "destructive" });
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    setBusy(true);
    try {
      const payload = await api<CheckoutPayload>("/api/payments/checkout", {
        method: "POST",
        body: JSON.stringify({ amount, description, reservationId, posOrderId, gatewayId: gateway.id }),
      });
      if (payload.checkout.mock) {
        setSandbox(payload); // clearly-labelled simulated confirmation
      } else {
        await runRealCheckout(payload);
      }
    } catch (e) {
      toast({ title: "Could not start the payment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      startedRef.current = false;
      setBusy(false);
    }
  };

  const confirmSandbox = async () => {
    if (!sandbox) return;
    setBusy(true);
    try {
      const v = await api<{ payment: { gatewayRef?: string } }>("/api/payments/verify", {
        method: "POST",
        body: JSON.stringify({ paymentId: sandbox.paymentId, mock: true }),
      });
      finish(sandbox.paymentId, v.payment?.gatewayRef || "simulated", sandbox.gateway, true);
    } catch (e) {
      toast({ title: "Could not confirm the payment", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const selected = gateways.find((g) => g.id === selectedId);

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CreditCard className="h-4 w-4 text-brass" /> Collect online payment
          </DialogTitle>
          <DialogDescription>
            {description} · <span className="font-semibold text-pine">{inr(amount, { decimals: true })}</span> — charged
            through <b>your own</b> gateway account.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-ink">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading gateways…
          </div>
        ) : gateways.length === 0 ? (
          <div className="rounded-lg border border-warn/40 bg-warn/10 p-4 text-sm text-ink space-y-2">
            <p className="flex items-center gap-2 font-medium text-warn">
              <AlertTriangle className="h-4 w-4" /> No online gateway linked yet
            </p>
            <p className="text-[12.5px] text-muted-ink">
              Link your own Razorpay / Stripe account under <b>Settings → Payments</b>, then guest payments will be
              charged there and settle into your bank account.
            </p>
          </div>
        ) : sandbox ? (
          /* ── Sandbox confirmation ── */
          <div className="space-y-3 py-1">
            <div className="rounded-lg border border-warn/40 bg-warn/10 p-4 space-y-2">
              <p className="flex items-center gap-2 text-[13px] font-semibold text-warn">
                <ShieldCheck className="h-4 w-4" /> Sandbox simulation
              </p>
              <p className="text-[12.5px] text-muted-ink">
                <b>{sandbox.gateway.label || sandbox.gateway.provider}</b> has no API key secret saved yet, so this
                checkout is simulated. Save real keys in Settings → Payments to charge guests for real.
              </p>
              <div className="rounded-md border border-line bg-panel px-3 py-2 text-[12.5px] font-mono">
                {sandbox.checkout.orderId}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-ghost" onClick={() => setSandbox(null)} disabled={busy}>
                Back
              </button>
              <button type="button" className="btn-pine" onClick={confirmSandbox} disabled={busy}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                Simulate success
              </button>
            </div>
          </div>
        ) : (
          /* ── Gateway picker ── */
          <div className="space-y-3 py-1">
            <div className="grid gap-2">
              {gateways.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setSelectedId(g.id)}
                  aria-pressed={selectedId === g.id}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition",
                    selectedId === g.id
                      ? "border-pine-700 bg-pine-700/5 ring-1 ring-pine-700/30"
                      : "border-line-strong bg-plaster/40 hover:bg-plaster-deep/60"
                  )}
                >
                  <CreditCard className={cn("h-4 w-4 shrink-0", selectedId === g.id ? "text-pine-700" : "text-muted-ink")} />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-semibold text-pine truncate">
                      {g.label || g.provider}
                    </span>
                    <span className="block text-[11px] text-muted-ink">
                      {g.isDefault ? "Default gateway · " : ""}charged to your account
                    </span>
                  </span>
                  <span
                    className={cn(
                      "badge ml-auto px-1.5 py-0 text-[10px] shrink-0",
                      g.mode === "live" ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"
                    )}
                  >
                    {g.mode}
                  </span>
                </button>
              ))}
            </div>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-ink">
              <Lock className="h-3 w-3" /> Card / UPI details are entered on the gateway&apos;s secure page — never stored here.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className="btn-ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                <X className="h-4 w-4" /> Cancel
              </button>
              <button type="button" className="btn-pine" onClick={startPayment} disabled={busy || !selected}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                Pay {inr(amount, { decimals: true })}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
