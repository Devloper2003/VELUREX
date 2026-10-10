/**
 * Velurex HMS — release versioning (single source of truth).
 *
 * Convention (SemVer MAJOR.MINOR.PATCH) — the release series is continuous:
 *  - MAJOR  big milestone / pricing or data-model migration / rebrand
 *  - MINOR  a feature drop shipped to production (new functionality)
 *  - PATCH  bug fixes & UI polish with no new features
 * Every change that lands on `main` MUST carry a version bump and a
 * CHANGELOG.md entry. Keep this file in sync with CHANGELOG.md — that file is
 * the human-readable record; RELEASES below is the machine-readable mirror.
 */

export const APP_NAME = "Velurex HMS";
export const APP_VERSION = "2.10.0";
export const APP_VERSION_TAG = `v${APP_VERSION}`;
export const APP_RELEASE_CODENAME = "Clean Slate";
export const APP_RELEASE_DATE = "2026-10-10";

export type ReleaseNote = {
  version: string;
  date: string;
  codename: string;
  highlights: string[];
};

/** Newest first — every shipped release, one entry each. */
export const RELEASES: ReleaseNote[] = [
  {
    version: "2.10.0",
    date: "2026-10-10",
    codename: "Clean Slate",
    highlights: [
      "Fixed: online payments could never open their window — \"Could not load the payment window\" on every Razorpay charge. The app's Content-Security-Policy blocked Razorpay's checkout script, its payment-modal iframe and its API endpoints; the policy now allows exactly the Razorpay origins needed (checkout script, api.razorpay.com/checkout.razorpay.com frames, telemetry, badge images) while everything else stays blocked",
      "Delete for reservations — hotel admins now get a delete (trash) icon on completed reservation rows (checked-out / cancelled / no-show) next to Invoice, with a red confirm dialog that spells out exactly what is removed. The server enforces the same rules: admin-only, terminal stays only, folio charges and payments removed in one transaction, POS orders and WhatsApp history kept and merely detached; every deletion is audit-logged",
      "Checkout script loader hardened — loaded exactly once (no duplicate script tags on parallel opens), one automatic retry on a transient network blip, and if it still fails the message now explains the actual remedies (internet, ad-blocker, app version) and reassures that the order is safe and no money moved",
    ],
  },
  {
    version: "2.9.3",
    date: "2026-10-08",
    codename: "Steady Hand",
    highlights: [
      "Fixed: gateway Test connection failing with \"Razorpay responded with HTTP 429\" — Razorpay rate-limits keys that get too many requests in a short window (e.g. repeated test clicks); the server now transparently retries a 429 with capped backoff (honouring Retry-After) before giving up, and the failure message explains exactly what to do — wait a minute and test again, the saved keys are not the problem",
      "Test-connection button now cools down for 20s after every attempt (Retry in Ns countdown) so rapid clicks can no longer trip the gateway's rate limiter",
      "Razorpay order creation and hosted payment-link creation got the same 429 retry + a clear \"Razorpay is busy (rate limit) — wait about a minute\" message instead of a bare HTTP error",
    ],
  },
  {
    version: "2.9.2",
    date: "2026-10-08",
    codename: "Plug Proof",
    highlights: [
      "Fixed: \"Test connection\" on a linked gateway returned \"Request failed (404)\" — the dedicated test endpoint was missing from the v2.9.0 release even though the button shipped; POST /api/settings/payment-gateways/[id]/test-connection now exists and performs the real authenticated round-trip (Razorpay orders API / Stripe balance API) from the server",
      "The result now surfaces precisely: Razorpay/Stripe credential rejections (401), other HTTP errors and network failures each get their own actionable message — inline on the gateway card and as a toast — so a tenant always knows whether the keys, the mode or the network is at fault",
      "Every test attempt is audited (GATEWAY_TEST_OK / GATEWAY_TEST_FAILED) with the provider, mode and outcome",
    ],
  },
  {
    version: "2.9.1",
    date: "2026-10-08",
    codename: "Settle Sure",
    highlights: [
      "Fixed: production 500 on every payment (POS settle cash/UPI/card, folio payments, booking payments) — the v2.9.0 gateway columns were missing on the production database; the additive migration has been applied and payments work again",
      "Payment routes hardened — every money-path API (POS settle, post-to-folio, folio charges, gateway checkout/verify, booking payment-intent, group payments) now returns precise, actionable JSON errors instead of an opaque \"Request failed (500)\", including a dedicated \"schema out of sync\" message if a deployment ever runs ahead of its database again",
      "Settle dialog double-pay guard — payment buttons disable with a Paying… spinner while the charge is in flight, so a double-click can never fire two payments",
    ],
  },
  {
    version: "2.9.0",
    date: "2026-10-07",
    codename: "Own Rails",
    highlights: [
      "Tenants can now link THEIR OWN payment gateway (Razorpay, Stripe, Cashfree, PayU, Paytm, PhonePe + manual UPI/bank methods) from Settings → Payments — guest payments are charged through the tenant's account and settle into the tenant's bank",
      "Real gateway collection: POS settle, folio payments and the public booking widget create orders at the tenant's gateway with encrypted-at-rest keys (AES-256-GCM), open Razorpay's hosted checkout and verify signatures server-side before applying",
      "Hosted payment links + per-gateway webhook endpoint (signature-verified) so payments taken on Razorpay pages/mark links auto-settle the folio; sandbox simulation keeps the whole flow demoable without live keys",
    ],
  },
  {
    version: "2.8.1",
    date: "2026-10-07",
    codename: "Crisp Sheets",
    highlights: [
      "Print pipeline rebuilt — every print button (folio invoice, reservation invoice, POS guest bill, KOT, Z-report, platform invoice) now prints a pixel-perfect standalone sheet through a hidden iframe: no app chrome, no dark theme, no dialog clipping, no stray blank pages",
      "Thermal-ready KOT & Z-report print documents added, mirroring the on-screen receipts 1:1 including CGST @ 2.5% / SGST @ 2.5% labels",
      "Platform-owner SaaS invoices gained a matching print document with payments and GST breakdown",
    ],
  },
  {
    version: "2.8.0",
    date: "2026-10-06",
    codename: "Official POS GST",
    highlights: [
      "Official GST marking in the POS — the cart, KOT receipts and order details now break every bill down exactly like the folio tax invoice: gross amount → discount → taxable value → CGST @ 2.5% → SGST @ 2.5% → grand total",
      "Guest Bill — a proper restaurant tax invoice on every order (the receipt-icon button): property masthead with GSTIN, Place of Supply, item table, CGST/SGST rate breakup, amount in words, payment status, declaration and authorised signatory — print or one-click HTML download",
      "Order-level discounts — % or flat ₹, applied before GST (CGST §15): tax is charged on the discounted taxable value, with the same math enforced server-side and previewed live in the cart",
      "Day Sales Summary (Z-report) — today's orders with gross, discounts, taxable value, CGST/SGST collected, net sales, collections by payment method and an unpaid-orders flag, ready to print",
      "Reorder — pull any of today's orders back into the cart in one tap (sold-out items are skipped and reported)",
      "Menu composer flattened to the 5% slab with a CGST 2.5% + SGST 2.5% hint, and the property's state now feeds the bill's Place of Supply",
    ],
  },
  {
    version: "2.7.0",
    date: "2026-10-06",
    codename: "Flat Five & Instant Payroll",
    highlights: [
      "Flat 5% GST — every guest-facing charge (room, F&B, bar, laundry, misc, no-show) now bills at a single 5% slab: CGST 2.5% + SGST 2.5% on invoices, folio bills, group bills and POS orders alike, with taxable value, tax amount and grand total recalculated to match",
      "Instant payroll sync — adding a staff member now creates their current-month payroll draft immediately (with designation, department, salary and join date captured right in the Add-Staff dialog), so the payroll register always shows the full team the moment you open it",
      "Salary edits flow through — changing a staff member's salary in the directory refreshes their payroll draft (net pay recomputed, manual allowances/bonus/advance preserved) without needing a regenerate",
      "Menu GST default flattened to 5% for new dishes and existing demo data; admins can still override per dish",
    ],
  },
  {
    version: "2.6.0",
    date: "2026-10-06",
    codename: "Golden Ticket",
    highlights: [
      "Invoice & details on every reservation — each row in the Reservations desk now carries an actions menu; “Invoice & Details” opens the full white-labeled GST tax invoice for any booking (open or checked-out) with in-app view, print and one-click HTML download",
      "One shared invoice format — a new shared invoice document (InvoiceDoc + invoice-format) now powers folio bills, group bills and reservation invoices alike, so every surface renders the identical white-labeled GST format: numbered line items, CGST/SGST summary, amount in words, declaration and authorised signatory",
      "Refined kitchen tickets — the KOT receipt is redesigned around one shared component used by both the “order sent” dialog and the order detail sheet: property masthead with a brass rule, giant order number, where/when strip, a brass quantity column with hanging cooking notes and a subtotal · GST · total footer",
      "Richer KOT WhatsApp broadcasts — ticket images gain a brass underline rule, an “ITEMS · N” counter, brass quantity figures and an itemised Subtotal / GST / TOTAL block; text broadcasts now carry the same subtotal + GST breakdown",
    ],
  },
  {
    version: "2.5.0",
    date: "2026-10-05",
    codename: "White Label",
    highlights: [
      "Openable orders — tap any order in the POS (order number or the eye button) to see full details: every item with its live kitchen status, notes, bill breakdown and payment info",
      "KOT updates from the POS terminal — the separate KOT Display tab is gone; item statuses (pending → preparing → ready → served) are now driven from the order detail sheet, plus All-ready / Mark-served / Print-KOT actions",
      "Order rows now show a live kitchen progress chip (2/3 ready) so the queue reads at a glance",
      "White-labeled KOT — kitchen tickets print and WhatsApp under the hotel's own name; the platform signature was removed from ticket prints and broadcasts",
      "White-labeled GST tax invoice — richer format with numbered line items (Qty, Rate, Taxable, GST%), CGST/SGST split summary, Place of Supply, amount in words, declaration and an Authorised Signatory block, in-app, in print and in the download",
      "Payment Gateways — new platform-owner console module: assign Razorpay, Cashfree, PayU, Paytm, PhonePe, Stripe, UPI-QR or bank transfer to any business with test/live mode, encrypted secrets and a default gateway",
      "Tenants see their assigned gateway on Settings → Property and can settle orders / record folio payments via it; gateway methods validate server-side against the property's enabled gateways",
    ],
  },
  {
    version: "2.4.0",
    date: "2026-10-05",
    codename: "Kitchen Wire",
    highlights: [
      "KOT Display inside the POS — a new tab shows the live kitchen queue as receipt-style tickets with item-level status chips (tap to advance), All-ready / Served actions, late-ticket highlighting and realtime updates, sharing the exact feed as the Kitchen Display",
      "KOT WhatsApp broadcast — the moment an order is sent to the kitchen, the full ticket (items, notes, total) is WhatsApped to the property owner(s) and a tenant-managed group list",
      "Branded ticket images — KOTs are rendered as a pine-and-brass receipt image (item lines, cooking notes, GST total) with a text caption; plain-text format is a one-click switch and the automatic fallback",
      "KOT broadcast settings — Settings → WhatsApp API gains a step-4 card: on/off switch, image/text format, up to 12 group numbers, live message preview; owner numbers are picked up automatically from admin accounts",
      "POS menu becomes a true terminal — the dish grid now scrolls inside a fixed-height panel (slim brass scrollbar) so Search, categories and the cart stay put; long carts scroll internally while Totals + Send stay on screen",
    ],
  },
  {
    version: "2.3.2",
    date: "2026-10-05",
    codename: "Menu Craft",
    highlights: [
      "Menu management redesigned as a two-pane manager — a course rail with live dish counts replaces the cramped endless-scroll list; jump straight to Starters, Mains, Desserts, Beverages or Bar",
      "Inline dish rename (click any name), ₹-prefixed price editing, clearer live/sold-out states and a live · total · sold-out summary bar",
      "Collapsible “+ New dish” composer with properly labeled fields (name, course, price, GST %, food type, description, photo) — auto-opens on an empty menu and jumps the rail to the course you just added",
      "Fully responsive: course rail becomes scrollable chips on mobile, header/footer stay pinned, nothing overflows",
    ],
  },
  {
    version: "2.3.1",
    date: "2026-10-05",
    codename: "Resilience Patch",
    highlights: [
      "Fixed: production 500s on Channels & OTAs, My Subscription and the owner console when the database has not received the v2.3.0 migration yet — every plan/add-on read now degrades gracefully and self-heals once the migration is applied",
      "Fixed: API errors could return non-JSON bodies (\"Unexpected end of JSON input\") — add-on marketplace and self-service actions now return clear JSON messages instead of crashing",
      "Zero data touched: the fix is read/write resilient on both pre- and post-v2.3.0 schemas; no existing plans, subscriptions, invoices or add-on purchases are modified",
    ],
  },
  {
    version: "2.3.0",
    date: "2026-10-05",
    codename: "Pricing Studio",
    highlights: [
      "Four-tier subscription model — Starter ₹1,999 · Basic ₹4,999 · Pro ₹9,999 · Enterprise ₹19,999 with a full feature comparison table",
      "Add-ons marketplace — 15 owner-managed add-ons (feature unlocks, capacity packs, services) with highlight badges like Best Seller & Revenue Booster",
      "Owner console: Add-ons Catalog view — create/edit/deactivate add-ons, set what they grant, pricing, plan availability and badges; changes apply live to every subscriber",
      "Plan editor upgraded — tagline, marketing badge and the full feature matrix now editable from Subscriptions → Manage plans",
      "Fixed: tenant self-service actions (upgrade / downgrade / buy add-on / pay now) returned 405 and never worked — now fully functional with prorated invoices",
      "Fixed: add-on purchases and entitlement caps now apply instantly (rooms 10 → 20 after one pack in QA)",
    ],
  },
  {
    version: "2.2.0",
    date: "2026-10-04",
    codename: "WhatsApp Studio",
    highlights: [
      "Template Studio — customize the copy of all three lifecycle messages with {guest}/{hotel}/{confirmation}… placeholders, live preview and one-click reset",
      "Automation switches — pause/resume automatic sending per template (booking confirmation, pre-arrival at night audit, post-stay); manual bulk sends always available",
      "Custom copy is honoured everywhere: online bookings, night-audit campaigns, manual bulk triggers and reservation-linked sends",
      "Message log search (phone / text / confirmation) and a direct 'Manage connection' link into Settings → WhatsApp API",
    ],
  },
  {
    version: "2.1.0",
    date: "2026-10-04",
    codename: "Always Live",
    highlights: [
      "In-app realtime via Server-Sent Events — fixes the stuck 'Polling' status; dashboards now connect 'Live' on every host, including the live deployment",
      "Guaranteed polling floor: if push is ever unavailable, notifications and the sync marker still refresh every 45s",
    ],
  },
  {
    version: "2.0.1",
    date: "2026-10-04",
    codename: "Polish Patch",
    highlights: [
      "Tenant sidebar & platform-console footers: version is now plain, non-interactive text — no highlight pill, no click target",
    ],
  },
  {
    version: "2.0.0",
    date: "2026-10-04",
    codename: "Growth Release",
    highlights: [
      "Staff Management — attendance register (punch in/out, per-day marking) and full payroll (generate drafts, review, mark paid)",
      "Menu photo uploads — compress, attach and manage food photos across POS ordering & manage panels",
      "Advanced Booking Engine — storefront policies, room photo galleries, paid add-ons (upsells) with correct tax math, minimum-nights guard",
      "Per-tenant hosted storefronts — every property gets a shareable /book?property=<id> page",
      "Growth & Revenue suite — ADR/RevPAR/ARPU analytics, 7-day demand forecast, funnel, channel mix and Marketing Studio campaigns with ROI tracking",
    ],
  },
  {
    version: "1.1.0",
    date: "2026-10-03",
    codename: "Distribution Release",
    highlights: [
      "OTA connect with three link methods — API keys, OAuth 2.0 and iCal sync (3-step wizard)",
      "Credentials encrypted at rest (AES-256-GCM), inbound webhooks, outbound iCal feeds and a full sync-log audit trail",
    ],
  },
  {
    version: "1.0.0",
    date: "2026-09-29",
    codename: "First Light",
    highlights: [
      "Full hotel operations suite — PMS, reservations, folio & billing, housekeeping, POS, night audit",
      "SaaS platform layer — plans, subscriptions, GST invoicing, coupons, support tickets, announcements",
      "Security hardening — TOTP 2FA, rate limits, CSRF guard, JWT sessions, AES-256-GCM secrets at rest",
    ],
  },
];
