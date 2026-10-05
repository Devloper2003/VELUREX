import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Schema-resilient Plan / AddonCatalog reads (v2.3.1 hotfix).
 *
 * v2.3.0 added Plan.tagline + Plan.badge and the AddonCatalog table as a
 * purely additive migration (prisma/manual-migrations/
 * v2.3.0_subscription_redesign.sql). Production databases that have not
 * received that migration yet make any full-column Plan read (or any
 * AddonCatalog read) throw Prisma P2021/P2022 — which is exactly the batch of
 * production 500s seen on Channels & OTAs, My Subscription and the owner
 * console ("Unexpected end of JSON input" = non-JSON 500 body).
 *
 * Rules enforced here:
 *  - Hot paths (entitlements, guards, cron) read ONLY the core columns that
 *    exist in every schema version — zero overhead, zero try/catch.
 *  - Marketing columns (tagline/badge) and the add-on catalogue are read
 *    through helpers that degrade gracefully ("" / []) on pre-v2.3.0 schemas
 *    and return real data once the migration is applied.
 *  - Nothing is hard-coded: plans and add-ons remain pure database rows
 *    managed by the software owner; security middleware is untouched.
 */

const SCHEMA_GAP_CODES = new Set(["P2021", "P2022"]);

/**
 * Memo of detected schema gaps so a pre-migration database doesn't re-run the
 * doomed full-column query on every request (one failure logged, then the
 * resilient path is taken directly). Optimistic by default — reset on process
 * restart, self-heals after the migration is applied.
 */
const gapMemo = { plansFull: true, catalog: true };

/** True when a Prisma error means "table/column not provisioned yet". */
export function isSchemaGapError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && SCHEMA_GAP_CODES.has(err.code)) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err);
  return /does not exist in the current database/i.test(msg);
}

/** Core Plan columns — present in every schema version. Safe for `select`. */
export const PLAN_CORE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  monthlyPrice: true,
  features: true,
  sortOrder: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PlanSelect;

/** A Plan row where tagline/badge are guaranteed strings ("" pre-migration). */
export type PlanSafe = {
  id: string;
  code: string;
  name: string;
  description: string;
  monthlyPrice: number;
  features: string;
  sortOrder: number;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  tagline: string;
  badge: string;
};

/** All plans matching `where`; tagline/badge degrade to "" on old schemas. */
export async function findPlansSafe(where?: { active?: boolean }): Promise<PlanSafe[]> {
  if (gapMemo.plansFull) {
    try {
      return await db.plan.findMany({ where, orderBy: { sortOrder: "asc" } });
    } catch (err) {
      if (!isSchemaGapError(err)) throw err;
      gapMemo.plansFull = false;
    }
  }
  const rows = await db.plan.findMany({
    where,
    orderBy: { sortOrder: "asc" },
    select: PLAN_CORE_SELECT,
  });
  return rows.map((r) => ({ ...r, tagline: "", badge: "" }));
}

/** Single plan by id; tagline/badge degrade to "" on old schemas. */
export async function findPlanSafe(id: string): Promise<PlanSafe | null> {
  if (gapMemo.plansFull) {
    try {
      return await db.plan.findUnique({ where: { id } });
    } catch (err) {
      if (!isSchemaGapError(err)) throw err;
      gapMemo.plansFull = false;
    }
  }
  const row = await db.plan.findUnique({ where: { id }, select: PLAN_CORE_SELECT });
  return row ? { ...row, tagline: "", badge: "" } : null;
}

/**
 * AddonCatalog findMany that returns [] (instead of throwing) when the
 * catalogue table has not been provisioned yet — the entitlements engine then
 * falls back to legacy add-on quantities and the marketplace UI simply shows
 * no add-ons until the migration lands.
 */
export async function findCatalogSafe(
  where?: { active?: boolean },
  orderBy: "catalog" | "none" = "catalog"
) {
  if (gapMemo.catalog) {
    try {
      return await db.addonCatalog.findMany({
        where,
        ...(orderBy === "catalog"
          ? { orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }
          : {}),
      });
    } catch (err) {
      if (!isSchemaGapError(err)) throw err;
      gapMemo.catalog = false;
    }
  }
  return [];
}

/** AddonCatalog findUnique that returns null (with `schemaGap` flag) on old schemas. */
export async function findCatalogByKeySafe(key: string): Promise<{ row: Awaited<ReturnType<typeof db.addonCatalog.findUnique>>; schemaGap: boolean }> {
  if (!gapMemo.catalog) return { row: null, schemaGap: true };
  try {
    const row = await db.addonCatalog.findUnique({ where: { key } });
    return { row, schemaGap: false };
  } catch (err) {
    if (!isSchemaGapError(err)) throw err;
    gapMemo.catalog = false;
    return { row: null, schemaGap: true };
  }
}

/**
 * Turn a caught Prisma error into a ready-to-return 503 payload when it is a
 * schema gap (pre-v2.3.0 database), or null when the error is unrelated and
 * should propagate. Honest message — never leaks table/engine internals.
 */
export function schemaGapResponse(err: unknown): NextResponseLike | null {
  if (!isSchemaGapError(err)) return null;
  gapMemo.catalog = false;
  gapMemo.plansFull = false;
  return {
    status: 503,
    body: {
      error:
        "This feature is not provisioned on this database yet. Apply the v2.3.0 migration (prisma/manual-migrations/v2.3.0_subscription_redesign.sql) to enable it.",
      code: "SCHEMA_NOT_MIGRATED",
    },
  };
}

export interface NextResponseLike {
  status: number;
  body: Record<string, unknown>;
}
