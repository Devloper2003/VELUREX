# Velurex HMS — Changelog

All notable changes to Velurex HMS are documented here, newest first.

## Versioning convention (release series)

- **SemVer** `MAJOR.MINOR.PATCH` — the series is continuous; every change that lands on `main` bumps the version and gets an entry.
- **MAJOR** — big milestone, pricing/data-model migration, or rebrand.
- **MINOR** — a feature drop: new functionality shipped to production.
- **PATCH** — bug fixes and UI polish with no new features.
- Single source of truth: `src/lib/version.ts` (`APP_VERSION` + `RELEASES`). In the product UI the version appears as plain text in the tenant sidebar/footer and platform-console footer, and `GET /api/health` reports it — keep this file in sync on every release.

---

## [2.3.1] — 2026-10-05 · Resilience Patch

### Fixed — production 500s on pre-v2.3.0 databases
- **Root cause**: v2.3.0 added `Plan.tagline` / `Plan.badge` columns and the `AddonCatalog` table as an additive migration, but production databases that have not applied `prisma/manual-migrations/v2.3.0_subscription_redesign.sql` yet made every full-column Plan read (and any AddonCatalog read) throw Prisma P2021/P2022. Because the entitlements engine is used by nearly every guarded route, this surfaced as 500s across Channels & OTAs ("Could not load channels"), My Subscription ("Unexpected end of JSON input" — non-JSON error body) and the entire owner console.
- **Schema-resilient reads** (`src/lib/plan-safe.ts`): hot paths (entitlements, guards, cron) now select only the core Plan columns that exist in every schema version; marketing columns and the add-on catalogue are read through helpers that degrade gracefully (`""` / `[]`) on older schemas and return real data automatically once the migration is applied. A per-process memo stops repeated doomed queries from re-running (one attempt, then the resilient path; self-heals after restart/migration).
- **Graceful writes**: owner plan create/update retries with core columns (tagline/badge edits are skipped harmlessly on old schemas); add-on catalogue reads/writes return honest 503 JSON (`SCHEMA_NOT_MIGRATED`) instead of crashing; tenant `buy_addon` reports the same clear message.
- **Zero data touched**: the patch is read/write resilient on both pre- and post-v2.3.0 schemas — no existing plans, subscriptions, invoices, add-on purchases or overrides are modified, and no destructive SQL is introduced. Security middleware (rate limits, CSRF guard, proxy headers, AES-256-GCM secrets) is untouched; no data was hard-coded into source.
- **Verification**: old-schema simulation on a live database (rename-based rollback of tagline/badge + AddonCatalog) confirmed every entitlements call, plan read and catalog read degrades gracefully with legacy add-on fallbacks intact, then restores with zero data loss; full browser QA (owner console, impersonation, tenant My Subscription + Channels) passed with zero console errors.

---

## [2.3.0] — 2026-10-05 · Pricing Studio

### Added — subscription model redesign (4 tiers + add-ons marketplace)
- **Four-tier plans** replace the three-tier model: **Starter ₹1,999** (10 rooms / 3 staff / 1 OTA / 50 WA msgs — guesthouses & small B&Bs), **Basic ₹4,999** (25 rooms / 10 staff / 3 OTA / 200 WA msgs + Restaurant POS + Excel export), **Pro ₹9,999** (75 rooms / 30 staff / 3 properties / 6 OTA / 1000 WA msgs + Night Audit + WhatsApp Automation + Advanced Reports + Multi-property — badge *Most Popular*), **Enterprise ₹19,999** (unlimited rooms/staff/properties/OTA, 5000 WA msgs + Dynamic Pricing + API & Webhooks + White-label — badge *Best Value*).
- **Add-on catalog** (`AddonCatalog` table): 15 seeded add-ons in three categories — *Feature unlocks* (Restaurant POS, Night Audit, WhatsApp Automation Suite, Dynamic Pricing Engine, Advanced Reports, Excel Export, API & Webhooks, White-label, Priority Support), *Capacity packs* (Extra Rooms +10, Extra Staff Seats +5, WhatsApp Messages +500, Extra OTA Channel, Extra Property) and *Services* (Assisted Onboarding one-off). Each carries a `grants` JSON (feature flags / limit boosts / support tiers), plan availability, marketing badge and icon; capacity packs stack, feature unlocks are single-purchase.
- **Owner console → Add-ons Catalog** (new Revenue nav item): full CRUD with a live grants editor (per-feature toggles, limit boosts, support-tier picker), plan-applicability chips, badge/icon/price/sort controls, purchase counters and safe delete (deactivates when holders exist; hard delete only when never purchased). Every mutation is audit-logged and clears the entitlements cache.
- **Plan editor upgraded** (Subscriptions → Manage plans): tagline + marketing badge fields on create & edit, richer feature template (16 keys from the shared catalog), plan cards show badge & tagline.
- **Tenant Billing → My Subscription redesigned**: 4 plan cards with badges/taglines/premium feature highlights, "Compare all features" table (16 rows), add-ons grouped by category with "In your plan" / "Active" / "Add more" states, and owned-add-on chips on the current-plan card.
- `src/lib/feature-catalog.ts` — single source of truth for feature keys (16 features: 5 limits, 9 module flags, support & backup tiers) shared by the owner editors and the pricing UI; `AddonCatalog.grants` merged into effective entitlements between plan features and per-tenant overrides (legacy pre-catalog add-on rows keep working).
- `GET /api/subscription` now returns `catalog` + `ownedAddons`; `buy_addon` validates against the owner-managed catalog (plan applicability, duplicate protection, stackable quantity) and prices come server-side only.
- `POST/PATCH /api/owner/plans` accept `tagline`/`badge`; new `GET/POST /api/owner/addons` + `PATCH/DELETE /api/owner/addons/[id]` (requireOwner-guarded, audit-logged, input-validated).
- `Plan.tagline` / `Plan.badge` columns; manual migration SQL shipped at `prisma/manual-migrations/v2.1.0_subscription_redesign.sql` + `prisma/seed-live.ts` seeds the four plans & the catalog idempotently.

