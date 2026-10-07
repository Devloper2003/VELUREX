# Velurex HMS — Changelog

All notable changes to Velurex HMS are documented here, newest first.

## Versioning convention (release series)

- **SemVer** `MAJOR.MINOR.PATCH` — the series is continuous; every change that lands on `main` bumps the version and gets an entry.
- **MAJOR** — big milestone, pricing/data-model migration, or rebrand.
- **MINOR** — a feature drop: new functionality shipped to production.
- **PATCH** — bug fixes and UI polish with no new features.
- Single source of truth: `src/lib/version.ts` (`APP_VERSION` + `RELEASES`). In the product UI the version appears as plain text in the tenant sidebar/footer and platform-console footer, and `GET /api/health` reports it — keep this file in sync on every release.

---

## [2.8.1] — 2026-10-07 · Crisp Sheets

### Fixed — invoices now print perfectly
- **Rebuilt the entire print pipeline.** Every print button used to call `window.print()` on the app shell (or rely on a `visibility:hidden` + `position:fixed` hack that breaks inside dialogs — a transformed ancestor re-anchors the fixed sheet and the dialog's scroll clip truncates it), so printed invoices came out wrapped in navigation/sidebar chrome, on the dark theme, cut off mid-document, or spread over stray blank pages.
- **New hidden-iframe print pipeline** (`src/lib/print.ts`): each print button now hands a *complete standalone document* to the printer — identical to the Download HTML sheets — with `@page` margins, exact color printing and a proper document title for the print queue. Nothing from the app UI can leak onto paper, and nothing clips.
- **Print documents added for every surface**:
  - Folio tax invoice (Billing) and reservation invoice — reuse the shared `invoiceHtml` sheet (GSTIN, HSN/SAC, CGST/SGST breakup, amount in words, declaration, signature block).
  - Restaurant guest bill — reuse the shared `posBillHtml` sheet.
  - **KOT — new thermal-style print document** (`kotPrintHtml`) mirroring the on-screen receipt 1:1 (big order number, brass qty column, hanging notes, gross → discount → taxable → **CGST @ 2.5% → SGST @ 2.5%** → total), prints correctly on both 80mm rolls and A4.
  - **Day Sales Summary — new Z-report print document** (`daySummaryPrintHtml`) with the full CGST/SGST collection split and per-method collections.
  - Platform-owner SaaS invoices — new standalone print sheet with line items, GST and payment history.

### Verified
- agent-browser QA on all surfaces: folio invoice (INV-RG-1001 — TAX INVOICE, GSTIN, HSN 996311/996331/998613, amount in words), KOT (CGST @ 2.5% / SGST @ 2.5% / Total incl. GST), guest bill (RESTAURANT TAX INVOICE + signatory) and Z-report (CGST/SGST collected, collections by method) each produced a clean standalone print document with **zero app chrome** and correct GST figures. Zero console errors, zero 4xx/5xx after seed.

---

## [2.8.0] — 2026-10-06 · Official POS GST

### Added — the official way, in the POS
- **Official GST marking on every POS surface**: the cart totals, KOT receipts and the order-detail bill breakdown now render the exact same structure as the folio tax invoice — gross amount → discount → **taxable value → CGST @ 2.5% → SGST @ 2.5%** → grand total. Labels adapt automatically if an admin ever overrides a dish's slab.
- **Guest Bill (restaurant tax invoice)**: a new receipt-icon action on every order row (and in the order detail sheet) opens a full official tax invoice — property masthead with **GSTIN**, **Place of Supply**, numbered item table with rate & amount, CGST/SGST rate breakup, **amount in words**, payment status (DUE / method / Room Folio), declaration and authorised signatory — with **Print** and **one-click HTML download** in the same visual language as the folio invoices.
- **Order-level discounts**: apply **% off or flat ₹** per order, before GST — tax is charged on the *discounted* taxable value (CGST §15, mirroring the promo handling on folio invoices). The math lives in one shared engine (`pos-gst.ts`) used by both the API (authoritative) and the cart (live preview), clamped server-side so no discount can exceed the bill.
- **Day Sales Summary (Z-report)**: a printable today-so-far report with order count, gross, discounts, taxable value, **CGST/SGST collected**, net sales, collections grouped by payment method (cash / UPI / card / gateways / room folio) and an unpaid-orders warning.
- **Reorder**: one tap pulls any of today's orders back into the cart — sold-out or removed dishes are skipped and reported in the toast.
- Menu composer: GST field defaults to the flat **5%** slab with a "CGST 2.5% + SGST 2.5%" hint (removes the old bar-at-12% leftover), and the property's **state** now flows into the bill's Place of Supply via Settings.

### Verified
- End-to-end QA: 10% discount on ₹740 → taxable ₹666 → CGST ₹16.65 + SGST ₹16.65 → total ₹699.30, identical in cart preview, API, KOT receipt and guest bill; flat discount clamps at the bill total; settle uses the discounted grand total. Zero console errors, zero 5xx.

---

## [2.7.0] — 2026-10-06 · Flat Five & Instant Payroll

### Changed — Flat 5% GST across the property
- **One slab for everything**: room, F&B, bar, laundry, misc and no-show charges now all bill at **5% GST — CGST 2.5% + SGST 2.5%** (previously rooms & bar billed at 12%, laundry & misc at 18%). Reservation invoices, folio bills, group consolidated bills and POS orders all compute from the same table, so the taxable value, CGST/SGST amounts, grand total and amount-in-words now line up everywhere.
- Menu items default to 5% GST for new dishes (the per-dish override stays available to admins), and the POS order tax math uses the same flat rate.
- No stored data was rewritten: GST is computed at billing time from the category table, so the change applies cleanly to existing and future folios without touching guest records.

### Added — Instant staff ⇆ payroll sync
- **Payroll follows the directory in real time**: creating a staff member now creates their current-month payroll draft in the same breath — the register shows them the moment you open it, no "Generate drafts" needed. The payroll read also self-heals: any active staff member missing from the register gets a draft on view.
- **HR profile at add time**: the Add-Staff dialog gains Designation, Department, Monthly salary and Join date fields (all optional), so payroll drafts are born with a real salary instead of zero.
- **Salary edits flow through**: changing salary in the HR directory refreshes the current-cycle payroll draft (net pay recomputed with manual allowances / bonus / advance preserved); processed and paid cycles stay frozen.

---

## [2.6.0] — 2026-10-06 · Golden Ticket

### Added — Invoice & details on every reservation
- **Actions menu on every reservation row**: the Reservations desk now gives each booking a row-level actions menu (⋯) — "Invoice & Details" opens the complete white-labeled GST tax invoice for that reservation, available for open *and* checked-out bookings, so the front desk can pull up (or re-issue) any guest invoice in two clicks.
- The invoice sheet shows the full stay summary alongside the statutory format: numbered line items (Qty, Rate, Taxable, GST%), CGST/SGST split, Place of Supply, payments recorded, amount in words, declaration and Authorised Signatory — with **Download** (standalone styled HTML, named by invoice number) and **Print** (print-isolated so only the invoice leaves the printer).

### Changed — One shared invoice format
- **New shared invoice primitives** (`src/lib/invoice-format.ts` + `src/components/shared/InvoiceDoc.tsx`): the payload types, money formatting, invoice notes (promo discounts, early-departure credits, departure postings) and the standalone HTML document builder now live in one place.
- **Billing & Folio refactored onto it** — folio bills, group bills and reservation invoices all render the identical white-labeled format from the same code path; formatting drift between surfaces is now impossible by construction.

### Changed — Refined kitchen tickets (KOT)
- **One shared receipt component** (`KotReceipt`): the "order sent" dialog and the order detail sheet print from the exact same redesigned ticket — property masthead in the display face with a brass rule, "KITCHEN ORDER TICKET" eyebrow, giant order number, a where/when strip (time · table/room/takeaway), items with a brass quantity column and hanging cooking notes, and a subtotal · GST · TOTAL (incl. GST) footer. No platform branding anywhere.
- **Richer WhatsApp broadcasts** (`kot-broadcast.ts`): ticket images gain a taller pine header with a brass underline rule, an "ITEMS · N" counter, brass quantity figures and an itemised Subtotal / GST / TOTAL block; plain-text broadcasts now carry the same Subtotal + GST breakdown lines before the total.

---

## [2.5.0] — 2026-10-05 · White Label

### Added — Payment Gateways (platform owner → tenants)
- **New owner-console module — Revenue → Payment Gateways**: the software owner can now assign online payment providers to any tenant business. Supported providers: Razorpay, Cashfree, PayU, Paytm, PhonePe, Stripe, UPI QR (manual) and bank transfer, plus a Custom option.
- **Per-gateway configuration**: display label, test/live mode, merchant/key ID, key secret (encrypted at rest with AES-256-GCM, never returned by any API, never shown to the tenant), enable/disable switch, a per-property default, and platform-side notes. Secrets cannot be stored on demo tenants; one default gateway per property is enforced server-side.
- **Tenant side**: the assigned gateways appear read-only on Settings → Property ("Online Payments" card), and usable at the point of payment — the POS settle dialog gains "Pay via <gateway>" buttons and the folio/group payment dialogs gain an "Online gateway" section in the method selector.
- **Server-side method validation**: `/api/payments` and the POS settle endpoint accept any method matching an *enabled* gateway of the property (e.g. `razorpay`), so a tenant can only pay through gateways the owner actually assigned.
- New `PaymentGateway` Prisma model (`prisma/manual-migrations/v2.5.0_payment_gateways.sql` carries the idempotent PostgreSQL migration for production; local SQLite was pushed with `db:push`).

### Added — Openable orders in the POS
- **Tap any order to open its details**: the Today's Orders table is now fully openable (click the row or the eye button) — a detail sheet shows every item with its live kitchen status, cooking notes, the bill breakdown (subtotal, GST, total) and payment info.
- **KOT updates from the POS terminal**: the separate `KOT Display` tab is gone. Item statuses (Pending → Preparing → Ready → Served) are driven directly from the order detail sheet — tap a status chip to advance, plus All-ready, Mark-served and Print-KOT (reprint) actions. The Kitchen Display under PMS keeps the same powers for the kitchen.
- **Live progress on the rows**: each order row now carries a `2/3 ready` chip (amber while cooking, green when plated) so the kitchen queue reads at a glance without any extra tab.

### Changed — White-labeled documents
- **KOT is now fully the hotel's**: the printed kitchen ticket header shows the property's own name instead of the platform name, and the "Sent via Velurex HMS" signature was removed from KOT printouts, WhatsApp text messages and the ticket image (image height tightened accordingly).
- **GST tax invoice format upgraded** (screen, print and HTML download): numbered line items with Qty and Rate columns, a CGST/SGST split GST summary, Place of Supply, Amount in words (Indian numbering), a legal declaration line and an Authorised Signatory block — every line branded to the tenant hotel, zero platform branding. The consolidated group invoice also gained amount-in-words and the signature block.

### Notes
- No breaking changes; the invoice payload gained `hotel.state`/`hotel.email` (additive). Existing orders, folios, invoices and payments are untouched.

---

## [2.4.0] — 2026-10-05 · Kitchen Wire

### Added — KOT WhatsApp broadcast (F&B / POS → Settings → WhatsApp API → Step 4)
- **KOTs now reach WhatsApp automatically**: the moment an order is sent to the kitchen, the full ticket — items, quantities, cooking notes and GST total — is broadcast to the property owner(s) and a tenant-managed group list. Owner numbers are picked up automatically from active admin accounts (deduplicated); the group list holds up to 12 numbers configured per tenant.
- **Branded ticket images**: the KOT is rendered server-side as a pine-and-brass receipt image (hotel name header, KOT number, table/room strip, monospace item lines with amber note lines, GST total footer) via SVG → PNG, sent with a one-line caption. If image delivery fails, the plain-text version is sent instead; a "Text only" format switch is available.
- **KOT broadcast settings card**: on/off toggle, image/text format selector, group-number editor (one per line) with counts, and a live text-message preview. Every send is logged in the WhatsApp message log (`kot_broadcast`, per-number delivery status; "Simulated" until Cloud API credentials are live).
- **Zero-schema-change config**: broadcast settings ride inside the existing WhatsApp config JSON alongside the template switches — nothing to migrate, existing tenants default to enabled/image and can switch off any time. Recipients are hard-capped at 10 per ticket; a KOT is not a marketing channel.

### Added — KOT Display tab inside the POS
- **Live kitchen queue in the POS**: a new `Ordering | KOT Display` segmented control at the top of the POS; the KOT Display shows pending kitchen tickets as receipt-style cards (order number, table/room badge, elapsed minutes with late-ticket amber highlight, item lines with notes).
- **Item-level progression from the POS**: status chips on every item (Pending → Preparing → Ready → Served) tap to advance — the same API and realtime feed as the Kitchen Display — plus All-ready and Served actions per ticket, a live pending count badge on the tab, 15s auto-refresh and instant SSE updates.

### Changed — POS terminal layout
- **Fixed-height menu panel**: the dish grid now scrolls inside its own panel (slim brass scrollbar, category tabs and search pinned) instead of stretching the page — the POS behaves like a terminal on desktop while mobile keeps a capped 62vh scroller.
- **Bounded cart**: long orders scroll internally (max 300px) so Totals and Send to Kitchen stay reachable.

### Security & data
- Broadcast sends are strictly best-effort and never block or fail order creation; recipients resolve server-side (owner accounts + tenant config — never client-supplied); phone-shape validation on save; every send is audit-logged per number. No data hard-coded in source, no schema changes, no existing data touched.

---


## [2.3.2] — 2026-10-05 · Menu Craft

### Changed — Menu management redesigned (F&B / POS → Manage)
- **Two-pane manager replaces the scroll list**: a course rail (All · Starter · Main · Dessert · Beverage · Bar) with live dish counts and a live/sold-out summary sits beside a detail pane — jump straight to a course instead of scrolling one mixed list. On mobile the rail becomes horizontally scrollable chips.
- **Wider dialog, pinned chrome**: `sm:max-w-3xl` with the header and summary footer always visible and a single clean scroll area (rail stays sticky while the pane scrolls).
- **Item rows rebuilt**: photo thumb, veg dot, full-width dish names (no more truncation), category chip, ₹-prefixed price field, availability switch with sold-out badge + dimmed row, and admin-only delete — all in one card row with hover feedback.
- **Inline rename**: click any dish name (pencil affordance on hover) to rename in place — Enter saves, Esc cancels; saved via the existing role-guarded `PATCH /api/menu/[id]`.
- **Collapsible composer**: the "+ New dish" form now collapses to a button, auto-opens on an empty menu, labels every field (dish name, course, price with ₹ prefix, GST with % suffix, Veg/Non-veg segmented control, description, photo) and auto-jumps the rail to the course you just added. Enter submits from any field.

### Fixed
- Mobile (≤390px) horizontal overflow: the manager dialog could exceed the viewport and clip row controls (flex `min-width:auto` on the scroll container + grid min-content widths) — fixed with `min-w-0` containment and a wrapping photo/add row. Nothing overflows now.

### Security & data
- Pure UI reorganization: zero API changes (existing auth-guarded, property-scoped menu endpoints only), zero DB writes beyond the usual item edits, no data in source code, no existing data touched.

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
