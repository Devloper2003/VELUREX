"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import {
  Eye, EyeOff, Lock, Mail, ShieldCheck, Loader2, ArrowRight, Hotel, Globe2, LineChart, BadgeCheck, KeyRound, Smartphone,
} from "lucide-react";
import { useSession, SessionUser } from "@/lib/store";

/**
 * Velurex HMS — Login screen (finalized brand mockup).
 * Left: pine photo panel with headline + capability strip.
 * Right: plaster panel with the sign-in card only — no Google / Create Account
 * / demo-credential fillers. Real credentials are issued by the platform owner.
 *
 * Mandatory temporary→permanent password flow: when /api/auth/login answers
 * `mustChangePassword: true` the account is on a temporary password (issued by
 * an admin / the platform owner). The card switches into a "Set your permanent
 * password" state and the session is only established AFTER the permanent
 * password is saved via /api/auth/change-password (fresh token returned there).
 */

interface ResetPending {
  token: string;
  user: SessionUser;
}

interface MfaPending {
  mfaToken: string;
  user: SessionUser;
}

interface ResetFieldErrors {
  current?: string;
  next?: string;
  confirm?: string;
}

/** Same policy as validatePermanentPassword() on the server. */
function permanentPolicyError(pw: string): string | null {
  if (!pw || pw.length < 8) return "Minimum 8 characters";
  if (!/[A-Za-z]/.test(pw)) return "Add at least one letter";
  if (!/[0-9]/.test(pw)) return "Add at least one number";
  if (!/[^A-Za-z0-9]/.test(pw)) return "Add at least one symbol";
  return null;
}

const FEATURES = [
  { icon: Hotel, title: "Complete PMS", desc: "Rooms, Reservations, Guest Management" },
  { icon: Globe2, title: "Multi-Channel Distribution", desc: "OTAs + Direct Bookings (One Inventory)" },
  { icon: LineChart, title: "Advanced Analytics", desc: "Drive Performance with Real Insights" },
  { icon: BadgeCheck, title: "Secure & Reliable", desc: "Your Data, Our Priority" },
];

