# Velurex HMS 🏨

**Smart Hospitality. Seamless Operations.**

A production-grade **multi-tenant Hotel Management SaaS** for the Indian hospitality market — full PMS, booking engine, F&B POS with live folio posting, one-click Night Audit, GST billing, offline-first housekeeping, WhatsApp automation — plus a built-in **SaaS business layer** (plans, subscriptions, billing, support) for the software owner.

![stack](https://img.shields.io/badge/Next.js_16-App_Router-1F4B43) ![ts](https://img.shields.io/badge/TypeScript-5-B9873E) ![prisma](https://img.shields.io/badge/Prisma-Neon_PostgreSQL-4C7A5A)

> ⚠️ This repository intentionally contains **no secrets** and **no demo credentials**. All configuration is supplied at runtime via environment variables (see [`.env.example`](./.env.example)).

---

## ✨ Modules

| Module | Highlights |
|---|---|
| **Dashboard** | Occupancy / ADR / RevPAR / revenue KPIs, floor-wise room tile grid, arrivals & departures feed |
| **PMS** | Rooms & room types, reservation CRUD with hold/waitlist, group bookings, drag-and-drop 14-day availability calendar, guest profiles with stay history, seasonal/weekend rate plans |
| **Front Desk** | Check-in with ID capture, check-out with folio balance, quick room status changes |
| **Billing & Folio** | Itemised folio (room / F&B / laundry / misc), split billing, GST tax invoice (GSTIN, tax breakup, print/download), payments (cash / UPI / card / netbanking) |
| **Restaurant POS** | Tablet-first terminal, veg/non-veg menu, dine-in / room-service / takeaway, room orders auto-post to the guest folio in real time |
| **Kitchen (KOT)** | Live kitchen queue, per-item progression, elapsed-time alerts |
| **Housekeeping** | Room status board, task assignment, maintenance tickets with photo upload, **offline-first PWA queue (IndexedDB) with auto-sync** |
| **Night Audit** | One-click end-of-day: no-show charges, room-charge posting, transaction lock, revenue report, business-date roll-forward, full audit trail |
| **Reports** | Occupancy/ADR/RevPAR charts, revenue by source, payment mix, night-audit archive, Excel/CSV export |
| **Booking Engine** | Public availability API, real-time inventory sync, promo codes, Razorpay checkout (mock mode without keys), embeddable widget snippet |
| **WhatsApp** | Booking confirmations, pre-arrival reminders, post-stay feedback — Meta Cloud API when keys are set, simulated mode otherwise |
| **Dynamic Pricing** | Rule-based auto rate suggestions when occupancy crosses a configurable threshold |
| **SaaS Platform (owner)** | 16-tab owner dashboard: overview, businesses, subscriptions, plans, billing & GST invoices, coupons, support tickets, announcements, onboarding leads, integrations, settings, system health, audit trail, analytics |

## 🔐 Roles & Access Control

Single unified login with **role-based access** — the sidebar and every API route are scoped per role (`Hotel Admin`, `Front Desk`, `Housekeeping`, `Restaurant Staff`), plus a separate, capability-matrix-guarded **Software Owner** console for the SaaS business layer.

- JWT sessions (`jose`) carried in an **HttpOnly + SameSite cookie** (no tokens in localStorage)
- Every `/api/*` route passes a route-level gate (`src/proxy.ts`); fine-grained role checks live inside handlers
- Tenant data is strictly scoped by `tenant_id`; all privileged actions land in an append-only audit trail
- Tenant accounts are provisioned by the owner (temporary password → forced reset on first login)

## 🛡 Security

- scrypt password hashing + temporary-password (`Vlx@XXXXXXXX`) forced-reset flow
- CSRF protection via **Fetch Metadata** (`Sec-Fetch-Site`) with legacy Origin fallback
- Login **rate-limiting**: per-IP wall + per-email lockout (429 + `Retry-After`)
- **TOTP 2FA**: AES-256-GCM encrypted secrets, scrypt-hashed single-use recovery codes
- Full security headers: CSP, HSTS (2y), `X-Frame-Options: DENY`, nosniff, Permissions-Policy, COOP
- AES-256-GCM at-rest encryption for WhatsApp tokens / platform API keys (masked reads)
- Demo-seed hard-guard: the live PostgreSQL database refuses demo/test seeding

## 🚀 Getting Started (local)

```bash
bun install                     # postinstall runs `prisma generate`
cp .env.example .env            # fill in the Neon URL + generated secrets
bun run dev                     # http://localhost:3000
```

The app is a single-page application: login, tenant dashboard and owner console all render on `/` via client-side view switching.

## 🗄 Database

Production runs on **Neon PostgreSQL** (schema: `prisma/schema.prisma`, provider `postgresql`). Core hotel tables: `Property, Staff, RoomType, Room, Guest, RatePlan, Reservation, FolioItem, Payment, HousekeepingTask, MaintenanceTicket, MenuItem, PosOrder, NightAuditLog, ActivityLog, PromoCode, WhatsAppMessage`. The SaaS layer adds `Plan, Subscription, SubscriptionAddon, FeatureOverride, Invoice, Coupon, SupportTicket, Announcement, PlatformUser, PlatformAuditLog, PlatformSetting` and more.

## 🚢 Deployment (Vercel + Neon)

1. **Import** the repo into Vercel (framework auto-detects Next.js).
2. **Environment variables** (Project → Settings → Environment Variables):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | Neon **pooled** connection string |
   | `DIRECT_URL` | Neon **direct** connection string |
   | `AUTH_SECRET` | `openssl rand -base64 48` output |
   | `APP_ENCRYPTION_KEY` | `openssl rand -hex 32` output |

   ⚠️ Keep secrets **stable**: rotating `APP_ENCRYPTION_KEY` makes existing encrypted rows unreadable; rotating `AUTH_SECRET` signs everyone out.
3. **Region**: [`vercel.json`](./vercel.json) pins serverless functions to `sin1` (Singapore) — colocated with the Neon database (`ap-southeast-1`) so DB round-trips stay in single-digit milliseconds.
4. **Deploy**. Subsequent pushes to `main` auto-deploy (PRs get preview deployments).
5. `GET /api/health` is a public health-check endpoint that verifies database connectivity on every probe (returns `503` when the database is unreachable).

## 💳 Payments & WhatsApp modes

- **Razorpay** — set `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` to create real orders; without keys the booking engine uses `order_mock_*` ids so the entire flow stays testable.
- **WhatsApp** — set `WHATSAPP_TOKEN`/`WHATSAPP_PHONE_ID` for Meta Cloud API delivery; otherwise every message is logged with status `mock` (visible in the WhatsApp console view).

## 📴 Offline-first PWA

- `manifest.webmanifest` + service worker (`public/sw.js`): app-shell caching, network-first API cache.
- Housekeeping mutations go through an IndexedDB queue (`src/lib/offline-queue.ts`); when offline, changes are stored locally and replayed automatically on reconnect (idempotent via `clientRef`).

## 🧪 Useful scripts

```bash
bun run lint            # eslint
bun run db:generate     # prisma generate (also runs on postinstall)
bun run db:push         # sync schema to the configured database
```

> Demo seeding is **refused on live PostgreSQL** by design — it only applies to throwaway local SQLite environments.

## 📁 Structure

```
src/
  app/
    api/                 # auth, dashboard, rooms, reservations, calendar, guests,
                         # rate-plans, folio, payments, invoice, housekeeping,
                         # maintenance, upload, menu, pos, kot, night-audit,
                         # reports, settings, booking-engine, whatsapp, pricing,
                         # owner (SaaS platform), health
    page.tsx             # login ⇄ app shell (single-page app)
  components/
    auth/ shell/ views/ owner/
  lib/                   # auth (JWT + CSRF + TOTP), db, entitlements, format, offline-queue, whatsapp…
  proxy.ts               # route-level JWT/CSRF gate (Next 16 proxy convention)
prisma/                  # schema
public/                  # sw.js, manifest, brand images
```

## 🎨 Design system

Plaster `#EFE6D8` background · panel `#FBF8F2` · dark-pine sidebar `#0F2622` · pine accent `#1F4B43` · brass `#B9873E` · status: vacant `#4C7A5A`, dirty `#C08A2E`, out-of-order `#A44534`. Fraunces (headings) + IBM Plex Sans (UI) + Great Vibes (brand script). Bordered panels, no floating shadows.

## License

All rights reserved © Velurex HMS.
