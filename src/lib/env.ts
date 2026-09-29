import { readFileSync } from "fs";
import { join } from "path";

/**
 * Canonical environment loader.
 *
 * The sandbox exports a stale DATABASE_URL (old SQLite file) at the process
 * level, and dotenv never overrides already-set process env vars. This module
 * parses the project-root `.env` directly and re-asserts the canonical values
 * for the keys we own, so both `next dev` and standalone scripts (prisma
 * seeds, jobs) talk to the SAME live database.
 *
 * Secret values live ONLY in `.env` (never hardcoded in source).
 */
const PROJECT_ROOT = process.cwd();
const ENV_KEYS = ["DATABASE_URL", "DIRECT_URL", "AUTH_SECRET", "APP_ENCRYPTION_KEY"] as const;

function parseEnvFile(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(join(PROJECT_ROOT, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[key] = value;
    }
  } catch {
    // .env missing — fall back to whatever process.env already carries
  }
  return out;
}

const fileEnv = parseEnvFile();

for (const key of ENV_KEYS) {
  const fromFile = fileEnv[key];
  if (fromFile) {
    // Always let the .env file win for these keys — the file is the source of
    // truth for this deployment (fixes inherited/stale parent-shell exports).
    process.env[key] = fromFile;
  }
}

export const CANONICAL_ENV = {
  DATABASE_URL: process.env.DATABASE_URL ?? "",
  DIRECT_URL: process.env.DIRECT_URL ?? "",
  AUTH_SECRET: process.env.AUTH_SECRET ?? "",
  APP_ENCRYPTION_KEY: process.env.APP_ENCRYPTION_KEY ?? "",
};
