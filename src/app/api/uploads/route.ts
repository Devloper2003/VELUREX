import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAuth } from "@/lib/auth";
import { logActivity } from "@/lib/business";

/**
 * POST /api/uploads — store a small image asset (menu photos, room photos).
 *
 * Roles: hotel_admin, restaurant_staff. Accepts JSON { mime, dataBase64 }
 * where dataBase64 is raw base64 (an optional `data:` URL prefix is tolerated).
 *
 * Security:
 *  - mime must be image/jpeg | image/png | image/webp (whitelist);
 *  - decoded payload must be ≤ 400 KB (413 otherwise);
 *  - the actual bytes must start with the matching magic number — a renamed
 *    .exe or an HTML polyglot is rejected even if the client claims "image/png".
 *
 * Returns { url: "/api/uploads/<id>", id } — the URL is publicly readable so
 * photos can render on the guest-facing booking page.
 */

const MAX_BYTES = 400_000;

const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);

/** Decoded-byte magic numbers per allowed mime type. */
function matchesMagic(mime: string, bytes: Uint8Array): boolean {
  const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (mime === "image/jpeg") return startsWith([0xff, 0xd8, 0xff]);
  if (mime === "image/png") return startsWith([0x89, 0x50, 0x4e, 0x47]); // 89504E47
  if (mime === "image/webp") return startsWith([0x52, 0x49, 0x46, 0x46]); // "RIFF" (bytes 8-11 are "WEBP")
  return false;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req, ["hotel_admin", "restaurant_staff"]);
  if ("error" in auth) return auth.error;
  const propertyId = auth.session.propertyId;

  const body = (await req.json().catch(() => null)) as {
    mime?: unknown;
    dataBase64?: unknown;
  } | null;

  const mime = typeof body?.mime === "string" ? body.mime.trim().toLowerCase() : "";
  if (!ALLOWED_MIME.has(mime)) {
    return NextResponse.json(
      { error: "mime must be one of image/jpeg, image/png, image/webp" },
      { status: 400 }
    );
  }

  let raw = typeof body?.dataBase64 === "string" ? body.dataBase64.trim() : "";
  if (!raw) return NextResponse.json({ error: "dataBase64 is required" }, { status: 400 });

  // Tolerate a data-URL wrapper ("data:image/jpeg;base64,xxxx").
  const commaIdx = raw.indexOf(",");
  if (raw.startsWith("data:") && commaIdx !== -1) raw = raw.slice(commaIdx + 1).trim();

  // Guard the decode itself: a multi-MB string should never reach Buffer.from.
  if (raw.length > Math.ceil((MAX_BYTES + 1) / 3) * 4 + 8) {
    return NextResponse.json({ error: "Image is too large — maximum 400 KB after compression" }, { status: 413 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    return NextResponse.json({ error: "dataBase64 is not valid base64" }, { status: 400 });
  }

  if (buffer.length === 0) {
    return NextResponse.json({ error: "dataBase64 is not valid base64" }, { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "Image is too large — maximum 400 KB after compression" }, { status: 413 });
  }
  if (!matchesMagic(mime, buffer)) {
    return NextResponse.json(
      { error: "File content does not match the declared image type" },
      { status: 400 }
    );
  }

  const asset = await db.assetUpload.create({
    data: {
      propertyId,
      mime,
      data: buffer.toString("base64"),
      size: buffer.length,
    },
  });

  await logActivity({
    propertyId,
    staffId: auth.session.sub,
    staffName: auth.session.name,
    action: "ASSET_UPLOAD",
    entity: "AssetUpload",
    entityId: asset.id,
    details: `Uploaded ${mime} (${(buffer.length / 1024).toFixed(1)} KB) → /api/uploads/${asset.id}`,
  });

  return NextResponse.json({ url: `/api/uploads/${asset.id}`, id: asset.id }, { status: 201 });
}
