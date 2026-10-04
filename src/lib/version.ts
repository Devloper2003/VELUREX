/**
 * Velurex HMS — release versioning (single source of truth).
 *
 * Convention (SemVer MAJOR.MINOR.PATCH) — the release series is continuous:
 *  - MAJOR  big milestone / pricing or data-model migration / rebrand
 *  - MINOR  a feature drop shipped to production (new functionality)
 *  - PATCH  bug fixes & UI polish with no new features
 * Every change that lands on `main` MUST carry a version bump and a
 * CHANGELOG.md entry. Keep this file in sync with CHANGELOG.md — the
 * in-app "What's new" dialog renders straight from RELEASES.
 */

export const APP_NAME = "Velurex HMS";
export const APP_VERSION = "2.0.0";
export const APP_VERSION_TAG = `v${APP_VERSION}`;
export const APP_RELEASE_CODENAME = "Growth Release";
export const APP_RELEASE_DATE = "2026-10-04";

export type ReleaseNote = {
  version: string;
  date: string;
  codename: string;
  highlights: string[];
};

/** Newest first — every shipped release, one entry each. */
export const RELEASES: ReleaseNote[] = [
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
