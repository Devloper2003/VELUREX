import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";

/**
 * Velurex HMS — shared API route error wrapper.
 *
 * Every money-path route (payments, folio, POS settle) runs inside this so a
 * database hiccup surfaces as a precise, actionable JSON error instead of an
 * opaque 500 with an empty body (the "Request failed (500)" toast class).
 *
 * Translations:
 *  - P2021 / P2022 (table/column missing) → 503 "schema out of sync" with the
 *    exact remediation — this was the production payment-500 class of v2.9.0.
 *  - P2002 unique constraint → 409
 *  - P2025 record not found → 404
 *  - anything else → 500 with the real message, logged server-side with a
 *    route label for dev.log greppability.
 */
export async function handleRoute<T>(
  label: string,
  fn: () => Promise<NextResponse<T>>
): Promise<NextResponse<T>> {
  try {
    return await fn();
  } catch (err) {
    return toErrorResponse(label, err);
  }
}

export function toErrorResponse(label: string, err: unknown): NextResponse {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2021" || err.code === "P2022") {
      console.error(`[${label}] DB schema out of sync:`, err.message);
      return NextResponse.json(
        {
          error:
            "Database schema is out of sync with the app — apply the pending migration (db push) and retry. Missing: " +
            (err.message.match(/(\S+)$/)?.[1] ?? "column/table"),
        },
        { status: 503 }
      );
    }
    if (err.code === "P2002") {
      return NextResponse.json(
        { error: "A record with these details already exists." },
        { status: 409 }
      );
    }
    if (err.code === "P2025") {
      return NextResponse.json(
        { error: "Record not found — it may have been deleted or already processed." },
        { status: 404 }
      );
    }
    console.error(`[${label}] Prisma ${err.code}:`, err.message);
    return NextResponse.json(
      { error: `Database error (${err.code}) — please retry.` },
      { status: 500 }
    );
  }
  if (err instanceof Prisma.PrismaClientInitializationError) {
    // Wrong URL / unreachable DB / auth failure
    console.error(`[${label}] DB connection failed:`, err.message);
    return NextResponse.json(
      { error: "Database connection failed — check DATABASE_URL on the server." },
      { status: 503 }
    );
  }
  console.error(`[${label}]`, err);
  const msg = err instanceof Error ? err.message : "Unexpected server error";
  return NextResponse.json({ error: msg }, { status: 500 });
}
