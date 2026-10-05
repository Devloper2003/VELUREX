-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "badge" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "tagline" TEXT NOT NULL DEFAULT '';

-- CreateTable
CREATE TABLE "AddonCatalog" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "category" TEXT NOT NULL DEFAULT 'feature',
    "price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "oneOff" BOOLEAN NOT NULL DEFAULT false,
    "grants" TEXT NOT NULL DEFAULT '{}',
    "planCodes" TEXT NOT NULL DEFAULT '[]',
    "badge" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT 'puzzle',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddonCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AddonCatalog_key_key" ON "AddonCatalog"("key");

