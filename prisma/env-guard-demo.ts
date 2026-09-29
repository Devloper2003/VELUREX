/**
 * Guard: demo seed scripts must never touch the live PostgreSQL database.
 * Import at the top of any script that plants demo/sample data.
 */
import { readFileSync } from "fs";

function databaseUrl(): string {
  if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith("file:")) {
    return process.env.DATABASE_URL;
  }
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^DATABASE_URL=(.+)$/);
      if (m) return m[1].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    /* ignore */
  }
  return process.env.DATABASE_URL ?? "";
}

const url = databaseUrl();
if (url.startsWith("postgresql://") || url.startsWith("postgres://")) {
  console.error(
    "✋ REFUSED: this is a DEMO seed script and the configured database is the LIVE " +
      "PostgreSQL (Neon) instance. The live database must stay free of demo data.\n" +
      "For the live DB use: bun prisma/seed-live.ts"
  );
  process.exit(1);
}