### Fixed — errors found in full-app QA
- **Tenant self-service actions were completely broken in production**: the subscription view POSTed to `GET`-only `/api/subscription` → 405 on every upgrade / downgrade / add-on purchase / pay-now. Actions now target `/api/subscription/actions`.
- **Radix Select crash**: badge pickers fed empty-string item values → client-side exception blew up the Add-ons editor and plan dialogs; empty badge now uses a `none` sentinel.
- **Add-on grants double-serialization**: the owner API re-serialized an already-JSON grants string, silently saving `{}` — grants never persisted from the editor; now normalized on both create and update.
- **Subscription view dead-ended on refresh**: the view refused to load without the in-memory JWT even though the HttpOnly session cookie was valid; Bearer header is now optional and cookie auth carries refreshes (pattern aligned with the rest of the app).

### Security review (this release)
- New owner routes are `requireOwner`-guarded with platform-role write-matrix support (`addons` added for platform_admin/platform_finance), CSRF-guarded, audit-logged, with key regex validation, price clamping, category whitelist and string-length caps.
- Add-on purchase pricing is resolved server-side from the catalog row (body price never trusted); plan applicability and duplicate/stack rules enforced server-side; `propertyId` always derived from the session (no IDOR surface).
- All DB access parameterized via Prisma; no raw SQL on user input; no secrets in client bundles.

---

## [2.2.0] — 2026-10-04 · WhatsApp Studio

### Added — WhatsApp tab upgrades (req ⑦ parity)
- **Template Studio**: tenants customize the copy of Booking Confirmation, Pre-arrival and Post-stay messages with placeholders (`{hotel}`, `{guest}`, `{confirmation}`, `{room}`, `{checkin}`, `{nights}`, `{amount}`), live preview on sample data, placeholder quick-chips and one-click "Reset to default". Stored per property (`WhatsAppConfig.templatesJson`, additive — default copy unchanged until customized).
- **Automation switches**: per-template auto-send toggles (`WhatsAppConfig.automationJson`) — pause/resume the automatic booking confirmation, the night-audit pre-arrival campaign and post-stay sends. Manual bulk triggers always remain available.
- **Enforced everywhere**: online bookings (`booking-guard`), the night-audit auto campaign (`source:"auto"` now skips when toggled off), manual bulk triggers and reservation-linked sends all render the customized copy (`buildTemplateBody`).
- New `GET/PATCH /api/whatsapp/templates` (PATCH is hotel_admin-only, validated ≤1000 chars, activity-logged).
- Message log: search box filtering phone / body / confirmation number; empty-search state.
- Header: "Manage connection" button jumps to Settings → WhatsApp API.
- Plan note: WhatsApp automation remains a Pro+ feature — Basic tenants see the existing upgrade dialog.

---

## [2.1.0] — 2026-10-04 · Always Live

### Fixed — realtime status stuck on "Polling"
- **Root cause**: the browser's socket.io client connected through the sandbox gateway (`/?XTransformPort=3003`), which does not route bare-`/` requests — the handshake got Next.js HTML back, so the realtime connection never established and the topbar permanently showed "Polling". Any deployment without that gateway had the same problem by design.

