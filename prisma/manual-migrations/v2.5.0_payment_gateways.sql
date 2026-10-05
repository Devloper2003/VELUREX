-- Velurex HMS — v2.5.0 "White Label" manual migration (Neon PostgreSQL)
-- Payment gateways: the software owner assigns online payment providers to
-- tenant properties. Apply with the production DB when deploying v2.5.0:
--   psql "$DATABASE_URL" -f prisma/manual-migrations/v2.5.0_payment_gateways.sql
-- Idempotent (IF NOT EXISTS). No existing data is touched.

CREATE TABLE IF NOT EXISTS "PaymentGateway" (
    "id"         TEXT NOT NULL,
    "propertyId" TEXT NOT NULL,
    "provider"   TEXT NOT NULL,
    "label"      TEXT NOT NULL DEFAULT '',
    "mode"       TEXT NOT NULL DEFAULT 'test',
    "enabled"    BOOLEAN NOT NULL DEFAULT true,
    "isDefault"  BOOLEAN NOT NULL DEFAULT false,
    "merchantId" TEXT NOT NULL DEFAULT '',
    "secret"     TEXT NOT NULL DEFAULT '',
    "notes"      TEXT NOT NULL DEFAULT '',
    "addedBy"    TEXT NOT NULL DEFAULT '',
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentGateway_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'PaymentGateway_propertyId_fkey'
    ) THEN
        ALTER TABLE "PaymentGateway"
            ADD CONSTRAINT "PaymentGateway_propertyId_fkey"
            FOREIGN KEY ("propertyId") REFERENCES "Property"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS "PaymentGateway_propertyId_enabled_idx"
    ON "PaymentGateway"("propertyId", "enabled");
