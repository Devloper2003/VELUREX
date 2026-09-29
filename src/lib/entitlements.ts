import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * Central entitlements engine (PART 4 of the platform spec).
 *
 * A tenant's effective entitlements = plan.features (JSON on the Plan row —
 * the single source of truth, never hard-coded) + subscription add-ons +
 * per-tenant feature_overrides, merged in that order.
 *
 * Guards used by hotel-side API routes:
 *   requireFeature(session, "pos")            → 403 FEATURE_LOCKED when off
 *   checkLimit(session, "rooms", current)     → 403 LIMIT_REACHED at cap
 *   assertWritable(session)                   → 403 READ_ONLY when suspended
 */

export interface SubscriptionState {
  id: string;
  planId: string;
  planCode: string;
  planName: string;
  monthlyPrice: number;
  cycle: string;
  status: string; // trial | active | overdue | suspended | cancelled | paused
  startedAt: Date | null;
  renewalAt: Date | null;
  trialEndsAt: Date | null;
  autoRenew: boolean;
  pendingPlanId: string | null;
}

export interface Entitlements {
  features: Record<string, boolean | number | string>;
  limits: Record<string, number>; // -1 = unlimited
  plan: { id: string; code: string; name: string; monthlyPrice: number } | null;
  subscription: SubscriptionState | null;
  addons: { addonKey: string; label: string; qty: number; price: number; oneOff: boolean }[];
  overrides: { featureKey: string; enabled: boolean | null; limitValue: number | null; note: string }[];
  writable: boolean; // false → suspended, or overdue past grace period
  warning: string | null; // human-facing banner text (overdue / trial ending)
  trialDaysLeft: number | null;
  graceDaysLeft: number | null;
}

const LIMIT_KEYS = ["rooms", "staff", "properties", "ota_channels", "whatsapp_msgs"];
const CACHE_TTL = 15_000;
const cache = new Map<string, { at: number; value: Entitlements }>();

