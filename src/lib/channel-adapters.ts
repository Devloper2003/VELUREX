/**
 * Channel adapters — the seam between Velurex inventory and every distribution
 * channel. Each channel implements `ChannelAdapter`; the worker calls adapters
 * and never talks to an OTA directly. Real OTA API clients (Booking.com XML,
 * Expedia Rapid, MMT/Goibibo partner APIs, Yatra, Agoda, EasyMyTrip, Cleartrip,
 * Airbnb, OYO…) can replace the mock implementations one-for-one without
 * touching the UI, queue, or logs.
 *
 * NORMALIZED CONNECT CONTRACT (Task 34):
 * `CHANNEL_DEFS` is the single source of truth for everything the UI and API
 * need to onboard a tenant onto a channel — credential field specs (with
 * per-field help, formats and secrets), the channel's room-type catalog for
 * mapping, its partner portal URL and a merchandising category. Both the
 * server (`/api/channels`) and the client (`ChannelsView`) validate against
 * the same `validateCredentialFields` helper, so field-level errors can never
 * drift between the two.
 */

export type ChannelKey =
  | "booking_com"
  | "expedia"
  | "mmt"
  | "goibibo"
  | "yatra"
  | "agoda"
  | "easemytrip"
  | "cleartrip"
  | "airbnb"
  | "oyo"
  | "own_website";

export interface ChannelPushPayload {
  action: "open" | "close" | "rate_update" | "full_sync";
  dateISO: string; // "2026-09-26"
  roomTypeId: string; // internal id
  externalRoomTypeId: string; // OTA-side id from the mapping
  availableCount: number;
  isOpen: boolean;
  rate: number | null;
  credentials: Record<string, string>;
  /** 1-based attempt number — lets mocks simulate transient failures that recover. */
  attempt?: number;
}

export interface ChannelPushResult {
  ok: boolean;
  message: string;
  externalRef?: string;
}

export interface ChannelAdapter {
  readonly channel: ChannelKey;
  /** Validate credentials at connect time (method-aware: api_keys | oauth2 | ical). */
  testConnection(credentials: Record<string, string>, method?: LinkMethod): Promise<ChannelPushResult>;
  /** Push availability / open-close (and rate when present) for one room-type-date. */
  pushInventory(p: ChannelPushPayload): Promise<ChannelPushResult>;
}

/* ─── Credential field spec (normalized connect form) ────────────────────── */

export interface CredentialFieldSpec {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
  /** One-line "where to find it" guidance shown under the input. */
  help?: string;
  /** Secrets render as password inputs with their own show/hide toggle. */
  secret?: boolean;
  /** Mobile keyboard hint — "numeric" for pure-digit property ids. */
  inputMode?: "text" | "numeric";
  /** Minimum accepted length (sandbox handshake validates shape, not truth). */
  minLength?: number;
  /** Only digits allowed (Booking.com / Expedia / Agoda property ids). */
  numeric?: boolean;
  /** Optional regex the value must satisfy; paired human-readable hint. */
  pattern?: string;
  patternHint?: string;
}

export type ChannelCategory = "global" | "india" | "direct";

/* ─── Multi-method link technology (Task 35 — the way real OTAs connect) ──── */

/**
 * The three link technologies OTAs actually offer today:
 *  - api_keys — direct XML/REST push with property id + partner key (classic).
 *  - oauth2   — the new standard (Booking.com Connectivity, Airbnb): the tenant
 *               registers a client app and Velurex exchanges Client ID + Secret
 *               for a short-lived, SCOPED access token. No raw key on the wire.
 *  - ical     — universal calendar URLs supported by EVERY extranet (including
 *               MakeMyTrip EasyXcelerate and Airbnb hosting) with zero partner
 *               approval — the fastest path for independent hotels.
 * Webhooks ride on top of any method: after connecting, the tenant gets a
 * push URL (`/api/channels/webhook/{linkToken}`) OTAs can deliver booking
 * events to, shown in the Link URLs dialog.
 */
