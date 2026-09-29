# Velurex HMS 🏨

**Smart Hospitality. Seamless Operations.**

A production-grade **Hotel Management System** built for the Indian hospitality market — PMS, booking engine, F&B POS with live folio posting, one-click Night Audit, GST billing, offline-first housekeeping and WhatsApp automation.

![stack](https://img.shields.io/badge/Next.js_16-App_Router-1F4B43) ![ts](https://img.shields.io/badge/TypeScript-5-B9873E) ![prisma](https://img.shields.io/badge/Prisma-SQLite/Postgres-4C7A5A)

---

## ✨ Modules

| Module | Highlights |
|---|---|
| **Dashboard** | Occupancy / ADR / RevPAR / revenue KPIs, floor-wise room tile grid, arrivals & departures feed |
| **PMS** | Rooms & room types, reservation CRUD with hold/waitlist, group bookings (`GRP-*`), drag-and-drop 14-day availability calendar, guest profiles with stay history, seasonal/weekend rate plans |
| **Front Desk** | Check-in with Aadhaar/Passport/ID capture, check-out with folio balance, quick room status changes |
| **Billing & Folio** | Itemised folio (room / F&B / laundry / misc), split billing, GST tax invoice (GSTIN, tax breakup, print/download), payments (cash / UPI / card / netbanking) |
| **Restaurant POS** | Tablet-first terminal, veg/non-veg menu management, dine-in / **room-service / takeaway**, **room orders auto-post to the guest folio in real time**, walk-in settle via cash/UPI/card |
| **Kitchen (KOT)** | Live kitchen queue, per-item progression, elapsed-time alerts |
| **Housekeeping** | Room status board, task assignment with due times, priority, maintenance tickets with photo upload, **offline-first PWA queue (IndexedDB) with auto-sync** |
| **Night Audit** | One-click end-of-day: no-show detection + charges, room-charge posting, transaction lock, revenue report (occupancy %, ADR, RevPAR), business-date roll-forward, full audit trail |
| **Reports** | Occupancy/ADR/RevPAR charts, revenue by source, payment mix, night-audit archive, **Excel/CSV export** |
| **Booking Engine** | Public availability API, real-time inventory sync, promo codes, **Razorpay** checkout (mock mode without keys), embeddable widget snippet |
| **WhatsApp** | Booking confirmations, pre-arrival reminders, post-stay feedback — Meta Cloud API when keys are set, simulated mode otherwise |
| **Dynamic Pricing** | Rule-based auto rate suggestions when occupancy crosses a configurable threshold |

## 🔐 Roles (single unified login, role-based access)

| Role | Email | Password | Access |
|---|---|---|---|
| Hotel Admin | `admin@velurex.in` | `admin123` | Everything |
| Front Desk | `frontdesk@velurex.in` | `front123` | PMS, folio, housekeeping, night audit, reports (no settings/pricing) |
| Housekeeping | `housekeeping@velurex.in` | `house123` | Room status board + tasks + maintenance **only** |
| Restaurant Staff | `restaurant@velurex.in` | `rest123` | POS + Kitchen **only** |

JWT auth (`jose`) + `middleware.ts` guards every `/api/*` route; role checks inside handlers; sidebar/views filtered per role.

## 🚀 Quick start

```bash
bun install                     # or npm install
cp .env.example .env            # adjust as needed (works with zero keys)
bun run db:push                 # create SQLite schema
bun prisma/seed.ts              # seed demo hotel (20 rooms / 3 floors / guests / menu)
bun run dev                     # http://localhost:3000
```

## 🗄 Database

Local development runs on **SQLite** via Prisma (`db/custom.db`). The schema is designed to port to **PostgreSQL** (Supabase/Neon):

1. Set `provider = "postgresql"` in `prisma/schema.prisma`
2. `DATABASE_URL=postgresql://...` in `.env`
3. `bun run db:push && bun prisma/seed.ts`

Core tables: `Property, Staff (role), RoomType, Room, Guest, RatePlan, Reservation, FolioItem, Payment, HousekeepingTask, MaintenanceTicket, MenuItem, PosOrder, PosOrderItem, NightAuditLog, ActivityLog, PromoCode, WhatsAppMessage`.
`NightAuditLog` records business date, run-by, revenue, occupancy, ADR/RevPAR and no-show counts. `PosOrder` links to reservations (nullable) and carries a `folioItemId` once posted to billing.

## 💳 Payments & WhatsApp modes

- **Razorpay** — set `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` to create real orders; without keys the booking engine uses `order_mock_*` ids so the entire flow stays testable.
- **WhatsApp** — set `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID` for Meta Cloud API delivery; otherwise every message is logged with status `mock` (visible in the WhatsApp console view).

## 📴 Offline-first PWA

- `manifest.webmanifest` + service worker (`public/sw.js`): app-shell caching, network-first API cache.
- Housekeeping mutations go through an IndexedDB queue (`src/lib/offline-queue.ts`); when offline, changes are stored locally and replayed automatically on reconnect (idempotent via `clientRef`).

## 🧪 Useful scripts

```bash
bun run lint            # eslint
bun run db:push         # sync schema
bun prisma/seed.ts      # reseed demo data
```

## 📁 Structure

```
src/
  app/
    api/                 # auth, dashboard, rooms, reservations, calendar, guests,
                         # rate-plans, folio, payments, invoice, housekeeping,
                         # maintenance, upload, menu, pos, kot, night-audit,
                         # reports, settings, booking-engine, whatsapp, pricing
    page.tsx             # login ⇄ app shell (single-page app)
  components/
    auth/LoginScreen.tsx shell/AppShell.tsx views/*.tsx
  lib/                   # auth (JWT), db, format (₹/en-IN), offline-queue, whatsapp…
  middleware.ts          # API route-level JWT gate
prisma/                  # schema + seed
public/                  # sw.js, manifest, brand images
```

## 🎨 Design system

Plaster `#EFE6D8` background · panel `#FBF8F2` · dark-pine sidebar `#0F2622` · pine accent `#1F4B43` · brass `#B9873E` · status: vacant `#4C7A5A`, dirty `#C08A2E`, out-of-order `#A44534`. Fraunces (headings) + IBM Plex Sans (UI). Bordered panels, no floating shadows.