export function LoginScreen() {
  const setSession = useSession((s) => s.setSession);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  /* Mandatory temporary→permanent password state */
  const [reset, setReset] = useState<ResetPending | null>(null);
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confPw, setConfPw] = useState("");
  const [showCur, setShowCur] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConf, setShowConf] = useState(false);
  const [fieldErr, setFieldErr] = useState<ResetFieldErrors>({});
  const [resetError, setResetError] = useState("");
  const [resetLoading, setResetLoading] = useState(false);

  /* Two-factor verification state (TOTP / recovery code) */
  const [mfa, setMfa] = useState<MfaPending | null>(null);
  const [mfaCode, setMfaCode] = useState("");
  const [mfaUseRecovery, setMfaUseRecovery] = useState(false);
  const [mfaError, setMfaError] = useState("");
  const [mfaLoading, setMfaLoading] = useState(false);

  async function handleLogin(e?: React.FormEvent) {
    e?.preventDefault();
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Login failed");
      if (data.twoFactorRequired === true) {
        // Password accepted — now the authenticator code decides.
        setMfa({ mfaToken: data.mfaToken, user: data.user });
        setMfaCode("");
        setMfaUseRecovery(false);
        setMfaError("");
        return;
      }
      if (data.mustChangePassword === true) {
        // Temporary password — force the reset card BEFORE any session exists.
        setReset({ token: data.token, user: data.user });
        setFieldErr({});
        setResetError("");
        return;
      }
      setSession(data.token, data.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  function exitReset() {
    setReset(null);
    setCurPw("");
    setNewPw("");
    setConfPw("");
    setShowCur(false);
    setShowNew(false);
    setShowConf(false);
    setFieldErr({});
    setResetError("");
  }

  function exitMfa() {
    setMfa(null);
    setMfaCode("");
    setMfaUseRecovery(false);
    setMfaError("");
  }

  async function handleVerify2fa(e: React.FormEvent) {
    e.preventDefault();
    if (!mfa) return;
    const value = mfaUseRecovery ? mfaCode.trim().toUpperCase() : mfaCode.replace(/\D/g, "");
    if (!value) {
      setMfaError(mfaUseRecovery ? "Enter a recovery code" : "Enter the 6-digit code from your app");
      return;
    }
    setMfaError("");
    setMfaLoading(true);
    try {
      const res = await fetch("/api/auth/2fa/challenge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mfaUseRecovery ? { mfaToken: mfa.mfaToken, recoveryCode: value } : { mfaToken: mfa.mfaToken, code: value }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setSession(data.token, mfa.user);
      setMfa(null);
    } catch (err) {
      setMfaError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setMfaLoading(false);
    }
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!reset) return;
    setResetError("");
    const errs: ResetFieldErrors = {};
    if (!curPw) errs.current = "Enter the temporary password you signed in with";
    if (!newPw) errs.next = "Choose a new password";
    else {
      const policy = permanentPolicyError(newPw);
      if (policy) errs.next = policy;
    }
    if (!confPw) errs.confirm = "Re-enter the new password";
    else if (newPw && confPw !== newPw) errs.confirm = "Passwords do not match";
    setFieldErr(errs);
    if (Object.keys(errs).length > 0) return;

    setResetLoading(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${reset.token}`,
        },
        body: JSON.stringify({ currentPassword: curPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not set the new password");
      // Fresh token has mustChangePassword cleared — the app routes normally.
      setSession(data.token, reset.user);
      setReset(null);
    } catch (err) {
      setResetError(err instanceof Error ? err.message : "Could not set the new password");
    } finally {
      setResetLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-plaster">
      {/* ── Brand side — pine photo panel (mockup left half) ─────────── */}
      <div className="relative hidden lg:flex lg:w-[52%] text-panel flex-col overflow-hidden bg-pine">
        <div
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: "url(/images/login-hero.jpg)" }}
        />
        {/* pine wash so text stays legible over the lobby photo */}
        <div className="absolute inset-0 bg-gradient-to-r from-pine/95 via-pine/85 to-pine/60" />
        <div className="absolute inset-0 opacity-[0.08]" style={{ backgroundImage: "radial-gradient(circle at 15% 85%, #B9873E 0, transparent 42%)" }} />

        <div className="relative flex items-center justify-between p-9 pb-0">
          <BrandMark size={56} />
          <div className="hidden xl:flex items-center gap-2.5 text-[10.5px] font-semibold tracking-[0.14em] uppercase text-panel/85">
            <span>Smart Hotels</span>
            <span className="h-3 w-px bg-brass/60" />
            <span>Better Operations</span>
            <span className="h-3 w-px bg-brass/60" />
            <span>Higher Revenue</span>
          </div>
        </div>

        <div className="relative flex-1 flex flex-col justify-center px-9 xl:px-12 py-8">
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55 }}>
            <h1 className="font-display text-[34px] xl:text-[42px] leading-[1.12] tracking-tight font-medium">
              Powering the Next
              <br />
              Generation of <em className="font-display italic text-brass-light">Hotels</em>
            </h1>
          </motion.div>
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12, duration: 0.55 }}
            className="mt-4 max-w-md text-[14.5px] leading-relaxed text-panel/85"
          >
            Velurex <span className="text-brass-light font-medium">HMS</span> is a complete hotel
            management platform designed to simplify operations, enhance guest
            experiences and maximize your revenue.
          </motion.p>
        </div>

        <div className="relative px-9 xl:px-12 pb-8">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.22, duration: 0.55 }}
            className="grid grid-cols-2 xl:grid-cols-4 gap-x-6 gap-y-5 border-t border-brass/25 pt-6"
          >
            {FEATURES.map((f, i) => (
              <motion.div
                key={f.title}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 + i * 0.08, duration: 0.5 }}
                className="flex flex-col gap-2"
              >
                <span className="h-9 w-9 rounded-md bg-pine-700/70 border border-brass/35 flex items-center justify-center">
                  <f.icon className="h-4.5 w-4.5 text-brass-light" />
                </span>
                <p className="text-[13px] font-semibold leading-snug">{f.title}</p>
                <p className="text-[11px] leading-snug text-panel/60">{f.desc}</p>
              </motion.div>
            ))}
          </motion.div>

          <div className="relative mt-7 flex items-center gap-3 text-[10px] font-semibold tracking-[0.16em] uppercase text-panel/55">
            <span className="h-px w-10 bg-brass/60" />
            More than a system
            <span className="h-px w-10 bg-brass/60" />
            Your hotel's digital partner
          </div>
        </div>
      </div>

      {/* ── Login side — plaster (mockup right half) ─────────────────── */}
      <div className="relative flex-1 flex flex-col min-h-screen lg:min-h-0">
        {/* ── Decorative theme linework filling the blank plaster space ── */}
        <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
          {/* fine art-deco diamond trellis — subtle texture over the blank field */}
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(15,38,34,0.045) 0px, rgba(15,38,34,0.045) 1px, transparent 1px, transparent 22px), repeating-linear-gradient(-45deg, rgba(15,38,34,0.045) 0px, rgba(15,38,34,0.045) 1px, transparent 1px, transparent 22px)",
            }}
          />
          {/* soft brand glows mirroring the photo panel (brass top-right, pine bottom-left) */}
          <div
            className="absolute inset-0"
            style={{
              backgroundImage:
                "radial-gradient(circle at 90% 8%, rgba(185,135,62,0.10) 0%, transparent 34%), radial-gradient(circle at 6% 96%, rgba(15,38,34,0.05) 0%, transparent 40%)",
            }}
          />
          {/* double hairline frame with brass diamond corners — classic hotel-menu border */}
          <div className="hidden lg:block absolute inset-5 border border-brass/30">
            <span className="absolute -left-[3px] -top-[3px] h-1.5 w-1.5 rotate-45 bg-brass" />
            <span className="absolute -right-[3px] -top-[3px] h-1.5 w-1.5 rotate-45 bg-brass" />
            <span className="absolute -left-[3px] -bottom-[3px] h-1.5 w-1.5 rotate-45 bg-brass" />
            <span className="absolute -right-[3px] -bottom-[3px] h-1.5 w-1.5 rotate-45 bg-brass" />
          </div>
          <div className="hidden lg:block absolute inset-[26px] border border-brass/15" />
          {/* vertical brass hairlines fading in/out — flank the blank side fields */}
          <div className="hidden xl:block absolute inset-y-0 left-14 w-px bg-gradient-to-b from-transparent via-brass/25 to-transparent" />
          <div className="hidden xl:block absolute inset-y-0 right-14 w-px bg-gradient-to-b from-transparent via-brass/25 to-transparent" />
        </div>

        <div className="flex items-center justify-end gap-3 px-6 sm:px-10 pt-6">
          <p className="text-[12px] text-muted-ink">Welcome to Velurex HMS</p>
          <span className="h-px w-12 bg-brass/70" />
        </div>

        <div className="flex-1 flex items-center justify-center p-6">
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="relative w-full max-w-[420px]"
          >
            {/* art-deco corner brackets framing the sign-in card (wide screens) */}
            <div aria-hidden className="pointer-events-none absolute -inset-x-7 -inset-y-6 hidden xl:block">
              <span className="absolute left-0 top-0 h-7 w-7 border-l border-t border-brass/50" />
              <span className="absolute right-0 top-0 h-7 w-7 border-r border-t border-brass/50" />
              <span className="absolute left-0 bottom-0 h-7 w-7 border-l border-b border-brass/50" />
              <span className="absolute right-0 bottom-0 h-7 w-7 border-r border-b border-brass/50" />
              <span className="absolute -top-1 left-1/2 -translate-x-1/2 h-1.5 w-1.5 rotate-45 bg-brass/60" />
              <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-1.5 w-1.5 rotate-45 bg-brass/60" />
            </div>
            <div className="panel p-7 sm:p-8 border-line-strong/60 shadow-[0_18px_50px_-20px_rgba(15,38,34,0.35)]">
              <div className="flex justify-center lg:justify-start">
                <BrandMark size={48} />
              </div>

              <h2 className="font-display text-[26px] font-semibold text-pine tracking-tight mt-5 leading-tight">
                {reset ? "Set Your Permanent Password" : mfa ? "Two-Factor Verification" : "Welcome Back"}
              </h2>
              <p className="text-muted-ink text-[13.5px] mt-1">
                {reset
                  ? "One last step before you continue"
                  : mfa
                    ? "Enter the code from your authenticator app"
                    : "Sign in to your account to continue"}
              </p>

              {reset ? (
                <>
                  <div className="mt-4 flex items-center gap-2 rounded-md border border-pine-700/25 bg-pine-100 px-3 py-2">
                    <Mail className="h-3.5 w-3.5 text-pine-700 shrink-0" />
                    <span className="text-[13px] font-medium text-pine-700 truncate">{reset.user.email}</span>
                  </div>
                  <div className="mt-3 flex items-start gap-2.5 rounded-md border border-brass/35 bg-brass-50 px-3 py-2.5">
                    <ShieldCheck className="h-4 w-4 text-brass shrink-0 mt-0.5" />
                    <p className="text-[12.5px] leading-snug text-pine">
                      You&apos;re signed in with a <span className="font-semibold">temporary password</span>.
                      Set your own permanent password to continue — it replaces the temporary one immediately.
                    </p>
                  </div>

                  <form onSubmit={handleChangePassword} className="mt-5 space-y-4" noValidate>
                    <div>
                      <label className="field-label" htmlFor="cur-password">Current password <span className="text-muted-ink font-normal">(temporary)</span></label>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                        <input
                          id="cur-password"
                          type={showCur ? "text" : "password"}
                          autoComplete="current-password"
                          className="field pl-9 pr-10"
                          placeholder="Enter the temporary password"
                          value={curPw}
                          onChange={(e) => setCurPw(e.target.value)}
                          aria-invalid={!!fieldErr.current}
                        />
                        <button
                          type="button"
                          aria-label={showCur ? "Hide current password" : "Show current password"}
                          onClick={() => setShowCur((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine-700"
                        >
                          {showCur ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {fieldErr.current && <p className="text-[12px] text-danger mt-1">{fieldErr.current}</p>}
                    </div>

                    <div>
                      <label className="field-label" htmlFor="new-password">New password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                        <input
                          id="new-password"
                          type={showNew ? "text" : "password"}
                          autoComplete="new-password"
                          className="field pl-9 pr-10"
                          placeholder="Create your permanent password"
                          value={newPw}
                          onChange={(e) => setNewPw(e.target.value)}
                          aria-invalid={!!fieldErr.next}
                        />
                        <button
                          type="button"
                          aria-label={showNew ? "Hide new password" : "Show new password"}
                          onClick={() => setShowNew((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine-700"
                        >
                          {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {fieldErr.next ? (
                        <p className="text-[12px] text-danger mt-1">{fieldErr.next}</p>
                      ) : (
                        <p className="text-[11.5px] text-muted-ink mt-1.5">Min 8 characters · at least 1 letter · 1 number · 1 symbol</p>
                      )}
                    </div>

                    <div>
                      <label className="field-label" htmlFor="conf-password">Confirm new password</label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                        <input
                          id="conf-password"
                          type={showConf ? "text" : "password"}
                          autoComplete="new-password"
                          className="field pl-9 pr-10"
                          placeholder="Re-enter your new password"
                          value={confPw}
                          onChange={(e) => setConfPw(e.target.value)}
                          aria-invalid={!!fieldErr.confirm}
                        />
                        <button
                          type="button"
                          aria-label={showConf ? "Hide password confirmation" : "Show password confirmation"}
                          onClick={() => setShowConf((v) => !v)}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine-700"
                        >
                          {showConf ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </div>
                      {fieldErr.confirm && <p className="text-[12px] text-danger mt-1">{fieldErr.confirm}</p>}
                    </div>

                    {resetError && (
                      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                        {resetError}
                      </motion.div>
                    )}

                    <button type="submit" disabled={resetLoading} className="btn-pine w-full h-10 gap-2">
                      {resetLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {resetLoading ? "Setting password…" : "Set Password & Continue"}
                    </button>
                  </form>

                  <p className="text-center mt-4">
                    <button
                      type="button"
                      onClick={exitReset}
                      className="text-pine-700 hover:text-brass font-medium text-[13px]"
                    >
                      Sign out instead
                    </button>
                  </p>
                </>
              ) : mfa ? (
                <>
                  <div className="mt-4 flex items-start gap-2.5 rounded-md border border-brass/35 bg-brass-50 px-3 py-2.5">
                    <ShieldCheck className="h-4 w-4 text-brass shrink-0 mt-0.5" />
                    <p className="text-[12.5px] leading-snug text-pine">
                      Your password was accepted. Open your{" "}
                      <span className="font-semibold">authenticator app</span> and enter the current 6-digit
                      code to finish signing in.
                    </p>
                  </div>

                  <form onSubmit={handleVerify2fa} className="mt-5 space-y-4" noValidate>
                    {mfaUseRecovery ? (
                      <div>
                        <label className="field-label" htmlFor="recovery-code">Recovery code</label>
                        <div className="relative">
                          <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                          <input
                            id="recovery-code"
                            type="text"
                            className="field pl-9 uppercase tracking-widest"
                            placeholder="XXXXX-XXXXX"
                            value={mfaCode}
                            onChange={(e) => setMfaCode(e.target.value)}
                            autoFocus
                          />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label className="field-label" htmlFor="totp-code">Verification code</label>
                        <div className="relative">
                          <Smartphone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                          <input
                            id="totp-code"
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            maxLength={6}
                            className="field pl-9 text-center text-lg font-semibold tracking-[0.45em]"
                            placeholder="••••••"
                            value={mfaCode}
                            onChange={(e) => setMfaCode(e.target.value)}
                            autoFocus
                          />
                        </div>
                      </div>
                    )}

                    {mfaError && (
                      <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                        {mfaError}
                      </motion.div>
                    )}

                    <button type="submit" disabled={mfaLoading} className="btn-pine w-full h-10 gap-2">
                      {mfaLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                      {mfaLoading ? "Verifying…" : "Verify & Sign In"}
                    </button>
                  </form>

                  <div className="flex items-center justify-between mt-4">
                    <button
                      type="button"
                      onClick={() => {
                        setMfaUseRecovery((v) => !v);
                        setMfaCode("");
                        setMfaError("");
                      }}
                      className="text-pine-700 hover:text-brass font-medium text-[12.5px]"
                    >
                      {mfaUseRecovery ? "Use authenticator app instead" : "Lost your phone? Use a recovery code"}
                    </button>
                  </div>
                  <p className="text-center mt-3">
                    <button
                      type="button"
                      onClick={exitMfa}
                      className="text-pine-700 hover:text-brass font-medium text-[13px]"
                    >
                      Back to sign in
                    </button>
                  </p>
                </>
              ) : (
                <form onSubmit={handleLogin} className="mt-6 space-y-4">
                  <div>
                    <label className="field-label" htmlFor="email">Email or Username</label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                      <input
                        id="email"
                        type="email"
                        autoComplete="email"
                        className="field pl-9"
                        placeholder="you@company.com"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        required
                      />
                    </div>
                  </div>

                  <div>
                    <label className="field-label" htmlFor="password">Password</label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                      <input
                        id="password"
                        type={showPass ? "text" : "password"}
                        autoComplete="current-password"
                        className="field pl-9 pr-10"
                        placeholder="Enter your password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        required
                      />
                      <button
                        type="button"
                        aria-label={showPass ? "Hide password" : "Show password"}
                        onClick={() => setShowPass((v) => !v)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-ink hover:text-pine-700"
                      >
                        {showPass ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    <label className="flex items-center gap-2 cursor-pointer select-none text-muted-ink">
                      <input
                        type="checkbox"
                        checked={remember}
                        onChange={(e) => setRemember(e.target.checked)}
                        className="h-4 w-4 accent-[#1F4B43]"
                      />
                      Remember me
                    </label>
                    <button
                      type="button"
                      className="text-pine-700 hover:text-brass font-medium"
                      onClick={() => setError("Please contact your property administrator to reset passwords.")}
                    >
                      Forgot password?
                    </button>
                  </div>

                  {error && (
                    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="rounded-md border border-danger/30 bg-danger/5 px-3 py-2 text-sm text-danger">
                      {error}
                    </motion.div>
                  )}

                  <button type="submit" disabled={loading} className="btn-pine w-full h-10 gap-2">
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
                    {loading ? "Signing in…" : "Sign In"}
                    {!loading && <ArrowRight className="h-4 w-4" />}
                  </button>
              </form>
              )}

              <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-muted-ink mt-5 text-center">
                <ShieldCheck className="h-3.5 w-3.5 text-brass shrink-0" />
                Secure login · Role-based access · Each admin only sees their assigned tenant
              </p>
            </div>
          </motion.div>
        </div>

        <div className="flex items-end justify-between px-6 sm:px-10 pb-6 gap-4">
          <p className="text-[11px] text-muted-ink">
            © 2026 Velurex HMS <span className="mx-1.5 text-line-strong">|</span> Built for the Indian Hospitality Industry
          </p>
          <p className="font-script text-brass text-xl leading-none">Hospitality, Simplified</p>
        </div>
      </div>
    </div>
  );
}

export function BrandMark({ size = 40 }: { size?: number }) {
  return (
    <div className="flex items-center gap-3">
      <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
        <g transform="translate(32 26)">
          <path d="M0 -22 C 5 -14 5 -7 0 -1 C -5 -7 -5 -14 0 -22Z" fill="#B9873E" />
          <path d="M-13 -15 C -6.5 -12.5 -3 -8 -1.8 -1.5 C -9 -4 -12 -9 -13 -15Z" fill="#B9873E" opacity="0.85" />
          <path d="M13 -15 C 6.5 -12.5 3 -8 1.8 -1.5 C 9 -4 12 -9 13 -15Z" fill="#B9873E" opacity="0.85" />
          <path d="M-23 -3 C -15 -4 -8.5 -2 -2.5 1 C -10.5 3.6 -18 2 -23 -3Z" fill="#D9B779" opacity="0.8" />
          <path d="M23 -3 C 15 -4 8.5 -2 2.5 1 C 10.5 3.6 18 2 23 -3Z" fill="#D9B779" opacity="0.8" />
          <path d="M-6.5 4 C -2 1.5 2 1.5 6.5 4 C 2 6 -2 6 -6.5 4Z" fill="#B9873E" />
        </g>
        <text x="32" y="47" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="10" letterSpacing="1.8" fill={size > 44 ? "#FBF8F2" : "#FBF8F2"}>VELUREX</text>
        <text x="32" y="56" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontSize="4.6" letterSpacing="3" fill="#B9873E">HMS</text>
      </svg>
    </div>
  );
}