export type LinkMethod = "api_keys" | "oauth2" | "ical";

export interface LinkMethodDef {
  method: LinkMethod;
  /** Segmented-pill label. */
  label: string;
  /** Small badge on the pill — merchandises the recommended/default path. */
  badge?: string;
  /** One-liner shown under the pill row explaining this technology. */
  blurb: string;
  /** Credential fields collected for THIS method (validated client+server). */
  fields: CredentialFieldSpec[];
  /** Guided how-to steps (ical). */
  steps?: string[];
  /** OAuth scope chips (oauth2). */
  scopes?: string[];
  /** Extra reassurance line under OAuth fields (oauth2). */
  oauthNote?: string;
}

/** The universal iCal method — same shape for every channel, tailored copy. */
function icalMethod(channelName: string): LinkMethodDef {
  return {
    method: "ical",
    label: "iCal Sync",
    badge: "No approval needed",
    blurb: `Link ${channelName} with calendar URLs — supported by every extranet, works in minutes, no partner API approval required.`,
    fields: [
      {
        key: "icalImportUrl", label: `${channelName} calendar URL (their export)`,
        placeholder: "https://…/{channel}-calendar.ics",
        required: true, minLength: 12,
        pattern: "^https?://\\S+\\.(ics|ical)(\\?\\S*)?$|^https?://\\S+\\?(\\S*&)?[a-z_]*ical[a-z_]*=|^https?://\\S+$",
        patternHint: "Paste the full calendar URL from the extranet (starts with https).",
        help: `Extranet → Calendar → iCal / Calendar sync → copy the EXPORT URL.`,
      },
    ],
    steps: [
      `Open the ${channelName} extranet → Calendar (or Rate plans) and find "iCal" / "Calendar sync".`,
      `Copy ${channelName}'s calendar EXPORT URL and paste it below — Velurex imports their bookings automatically.`,
      `After connecting, copy YOUR Velurex calendar URL from "Link URLs" on the channel card and paste it into ${channelName}'s IMPORT field.`,
    ],
  };
}

/** The OAuth 2.0 method — scoped token handshake, tailored copy. */
function oauthMethod(channelName: string, scopes: string[]): LinkMethodDef {
  return {
    method: "oauth2",
    label: "OAuth 2.0",
    badge: "New standard",
    blurb: `Modern token handshake — ${channelName} issues a short-lived, scoped access token instead of a permanent key on every request.`,
    fields: [
      {
        key: "clientId", label: "Client ID (app id)", placeholder: "Paste the client ID",
        required: true, minLength: 6,
        help: `Partner portal → Connected apps / API clients → your app's Client ID.`,
      },
      {
        key: "clientSecret", label: "Client Secret", placeholder: "Paste the client secret",
        required: true, secret: true, minLength: 8,
        help: "Shown once when the app was created — regenerate from the same page if lost.",
      },
    ],
    scopes,
    oauthNote: "Velurex exchanges the ID + Secret for an access token server-side and refreshes it automatically. The secret is AES-256-GCM encrypted and never leaves the server.",
  };
}

export interface ChannelDef {
  key: ChannelKey;
  name: string;
  blurb: string;
  iconBg: string;
  monogram: string;
  /** Merchandising group used by the UI filter chips. */
  category: ChannelCategory;
  /** Surfaced with a "Popular" badge and pinned first. */
  popular?: boolean;
  /** Partner portal where the tenant creates / finds credentials. */
  portalUrl?: string;
  portalLabel?: string;
  credentialFields: CredentialFieldSpec[];
  /** Link technologies offered for this channel — first entry is the default. */
  linkMethods: LinkMethodDef[];
  /** The channel's own room-type ids (as shown in its extranet) for mapping. */
  catalog: { id: string; label: string }[];
}

