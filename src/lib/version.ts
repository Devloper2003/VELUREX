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
export const APP_VERSION = "2.1.0";
export const APP_VERSION_TAG = `v${APP_VERSION}`;
export const APP_RELEASE_CODENAME = "Always Live";
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
