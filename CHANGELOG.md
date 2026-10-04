# Velurex HMS — Changelog

All notable changes to Velurex HMS are documented here, newest first.

## Versioning convention (release series)

- **SemVer** `MAJOR.MINOR.PATCH` — the series is continuous; every change that lands on `main` bumps the version and gets an entry.
- **MAJOR** — big milestone, pricing/data-model migration, or rebrand.
- **MINOR** — a feature drop: new functionality shipped to production.
- **PATCH** — bug fixes and UI polish with no new features.
- Single source of truth: `src/lib/version.ts` (`APP_VERSION` + `RELEASES`). In the product UI the version appears as plain text in the tenant sidebar/footer and platform-console footer, and `GET /api/health` reports it — keep this file in sync on every release.

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