/** Classic API-keys method built from the channel's credential fields. */
function keysMethod(fields: CredentialFieldSpec[]): LinkMethodDef {
  return {
    method: "api_keys", label: "API Keys", badge: "Direct push",
    blurb: "Direct XML/REST push — every availability and rate change is delivered server-to-server in real time.",
    fields,
  };
}

/** Resolve a channel's method def (falls back to the first offered method). */
export function getLinkMethodDef(def: ChannelDef, method?: string): LinkMethodDef | undefined {
  if (!def.linkMethods?.length) return undefined;
  return def.linkMethods.find((m) => m.method === method) ?? def.linkMethods[0];
}

/** Shared client+server validator — returns { fieldKey: error } (empty = valid). */
export function validateCredentialFields(
  fields: CredentialFieldSpec[],
  credentials: Record<string, string>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    if (!f.required) continue;
    const v = (credentials[f.key] ?? "").trim();
    const min = f.minLength ?? 4;
    if (v.length === 0) {
      errors[f.key] = `${f.label} is required`;
      continue;
    }
    if (v.length < min) {
      errors[f.key] = `Too short — enter at least ${min} characters`;
      continue;
    }
    if (f.numeric && !/^\d+$/.test(v)) {
      errors[f.key] = "Only digits are allowed in this field";
      continue;
    }
    if (f.pattern) {
      try {
        if (!new RegExp(f.pattern).test(v)) {
          errors[f.key] = f.patternHint ?? "The format doesn't look right";
          continue;
        }
      } catch {
        // defensive: never let a bad pattern break the handshake
      }
    }
  }
  return errors;
}

/* ─── The normalized channel registry ────────────────────────────────────── */

