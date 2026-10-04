import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/**
 * GET /api/uploads/[id] — PUBLIC binary image endpoint.
 *
 * Deliberately unauthenticated: the URLs are embedded on the guest-facing
 * booking page (/book) where visitors have no session. Access control happens
 * at write time (POST /api/uploads requires hotel_admin / restaurant_staff).
 * Immutable long-cache — an upload id is never repurposed, so browsers and
 * CDNs can cache the asset for a year.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const asset = await db.assetUpload.findUnique({ where: { id } });
  if (!asset) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const bytes = Buffer.from(asset.data, "base64");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": asset.mime,
      "Content-Length": String(bytes.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
