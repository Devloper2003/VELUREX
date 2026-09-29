import { PrismaClient } from '@prisma/client'
import '@/lib/env'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Timeout widening for pooled PostgreSQL (Neon pgbouncer) + legacy local files:
// long transactions (night audit, oversale-guard drill) must not trip the
// default 5s socket timeout. Appending the param keeps the URL canonical.
const baseUrl = process.env.DATABASE_URL ?? "file:./db/custom.db";
const extra = baseUrl.startsWith("postgresql") ? "socket_timeout=30&pool_timeout=30" : "socket_timeout=30";
const dbUrl = baseUrl.includes("?") ? `${baseUrl}&${extra}` : `${baseUrl}?${extra}`;

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: { db: { url: dbUrl } },
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db