const RAW_CHANNEL_DEFS: Omit<ChannelDef, "linkMethods">[] = [
  {
    key: "booking_com", name: "Booking.com", monogram: "B.",
    blurb: "World's largest OTA — connectivity via XML partner API.",
    iconBg: "#003580", category: "global", popular: true,
    portalUrl: "https://admin.booking.com", portalLabel: "Booking.com Extranet",
    credentialFields: [
      {
        key: "hotelId", label: "Hotel ID (property ID)", placeholder: "e.g. 1073702",
        required: true, numeric: true, inputMode: "numeric", minLength: 4,
        help: "Extranet → Property details — the numeric property id shown at the top.",
      },
      {
        key: "apiKey", label: "Partner API key", placeholder: "Paste Booking.com API key",
        required: true, secret: true, minLength: 8,
        help: "Extranet → Account → Connectivity → XML / API credentials.",
      },
    ],
    catalog: [
      { id: "107370201", label: "107370201 — Deluxe King Room" },
      { id: "107370202", label: "107370202 — Executive Suite" },
      { id: "107370203", label: "107370203 — Premier Double" },
      { id: "107370204", label: "107370204 — Garden Villa" },
    ],
  },
  {
    key: "expedia", name: "Expedia", monogram: "EX",
    blurb: "Expedia Partner Central — ARN-based availability push.",
    iconBg: "#fbc02d", category: "global",
    portalUrl: "https://partner.expediapartnersolutions.com", portalLabel: "Expedia Partner Central",
    credentialFields: [
      {
        key: "hotelId", label: "Expedia Property ID", placeholder: "e.g. 2201001",
        required: true, numeric: true, inputMode: "numeric", minLength: 4,
        help: "Partner Central → Properties — numeric ID on the property row.",
      },
      {
        key: "apiKey", label: "API key + secret", placeholder: "key:secret",
        required: true, secret: true, minLength: 8,
        pattern: "^[^:\\s]+:[^:\\s]+$", patternHint: "Combine both values as key:secret (colon separated).",
        help: "Partner Central → Connectivity Admin → API credentials page.",
      },
    ],
    catalog: [
      { id: "EXP-RM-2201", label: "EXP-RM-2201 · Deluxe King" },
      { id: "EXP-RM-2202", label: "EXP-RM-2202 · Executive Suite" },
      { id: "EXP-RM-2203", label: "EXP-RM-2203 · Premier Double" },
      { id: "EXP-RM-2204", label: "EXP-RM-2204 · Garden Villa" },
    ],
  },
  {
    key: "mmt", name: "MakeMyTrip", monogram: "MM",
    blurb: "India's largest travel group — EasyXcelerate channel feed.",
    iconBg: "#e23c3c", category: "india", popular: true,
    portalUrl: "https://easyxcelerate.makemytrip.com", portalLabel: "EasyXcelerate Portal",
    credentialFields: [
      {
        key: "hotelId", label: "MMT Hotel Code", placeholder: "e.g. 202609260957123",
        required: true, numeric: true, inputMode: "numeric", minLength: 6,
        help: "EasyXcelerate → Property profile — the long numeric hotel code.",
      },
      {
        key: "apiKey", label: "Access key", placeholder: "Paste EasyXcelerate access key",
        required: true, secret: true, minLength: 8,
        help: "EasyXcelerate → Integration → Access keys.",
      },
    ],
    catalog: [
      { id: "MMT-RT-88101", label: "MMT-RT-88101 Deluxe" },
      { id: "MMT-RT-88102", label: "MMT-RT-88102 Suite" },
      { id: "MMT-RT-88103", label: "MMT-RT-88103 Premier" },
      { id: "MMT-RT-88104", label: "MMT-RT-88104 Villa" },
    ],
  },
  {
    key: "goibibo", name: "Goibibo", monogram: "GO",
    blurb: "Goibibo partner extranet — inventory via GO-RTX mapping.",
    iconBg: "#d84f57", category: "india",
    portalUrl: "https://partners.goibibo.com", portalLabel: "Goibibo Partner Portal",
    credentialFields: [
      {
        key: "hotelId", label: "Goibibo Hotel ID", placeholder: "e.g. GOHOT4567",
        required: true, minLength: 6,
        help: "Partner extranet → Property settings — id starting with GO.",
      },
      {
        key: "apiKey", label: "Partner token", placeholder: "Paste partner token",
        required: true, secret: true, minLength: 8,
        help: "Partner extranet → Integrations → API token.",
      },
    ],
    catalog: [
      { id: "GO-RTX-4501", label: "GO-RTX-4501 Deluxe Room" },
      { id: "GO-RTX-4502", label: "GO-RTX-4502 Executive Suite" },
      { id: "GO-RTX-4503", label: "GO-RTX-4503 Premier Room" },
      { id: "GO-RTX-4504", label: "GO-RTX-4504 Garden Villa" },
    ],
  },
  {
    key: "yatra", name: "Yatra", monogram: "YT",
    blurb: "Yatra Online — hotel extranet availability feed.",
    iconBg: "#0f4c81", category: "india",
    portalUrl: "https://www.yatra.com/online/partners", portalLabel: "Yatra Partner Portal",
    credentialFields: [
      {
        key: "hotelId", label: "Yatra Hotel Code", placeholder: "e.g. YTRH09123",
        required: true, minLength: 6,
        help: "Yatra extranet → Property profile — code starting with YTRH.",
      },
      {
        key: "apiKey", label: "Extranet key", placeholder: "Paste extranet key",
        required: true, secret: true, minLength: 8,
        help: "Yatra extranet → Settings → Connectivity credentials.",
      },
    ],
    catalog: [
      { id: "YTR-77110", label: "YTR-77110 — Deluxe" },
      { id: "YTR-77120", label: "YTR-77120 — Suite" },
      { id: "YTR-77130", label: "YTR-77130 — Premier" },
      { id: "YTR-77140", label: "YTR-77140 — Villa" },
    ],
  },
  {
    key: "agoda", name: "Agoda", monogram: "AG",
    blurb: "Agoda Partner Central — deep APAC reach, ARI push API.",
    iconBg: "#ff690f", category: "global",
    portalUrl: "https://partnercentral.agoda.com", portalLabel: "Agoda Partner Central",
    credentialFields: [
      {
        key: "hotelId", label: "Agoda Property ID", placeholder: "e.g. 1877450",
        required: true, numeric: true, inputMode: "numeric", minLength: 4,
        help: "Partner Central → Property settings — numeric property id.",
      },
      {
        key: "apiKey", label: "Partner API key", placeholder: "Paste Agoda API key",
        required: true, secret: true, minLength: 8,
        help: "Partner Central → Settings → API access keys.",
      },
    ],
    catalog: [
      { id: "AGD-RT-50101", label: "AGD-RT-50101 · Deluxe King" },
      { id: "AGD-RT-50102", label: "AGD-RT-50102 · Executive Suite" },
      { id: "AGD-RT-50103", label: "AGD-RT-50103 · Premier Double" },
      { id: "AGD-RT-50104", label: "AGD-RT-50104 · Garden Villa" },
    ],
  },
  {
    key: "easemytrip", name: "EasyMyTrip", monogram: "EM",
    blurb: "Easy My Trip — India value OTA with full ARI partner feed.",
    iconBg: "#274690", category: "india",
    portalUrl: "https://www.easemytrip.com", portalLabel: "EMT Partner Desk",
    credentialFields: [
      {
        key: "hotelId", label: "EMT Hotel Code", placeholder: "e.g. EMT-H-99123",
        required: true, minLength: 6,
        help: "EMT partner desk → Property profile — code starting with EMT-H.",
      },
      {
        key: "apiKey", label: "Partner access token", placeholder: "Paste EMT access token",
        required: true, secret: true, minLength: 8,
        help: "EMT partner desk → Integrations → Access tokens.",
      },
    ],
    catalog: [
      { id: "EMT-9911-DLX", label: "EMT-9911-DLX Deluxe Room" },
      { id: "EMT-9912-SUT", label: "EMT-9912-SUT Executive Suite" },
      { id: "EMT-9913-PRM", label: "EMT-9913-PRM Premier Room" },
      { id: "EMT-9914-VIL", label: "EMT-9914-VIL Garden Villa" },
    ],
  },
  {
    key: "cleartrip", name: "Cleartrip", monogram: "CT",
    blurb: "Cleartrip Hotels — extranet availability + rate channel.",
    iconBg: "#0e56c0", category: "india",
    portalUrl: "https://www.cleartrip.com", portalLabel: "Cleartrip Hotel Desk",
    credentialFields: [
      {
        key: "hotelId", label: "Cleartrip Hotel ID", placeholder: "e.g. CTH-45678",
        required: true, minLength: 6,
        help: "Cleartrip hotel desk → Property settings — id starting with CTH.",
      },
      {
        key: "apiKey", label: "API key", placeholder: "Paste Cleartrip API key",
        required: true, secret: true, minLength: 8,
        help: "Cleartrip hotel desk → Integrations → API keys.",
      },
    ],
    catalog: [
      { id: "CLR-77401", label: "CLR-77401 — Deluxe Room" },
      { id: "CLR-77402", label: "CLR-77402 — Executive Suite" },
      { id: "CLR-77403", label: "CLR-77403 — Premier Room" },
      { id: "CLR-77404", label: "CLR-77404 — Garden Villa" },
    ],
  },
  {
    key: "airbnb", name: "Airbnb", monogram: "AB",
    blurb: "Airbnb marketplace — per-listing availability sync.",
    iconBg: "#ff5a5f", category: "global", popular: true,
    portalUrl: "https://www.airbnb.com/host/homes", portalLabel: "Airbnb Hosting",
    credentialFields: [
      {
        key: "hotelId", label: "Listing host ID", placeholder: "e.g. host-778811",
        required: true, minLength: 6,
        help: "Airbnb Hosting → your host profile id (host-XXXXXX).",
      },
      {
        key: "apiKey", label: "OAuth token", placeholder: "Paste Airbnb OAuth token",
        required: true, secret: true, minLength: 8,
        help: "Airbnb developer console → approved app → OAuth token.",
      },
    ],
    catalog: [
      { id: "HM-77881101", label: "HM-77881101 · Deluxe King listing" },
      { id: "HM-77881102", label: "HM-77881102 · Executive Suite listing" },
      { id: "HM-77881103", label: "HM-77881103 · Premier Double listing" },
      { id: "HM-77881104", label: "HM-77881104 · Garden Villa listing" },
    ],
  },
  {
    key: "oyo", name: "OYO", monogram: "OY",
    blurb: "OYO Travel — storefront inventory via partner feed.",
    iconBg: "#ee2e24", category: "india",
    portalUrl: "https://partners.oyorooms.com", portalLabel: "OYO Partner Portal",
    credentialFields: [
      {
        key: "hotelId", label: "OYO Property ID", placeholder: "e.g. OYO-33201",
        required: true, minLength: 6,
        help: "OYO partner portal → Property settings — id like OYO-XXXXX.",
      },
      {
        key: "apiKey", label: "Partner token", placeholder: "Paste OYO partner token",
        required: true, secret: true, minLength: 8,
        help: "OYO partner portal → Integrations → API tokens.",
      },
    ],
    catalog: [
      { id: "OYO-RT-33201", label: "OYO-RT-33201 Deluxe Room" },
      { id: "OYO-RT-33202", label: "OYO-RT-33202 Executive Suite" },
      { id: "OYO-RT-33203", label: "OYO-RT-33203 Premier Room" },
      { id: "OYO-RT-33204", label: "OYO-RT-33204 Garden Villa" },
    ],
  },
  {
    key: "own_website", name: "Own Website", monogram: "VX",
    blurb: "The Velurex booking engine widget — always in sync, zero keys.",
    iconBg: "#1f4b43", category: "direct",
    credentialFields: [],
    catalog: [
      { id: "OWN-DELUXE", label: "OWN-DELUXE (auto-mapped from Velurex)" },
      { id: "OWN-SUITE", label: "OWN-SUITE (auto-mapped from Velurex)" },
      { id: "OWN-PREMIER", label: "OWN-PREMIER (auto-mapped from Velurex)" },
      { id: "OWN-VILLA", label: "OWN-VILLA (auto-mapped from Velurex)" },
    ],
  },
];