async function getSettingNumber(key: string, fallback: number): Promise<number> {
  const row = await db.platformSetting.findUnique({ where: { key } });
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export async function clearEntitlementsCache(propertyId?: string) {
  if (propertyId) cache.delete(propertyId);
  else cache.clear();
}

/** Merge plan features + add-ons + overrides into effective entitlements. */
export async function getTenantEntitlements(propertyId: string): Promise<Entitlements> {
  const hit = cache.get(propertyId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const property = await db.property.findUnique({ where: { id: propertyId } });
  const subscription = await db.subscription.findUnique({
    where: { propertyId },
    include: { plan: true },
  });

  const planFeatures = subscription?.plan?.features
    ? (JSON.parse(subscription.plan.features) as Record<string, boolean | number | string>)
    : {};

  const addons = await db.subscriptionAddon.findMany({ where: { propertyId, active: true } });
  const overrides = await db.featureOverride.findMany({ where: { propertyId } });

  // 1. base limits from plan (limit keys only; -1 = unlimited)
  const limits: Record<string, number> = {};
  for (const k of LIMIT_KEYS) {
    const v = planFeatures[k];
    limits[k] = typeof v === "number" ? v : 0;
  }

  // 2. add-ons raise the caps
  const addonList = addons.map((a) => ({
    addonKey: a.addonKey, label: a.label, qty: a.qty, price: a.price, oneOff: a.oneOff,
  }));
  const addonMap: Record<string, number> = {
    rooms_pack: 10, staff_pack: 5, whatsapp_pack: 100, ota_pack: 1,
  };
  for (const a of addons) {
    const per = addonMap[a.addonKey] ?? 0;
    const key = a.addonKey.replace("_pack", "s").replace("otass", "ota_channels").replace("whatsapps", "whatsapp_msgs");
    const mapped = a.addonKey === "rooms_pack" ? "rooms"
      : a.addonKey === "staff_pack" ? "staff"
      : a.addonKey === "whatsapp_pack" ? "whatsapp_msgs"
      : a.addonKey === "ota_pack" ? "ota_channels" : null;
    if (mapped && per > 0 && limits[mapped] !== -1) limits[mapped] += per * a.qty;
  }
  void addonMap;

  // 3. per-tenant overrides (final say)
  const overrideList = overrides.map((o) => ({
    featureKey: o.featureKey, enabled: o.enabled, limitValue: o.limitValue, note: o.note,
  }));
  for (const o of overrides) {
    if (o.limitValue !== null && o.limitValue !== undefined) limits[o.featureKey] = o.limitValue;
    if (o.enabled !== null && o.enabled !== undefined) planFeatures[o.featureKey] = o.enabled;
  }

  // ── effective status (stored status + clock checks)
  const graceDays = await getSettingNumber("grace_days", 7);
  const now = Date.now();
  let status = subscription?.status ?? "none";
  let graceDaysLeft: number | null = null;

  if (status === "trial" && subscription?.trialEndsAt && subscription.trialEndsAt.getTime() < now) {
    status = "overdue"; // trial lapsed → grace window before suspension
  }
  if (status === "overdue" && subscription?.renewalAt) {
    const graceEnd = subscription.renewalAt.getTime() + graceDays * 86400000;
    graceDaysLeft = Math.max(0, Math.ceil((graceEnd - now) / 86400000));
    if (now > graceEnd) status = "suspended_readonly"; // past grace → read-only until paid/suspended
  }

  let warning: string | null = null;
  let trialDaysLeft: number | null = null;
  if (status === "trial" && subscription?.trialEndsAt) {
    trialDaysLeft = Math.max(0, Math.ceil((subscription.trialEndsAt.getTime() - now) / 86400000));
    if (trialDaysLeft <= 7) warning = `Your free trial ends in ${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"}. Choose a plan to keep your workspace.`;
  }
  if (status === "overdue" && subscription?.renewalAt) {
    const overdueDays = Math.max(1, Math.ceil((now - subscription.renewalAt.getTime()) / 86400000));
    warning = `Payment overdue by ${overdueDays} day${overdueDays === 1 ? "" : "s"}. Please pay now — ${graceDaysLeft === 0 ? "your workspace is read-only until then" : `read-only starts in ${graceDaysLeft} day${graceDaysLeft === 1 ? "" : "s"}`}.`;
  }
  if (status === "suspended") {
    warning = "Your subscription is suspended. Data is safe — pay now or contact support to restore access.";
  }
  if (status === "suspended_readonly") {
    warning = "Payment overdue — your workspace is read-only. Pay now to restore full access.";
  }

  const value: Entitlements = {
    features: planFeatures,
    limits,
    plan: subscription?.plan
      ? { id: subscription.plan.id, code: subscription.plan.code, name: subscription.plan.name, monthlyPrice: subscription.plan.monthlyPrice }
      : null,
    subscription: subscription
      ? {
          id: subscription.id, planId: subscription.planId, planCode: subscription.plan.code,
          planName: subscription.plan.name, monthlyPrice: subscription.plan.monthlyPrice,
          cycle: subscription.cycle, status: subscription.status, startedAt: subscription.startedAt,
          renewalAt: subscription.renewalAt, trialEndsAt: subscription.trialEndsAt,
          autoRenew: subscription.autoRenew, pendingPlanId: subscription.pendingPlanId,
        }
      : null,
    addons: addonList,
    overrides: overrideList,
    writable: status !== "suspended" && status !== "suspended_readonly" && status !== "cancelled",
    warning,
    trialDaysLeft,
    graceDaysLeft,
  };

  cache.set(propertyId, { at: Date.now(), value });
  return value;
}

/** Guard: boolean feature flag (pos, night_audit, whatsapp_automation, …). */
export function requireFeature(
  ent: Entitlements,
  featureKey: string,
  label?: string
): NextResponse | null {
  const v = ent.features[featureKey];
  if (v === true) return null;
  const planName = ent.plan?.name ?? "your current plan";
  const need = label ?? featureKey.replace(/_/g, " ");
  return NextResponse.json(
    {
      error: `${label ?? need} is not included in ${planName}. Upgrade your plan to unlock it.`,
      code: "FEATURE_LOCKED",
      feature: featureKey,
      upgradeRequired: true,
      currentPlan: ent.plan?.code ?? null,
    },
    { status: 403 }
  );
}

/** Guard: numeric cap (rooms, staff, ota_channels, whatsapp_msgs…). -1 = unlimited. */
export function checkLimit(
  ent: Entitlements,
  limitKey: string,
  currentCount: number,
  label?: string
): NextResponse | null {
  const cap = ent.limits[limitKey];
  if (cap === undefined || cap === -1 || currentCount < cap) return null;
  const need = label ?? limitKey.replace(/_/g, " ");
  return NextResponse.json(
    {
      error: `You've reached your plan's limit of ${cap} ${need}. Upgrade your plan or add an add-on pack to add more.`,
      code: "LIMIT_REACHED",
      limit: limitKey,
      cap,
      upgradeRequired: true,
      currentPlan: ent.plan?.code ?? null,
    },
    { status: 403 }
  );
}

/** Guard: workspace must not be read-only (overdue past grace / suspended). */
export function assertWritable(ent: Entitlements): NextResponse | null {
  if (ent.writable) return null;
  return NextResponse.json(
    {
      error:
        ent.subscription?.status === "suspended"
          ? "Your subscription is suspended — the workspace is read-only. Pay now or contact support to restore access."
          : "Payment overdue — the workspace is read-only. Pay now to continue making changes.",
      code: "READ_ONLY",
      upgradeRequired: false,
      status: ent.subscription?.status ?? null,
    },
    { status: 403 }
  );
}

/** Convenience wrapper: entitlements for the session's property, 403 if none. */
export async function entitlementsForSession(propertyId: string): Promise<Entitlements> {
  return getTenantEntitlements(propertyId);
}