### Changed — in-app realtime (Server-Sent Events)
- New in-process event bus (`src/lib/event-bus.ts`) + `GET /api/realtime/stream` SSE endpoint: same-origin, authenticated by the existing session cookie/proxy, heartbeat every 25s, auto-reconnect. No extra port, no gateway dependency — works on every host the app runs on.
- `emitRealtime` (used by ~15 server call sites: POS/KOT, folio, night audit, activity log, channel sync) now publishes to the bus — call sites unchanged.
- Client (`src/lib/realtime.ts`) rewritten on `EventSource` with the identical public API (`connectRealtime`, `useRealtime`, `pingRealtime` via new `GET /api/realtime/ping`).
- `GET /api/health` no longer probes the external service — realtime is reported from the process itself.
- **Polling floor**: when push is unavailable, the shell refreshes notifications and the sync marker every 45s — "Polling" is now an honest, working fallback mode.
- The standalone realtime mini-service keeps running (dev-server keeper role) but is no longer on the critical path.

---

## [2.0.1] — 2026-10-04 · Polish Patch

### Changed
- Tenant sidebar/footer and platform-console footer: the version marker is now plain, non-interactive text (`Velurex HMS v2.0.1`) — the brass highlight pill and the clickable "What's new" dialog were removed per product decision. Release history remains documented here and in `src/lib/version.ts`; `GET /api/health` still reports `APP_VERSION`.

---

## [2.0.0] — 2026-10-04 · Growth Release

First feature drop under the version series — three major tenant capabilities plus platform polish.

### Added — Staff Management (Task 35-a)
- Staff directory with KPIs (headcount, monthly base-salary total) and per-staff profiles.
- **Attendance register**: per-day Present/Absent/Leave/Half-day marking, punch-in / punch-out, monthly attendance summary per staff member.
- **Payroll**: one-click "Generate drafts" for the month (prorated by attendance), review, "Mark paid" freezes the record (status, paid date, payment method) — full audit via activity log.

### Added — Menu images & Advanced Booking Engine (Task 35-b)
- Image upload infrastructure: `POST /api/uploads` (role-guarded, MIME + magic-byte validated, size-capped, stored as immutable public assets) and `GET /api/uploads/[id]`.
- Menu items accept photos — client-side canvas compression (512px, JPEG q0.82), thumbnail previews in add/manage/ordering grids.
- **Storefront tab**: stay policies (check-in/out times, minimum nights 1–30, cancellation policy), room-type photo galleries (up to 6 each), paid add-ons (upsells: flat / per-night / per-guest pricing, ordering, active toggle).
- Booking flow upgrades: photo galleries on room cards, policy chip strip, dedicated add-ons step with running total, min-nights enforcement in search/hold/book (422 with clear messaging), upsell-inclusive tax & grand totals, breakdown on confirmation.
- **Per-tenant hosted storefronts**: every property gets `GET /book?property=<id>`; availability dates header fix.

### Added — Revenue & Marketing (Task 35-c)
- Growth overview: KPIs (revenue, ADR, RevPAR, ARPU), revenue trend, 7-day weekday-moving-average forecast, booking funnel, guest segments, channel mix, marketing and payment summaries, period comparison.
- **Marketing Studio**: campaigns CRUD (linked promo codes, budget, audience), activate/pause, record results (reach, conversions, revenue, spend) with computed ROI and summary strip.
- Owner console analytics: MRR basis & trends, signups, GMV, top businesses, plan mix, retention.

---

## [1.1.0] — 2026-10-03 · Distribution Release

### Added — Channel management
- Normalized OTA connect with three link technologies: **API keys**, **OAuth 2.0** (scoped tokens: inventory.write / rates.write / bookings.read) and **iCal** (3-step connect → map → go-live wizard).
- Credentials encrypted at rest (AES-256-GCM `v1:iv:tag:cipher`), inbound booking webhooks, outbound iCal feed per property, channel room mapping and a full Sync Log audit trail.
- Plan-gated OTA slots with upgrade prompts.

---

## [1.0.0] — 2026-09-29 · First Light

### Added — Initial production release
- Hotel operations: property setup, room types & rooms, rate plans, reservations lifecycle, guest CRM, folio & billing with GST, payments, housekeeping, maintenance, POS with kitchen KOT, night audit with business-date roll, dynamic pricing, reports.
- Booking engine with promo codes and guard rails; channels groundwork; WhatsApp tab & config.
- SaaS platform: Plan / Subscription / add-ons / feature overrides, GST invoices (VXL-YYYY-XXXX), platform payments, coupons (incl. trial-extension), support tickets, announcements, onboarding checklists & leads, usage metrics, platform audit log.
- Auth & security: JWT httpOnly sessions, TOTP 2FA (RFC 6238, AES-256-GCM secrets, scrypt recovery codes), rate limiting, CSRF guard, CSP/HSTS headers, forced password reset for temp-password tenants (`Vlx@XXXXXXXX`).