/**
 * Every channel is offered the link technologies it actually supports in the
 * real world. API keys remain the default for classic XML partners; Booking.com
 * and Airbnb additionally offer the OAuth 2.0 connectivity standard; iCal is
 * the universal zero-approval fallback for every extranet.
 */
export const CHANNEL_DEFS: ChannelDef[] = RAW_CHANNEL_DEFS.map((d) => {
  let linkMethods: LinkMethodDef[];
  switch (d.key) {
    case "own_website":
      linkMethods = [];
      break;
    case "booking_com":
      linkMethods = [
        keysMethod(d.credentialFields),
        oauthMethod("Booking.com", ["inventory.write", "rates.write", "bookings.read"]),
        icalMethod("Booking.com"),
      ];
      break;
    case "airbnb":
      linkMethods = [
        { ...icalMethod("Airbnb"), badge: "Recommended — works today" },
        oauthMethod("Airbnb", ["listings.read", "calendar.write", "bookings.read"]),
      ];
      break;
    default:
      linkMethods = [keysMethod(d.credentialFields), icalMethod(d.name)];
  }
  return { ...d, linkMethods };
});

/** Back-compat view: catalogs keyed by channel (derived, never hand-maintained). */
export const CHANNEL_CATALOGS: Record<ChannelKey, { id: string; label: string }[]> =
  Object.fromEntries(CHANNEL_DEFS.map((d) => [d.key, d.catalog])) as Record<ChannelKey, { id: string; label: string }[]>;

