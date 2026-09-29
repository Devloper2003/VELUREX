"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle, Check, Copy, KeyRound, Loader2, ShieldCheck, ShieldOff, Smartphone,
} from "lucide-react";

// ─── Helpers ─────────────────────────────────────────────────────────────────

type EnableStep = 1 | 2 | 3;

function errText(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * Self-contained "Two-Factor Authentication" settings card. Works for platform
 * AND tenant users — it reads /api/auth/me and calls the /api/auth/2fa/* endpoints
 * through the shared api() helper (auth rides on the session cookie / Bearer token).
 *
 * Enable flow (3 steps inside one dialog):
 *   1. POST /2fa/setup → QR + Base32 secret for the authenticator app
 *   2. POST /2fa/enable { code } → live TOTP verification
 *   3. One-time recovery codes (acknowledgement-gated "Done")
 * Disable flow: AlertDialog requiring account password + current 6-digit code.
 */
export default function TwoFactorCard({ initiallyEnabled }: { initiallyEnabled?: boolean }) {
  const { toast } = useToast();

  // Card state — `enabled === null` means "still checking".
  const [enabled, setEnabled] = useState<boolean | null>(initiallyEnabled ?? null);
  const [meError, setMeError] = useState("");

  // Enable flow (single dialog, 3 steps)
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<EnableStep>(1);
  const [setupBusy, setSetupBusy] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [secret, setSecret] = useState("");
  const [qr, setQr] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const [copiedSecret, setCopiedSecret] = useState(false);
  const [copiedAll, setCopiedAll] = useState(false);

  // Disable flow (confirm alert dialog)
  const [disableOpen, setDisableOpen] = useState(false);
  const [disablePassword, setDisablePassword] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [disableBusy, setDisableBusy] = useState(false);
  const [disableError, setDisableError] = useState("");

  // Initial status: trust the optional prop when the host view already knows,
  // otherwise fetch it from the session echo.
  const loadMe = useCallback(async () => {
    setMeError("");
    setEnabled(null);
    try {
      const me = await api<{ user: { totpEnabled?: boolean } }>("/api/auth/me");
      setEnabled(Boolean(me.user.totpEnabled));
    } catch (e) {
      setMeError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (initiallyEnabled !== undefined) setEnabled(initiallyEnabled);
    else void loadMe();
  }, [initiallyEnabled, loadMe]);

  // ── Enable flow ────────────────────────────────────────────────────────────

  async function runSetup() {
    setSetupBusy(true);
    setError("");
    setSecret("");
    setQr("");
    setCode("");
    try {
      const res = await api<{ secret: string; otpauthUri: string }>("/api/auth/2fa/setup", { method: "POST" });
      setSecret(res.secret);
      // Render the QR client-side from the otpauth:// provisioning URI.
      const QRCode = (await import("qrcode")).default;
      setQr(await QRCode.toDataURL(res.otpauthUri));
    } catch (e) {
      setError(errText(e));
    } finally {
      setSetupBusy(false);
    }
  }

  function openEnableFlow() {
    setOpen(true);
    setStep(1);
    void runSetup();
  }

  function closeEnableFlow() {
    if (setupBusy || verifyBusy) return;
    setOpen(false);
    setStep(1);
    setSecret("");
    setQr("");
    setCode("");
    setRecoveryCodes([]);
    setAck(false);
    setError("");
    setCopiedSecret(false);
    setCopiedAll(false);
  }

  async function verifyCode() {
    if (verifyBusy || code.length !== 6) return;
    setVerifyBusy(true);
    setError("");
    try {
      const res = await api<{ recoveryCodes: string[] }>("/api/auth/2fa/enable", {
        method: "POST",
        body: JSON.stringify({ code }),
      });
      setRecoveryCodes(res.recoveryCodes ?? []);
      setStep(3);
    } catch (e) {
      setError(errText(e));
    } finally {
      setVerifyBusy(false);
    }
  }

  function finishEnable() {
    setEnabled(true);
    closeEnableFlow();
    toast({ title: "Two-factor authentication enabled", description: "Keep your recovery codes somewhere safe." });
  }

  async function copySecret() {
    if (await copyText(secret)) {
      setCopiedSecret(true);
      window.setTimeout(() => setCopiedSecret(false), 1500);
    } else {
      toast({ title: "Could not copy", description: "Select the key and copy it manually.", variant: "destructive" });
    }
  }

  async function copyAllCodes() {
    if (await copyText(recoveryCodes.join("\n"))) {
      setCopiedAll(true);
      toast({ title: "All recovery codes copied" });
      window.setTimeout(() => setCopiedAll(false), 1500);
    } else {
      toast({ title: "Could not copy", variant: "destructive" });
    }
  }

  // ── Disable flow ───────────────────────────────────────────────────────────

  async function disable2fa() {
    if (disableBusy || !disablePassword || disableCode.length !== 6) return;
    setDisableBusy(true);
    setDisableError("");
    try {
      await api("/api/auth/2fa/disable", {
        method: "POST",
        body: JSON.stringify({ password: disablePassword, code: disableCode }),
      });
      setDisableOpen(false);
      setDisablePassword("");
      setDisableCode("");
      setEnabled(false);
      toast({ title: "Two-factor authentication disabled" });
    } catch (e) {
      setDisableError(errText(e));
    } finally {
      setDisableBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const badgeCls =
    enabled === true
      ? "border-ok/40 bg-ok/10 text-ok"
      : "border-line-strong bg-plaster text-muted-ink";

  return (
    <section className="panel" aria-label="Two-Factor Authentication">
      <div className="panel-header">
        <div>
          <p className="panel-title flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-brass" /> Two-Factor Authentication
          </p>
          <p className="text-xs text-muted-ink mt-0.5">
            A second sign-in step via a TOTP authenticator app.
          </p>
        </div>
        <Badge variant="outline" className={`text-[10px] py-0.5 gap-1 shrink-0 ${badgeCls}`}>
          {enabled === null ? "…" : enabled ? "On" : "Off"}
        </Badge>
      </div>

      <div className="p-4">
        {meError ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] text-danger leading-snug">{meError}</p>
            <Button variant="outline" size="sm" onClick={() => void loadMe()}>Retry</Button>
          </div>
        ) : enabled === null ? (
          <p className="flex items-center gap-2 py-1 text-[13px] text-muted-ink">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking your account…
          </p>
        ) : enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-[13px] leading-snug text-muted-ink">
              Codes verified via your authenticator app. A current 6-digit code is asked at every sign-in,
              so a password alone can no longer open this account.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="border-danger/40 bg-danger/5 text-danger hover:bg-danger/10 hover:text-danger"
              onClick={() => { setDisableError(""); setDisableOpen(true); }}
            >
              <ShieldOff className="h-4 w-4" /> Disable 2FA
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-xl text-[13px] leading-snug text-muted-ink">
              Ask for a 6-digit code from an authenticator app (Google Authenticator, Authy, 1Password…) at
              every sign-in. Your secret is stored AES-256-GCM encrypted, and 8 one-time recovery codes are
              issued in case you lose your device.
            </p>
            <Button size="sm" className="bg-brass text-white hover:bg-brass/90" onClick={openEnableFlow}>
              <Smartphone className="h-4 w-4" /> Enable 2FA
            </Button>
          </div>
        )}
      </div>

      {/* ── Enable flow (3 steps) ─────────────────────────────────────────── */}
      <Dialog open={open} onOpenChange={(o) => { if (!o) closeEnableFlow(); }}>
        <DialogContent className="max-w-md bg-panel">
          <DialogHeader>
            <div className="flex items-center justify-between gap-2 pr-5">
              <DialogTitle>
                {step === 1 ? "Set up your authenticator app" : step === 2 ? "Verify & activate" : "Save your recovery codes"}
              </DialogTitle>
              <span className="badge border-line-strong bg-plaster text-muted-ink text-[10px] py-0 shrink-0">
                Step {step} of 3
              </span>
            </div>
            <DialogDescription>
              {step === 1
                ? "Scan the QR code with your app, or enter the key manually."
                : step === 2
                  ? "Enter the current 6-digit code shown in your authenticator app."
                  : "Each recovery code works once, in place of your authenticator."}
            </DialogDescription>
          </DialogHeader>

          {/* Step 1 — QR + manual secret */}
          {step === 1 && (setupBusy && !secret ? (
            <p className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-ink">
              <Loader2 className="h-4 w-4 animate-spin" /> Generating your secure secret…
            </p>
          ) : !secret ? (
            <div className="space-y-3 py-4 text-center">
              <p className="text-[13px] text-danger">{error}</p>
              <Button variant="outline" size="sm" onClick={() => void runSetup()}>Try again</Button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-col items-center">
                <div className="flex h-[190px] w-[190px] items-center justify-center rounded-md border border-line bg-white p-2.5">
                  {qr
                    ? <img src={qr} alt="2FA QR code" className="block h-[168px] w-[168px]" />
                    : <Loader2 className="h-7 w-7 animate-spin text-muted-ink" />}
                </div>
                <p className="mt-2 text-center text-[11.5px] leading-snug text-muted-ink">
                  Scan with Google Authenticator, Authy, 1Password or any TOTP app.
                </p>
              </div>

              <div>
                <Label htmlFor="totp-secret" className="field-label">Can&apos;t scan? Enter this key manually</Label>
                <div className="flex items-center gap-2">
                  <code
                    id="totp-secret"
                    className="scroll-slim min-w-0 flex-1 overflow-x-auto rounded-md border border-line bg-plaster-deep/50 px-3 py-2 font-mono text-[13px] tracking-wider text-pine select-all"
                  >
                    {secret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 w-9 shrink-0 p-0"
                    onClick={() => void copySecret()}
                    aria-label="Copy secret key"
                  >
                    {copiedSecret ? <Check className="h-3.5 w-3.5 text-ok" /> : <Copy className="h-3.5 w-3.5" />}
                  </Button>
                </div>
                <p className="mt-1 text-[11px] text-muted-ink">
                  The secret is stored encrypted and is never shown again after setup.
                </p>
              </div>

              {error && <p className="text-[12px] text-danger">{error}</p>}

              <DialogFooter>
                <Button
                  className="bg-pine-700 text-panel hover:bg-pine-600"
                  disabled={setupBusy || !qr}
                  onClick={() => { setError(""); setStep(2); }}
                >
                  Next <KeyRound className="h-4 w-4" />
                </Button>
              </DialogFooter>
            </div>
          ))}

          {/* Step 2 — live code verification */}
          {step === 2 && (
            <form
              onSubmit={(e) => { e.preventDefault(); void verifyCode(); }}
              className="space-y-4"
              noValidate
            >
              <div>
                <Label htmlFor="totp-verify" className="field-label">Verification code</Label>
                <div className="relative">
                  <Smartphone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-ink" />
                  <Input
                    id="totp-verify"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    autoFocus
                    className="pl-9 text-center text-lg font-semibold tracking-[0.45em]"
                    placeholder="••••••"
                    value={code}
                    onChange={(e) => { setCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setError(""); }}
                  />
                </div>
              </div>
              {error && (
                <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">
                  {error}
                </p>
              )}
              <DialogFooter>
                <Button type="button" variant="ghost" size="sm" disabled={verifyBusy} onClick={() => { setError(""); setStep(1); }}>
                  Back
                </Button>
                <Button
                  type="submit"
                  className="bg-pine-700 text-panel hover:bg-pine-600"
                  disabled={verifyBusy || code.length !== 6}
                >
                  {verifyBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  {verifyBusy ? "Verifying…" : "Verify & Enable"}
                </Button>
              </DialogFooter>
            </form>
          )}

          {/* Step 3 — one-time recovery codes */}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-start gap-2.5 rounded-md border border-warn/40 bg-warn/10 px-3 py-2.5">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
                <p className="text-[12.5px] leading-snug text-ink">
                  These codes are shown <span className="font-semibold">only once</span>. Each code can sign
                  you in if you lose your phone — store them somewhere safe.
                </p>
              </div>

              <div className="scroll-slim grid max-h-48 grid-cols-2 gap-2 overflow-y-auto">
                {recoveryCodes.map((c) => (
                  <code
                    key={c}
                    className="select-all rounded-md border border-line bg-plaster-deep/50 px-2.5 py-1.5 text-center font-mono text-[12.5px] tracking-wider text-pine"
                  >
                    {c}
                  </code>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => void copyAllCodes()}>
                  {copiedAll ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4" />} Copy all
                </Button>
                <div className="flex items-center gap-2">
                  <Checkbox id="2fa-ack" checked={ack} onCheckedChange={(v) => setAck(v === true)} />
                  <Label
                    htmlFor="2fa-ack"
                    className="cursor-pointer text-[12.5px] font-medium normal-case tracking-normal text-ink"
                  >
                    I have saved my recovery codes
                  </Label>
                </div>
              </div>

              <DialogFooter>
                <Button className="bg-pine-700 text-panel hover:bg-pine-600" disabled={!ack} onClick={finishEnable}>
                  <Check className="h-4 w-4" /> Done
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Disable confirmation (password + live code) ───────────────────── */}
      <AlertDialog
        open={disableOpen}
        onOpenChange={(o) => { if (!disableBusy) { setDisableOpen(o); if (!o) setDisableError(""); } }}
      >
        <AlertDialogContent className="max-w-md bg-panel">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <ShieldOff className="h-4 w-4 text-danger" /> Disable two-factor authentication?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Your account drops back to password-only sign-in. Confirm with your account password and a
              current 6-digit code from your authenticator app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div>
              <Label htmlFor="2fa-disable-pw" className="field-label">Account password</Label>
              <Input
                id="2fa-disable-pw"
                type="password"
                autoComplete="current-password"
                value={disablePassword}
                onChange={(e) => { setDisablePassword(e.target.value); setDisableError(""); }}
              />
            </div>
            <div>
              <Label htmlFor="2fa-disable-code" className="field-label">Current 6-digit code</Label>
              <Input
                id="2fa-disable-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                className="text-center text-lg font-semibold tracking-[0.45em]"
                placeholder="••••••"
                value={disableCode}
                onChange={(e) => { setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6)); setDisableError(""); }}
              />
            </div>
            {disableError && (
              <p className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-[12.5px] text-danger">
                {disableError}
              </p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disableBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-danger text-white hover:bg-danger/90"
              disabled={disableBusy || !disablePassword || disableCode.length !== 6}
              onClick={(e) => { e.preventDefault(); void disable2fa(); }}
            >
              {disableBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldOff className="h-4 w-4" />}
              {disableBusy ? "Disabling…" : "Disable 2FA"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