export function getChannelDef(key: string): ChannelDef | undefined {
  return CHANNEL_DEFS.find((d) => d.key === key);
}

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic per-key pseudo-random 0..99 — stable mocks per cell+channel. */
function seededScore(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100 + 100) % 100;
}

/**
 * Generic mock adapter: latency 250–700ms, ~14% first-attempt flake (retries
 * succeed). Credential validation runs through the SAME spec the UI uses
 * (`validateCredentialFields`) — the handshake checks format, not truth, so
 * tenants can test-drive the full flow in sandbox mode.
 */
function makeMockAdapter(channel: ChannelKey): ChannelAdapter {
  const def = getChannelDef(channel);
  return {
    channel,
    async testConnection(credentials, method = "api_keys") {
      await sleep(350 + Math.random() * 250);
      if (channel === "own_website") {
        return { ok: true, message: "Booking engine linked — inventory streams from Velurex directly." };
      }
      const methodDef = def ? getLinkMethodDef(def, method) : undefined;
      const fieldErrors = methodDef ? validateCredentialFields(methodDef.fields, credentials) : {};
      const first = Object.values(fieldErrors)[0];
      if (first) {
        return { ok: false, message: `Handshake rejected — ${first} Check the highlighted field and retry.` };
      }
      const name = def?.name ?? channel;
      if (method === "oauth2") {
        const scopes = methodDef?.scopes?.join(", ") ?? "";
        return {
          ok: true,
          message: `OAuth 2.0 handshake succeeded — ${name} (sandbox) issued a scoped access token${scopes ? ` (${scopes})` : ""}. Velurex refreshes it automatically.`,
        };
      }
      if (method === "ical") {
        return {
          ok: true,
          message: `iCal calendars linked — ${name} (sandbox) accepted the calendar URL. Import their events and serve your Velurex calendar URL from the card's "Link URLs".`,
        };
      }
      return {
        ok: true,
        message: `Handshake succeeded — ${name} (sandbox) accepted the credentials format.`,
      };
    },
    async pushInventory(p) {
      await sleep(220 + Math.random() * 480);
      const hasCreds = p.credentials && Object.keys(p.credentials).length > 0;
      if (channel !== "own_website" && !hasCreds) {
        return { ok: false, message: "Push failed — channel credentials missing (reconnect the channel)." };
      }
      if (!p.externalRoomTypeId) {
        return { ok: false, message: "Push failed — no external room type mapped for this room type." };
      }
      // Simulated OTA flakiness: deterministic per cell, transient — only the
      // FIRST attempt can hit the timeout; the retry path always succeeds.
      const score = seededScore(`${channel}:${p.roomTypeId}:${p.dateISO}`);
      if (channel !== "own_website" && score < 14 && (p.attempt ?? 1) < 2) {
        return { ok: false, message: `Gateway timeout from ${channel} mock API (ARI endpoint) — retry queued.` };
      }
      const ref = `${channel.slice(0, 2).toUpperCase()}-${Date.now().toString(36).slice(-6).toUpperCase()}`;
      const verb = p.action === "rate_update" ? `rate ₹${p.rate?.toFixed(0)}` : p.isOpen ? "open" : "closed";
      return {
        ok: true,
        message: `${verb} × ${p.availableCount} pushed for ${p.dateISO} (room ${p.externalRoomTypeId}).`,
        externalRef: ref,
      };
    },
  };
}

/** Own website pushes straight into the local booking engine — instant, reliable. */
const ownWebsiteAdapter: ChannelAdapter = makeMockAdapter("own_website");

export function getAdapter(channel: string): ChannelAdapter | null {
  switch (channel as ChannelKey) {
    case "own_website": return ownWebsiteAdapter;
    case "booking_com":
    case "expedia":
    case "mmt":
    case "goibibo":
    case "yatra":
    case "agoda":
    case "easemytrip":
    case "cleartrip":
    case "airbnb":
    case "oyo":
      return makeMockAdapter(channel as ChannelKey);
    default:
      return null;
  }
}
