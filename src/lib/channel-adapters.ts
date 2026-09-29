/**
 * Channel adapters — the seam between Velurex inventory and every distribution
 * channel. Each channel implements `ChannelAdapter`; the worker calls adapters
 * and never talks to an OTA directly. Real OTA API clients (Booking.com XML,
 * Expedia Rapid, MMT/Goibibo partner APIs, Yatra, Agoda, EasyMyTrip, Cleartrip,
 * Airbnb, OYO…) can replace the mock implementations one-for-one without
 * touching the UI, queue, or logs.
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
  /** Validate credentials at connect time. */
  testConnection(credentials: Record<string, string>): Promise<ChannelPushResult>;
  /** Push availability / open-close (and rate when present) for one room-type-date. */
  pushInventory(p: ChannelPushPayload): Promise<ChannelPushResult>;
}

/* ─── Mock OTA room-type catalogs (what each channel exposes in their extranet) ─ */

export const CHANNEL_CATALOGS: Record<ChannelKey, { id: string; label: string }[]> = {
  booking_com: [
    { id: "107370201", label: "107370201 — Deluxe King Room" },
    { id: "107370202", label: "107370202 — Executive Suite" },
    { id: "107370203", label: "107370203 — Premier Double" },
    { id: "107370204", label: "107370204 — Garden Villa" },
  ],
  expedia: [
    { id: "EXP-RM-2201", label: "EXP-RM-2201 · Deluxe King" },
    { id: "EXP-RM-2202", label: "EXP-RM-2202 · Executive Suite" },
    { id: "EXP-RM-2203", label: "EXP-RM-2203 · Premier Double" },
    { id: "EXP-RM-2204", label: "EXP-RM-2204 · Garden Villa" },
  ],
  mmt: [
    { id: "MMT-RT-88101", label: "MMT-RT-88101 Deluxe" },
    { id: "MMT-RT-88102", label: "MMT-RT-88102 Suite" },
    { id: "MMT-RT-88103", label: "MMT-RT-88103 Premier" },
    { id: "MMT-RT-88104", label: "MMT-RT-88104 Villa" },
  ],
  goibibo: [
    { id: "GO-RTX-4501", label: "GO-RTX-4501 Deluxe Room" },
    { id: "GO-RTX-4502", label: "GO-RTX-4502 Executive Suite" },
    { id: "GO-RTX-4503", label: "GO-RTX-4503 Premier Room" },
    { id: "GO-RTX-4504", label: "GO-RTX-4504 Garden Villa" },
  ],
  yatra: [
    { id: "YTR-77110", label: "YTR-77110 — Deluxe" },
    { id: "YTR-77120", label: "YTR-77120 — Suite" },
    { id: "YTR-77130", label: "YTR-77130 — Premier" },
    { id: "YTR-77140", label: "YTR-77140 — Villa" },
  ],
  agoda: [
    { id: "AGD-RT-50101", label: "AGD-RT-50101 · Deluxe King" },
    { id: "AGD-RT-50102", label: "AGD-RT-50102 · Executive Suite" },
    { id: "AGD-RT-50103", label: "AGD-RT-50103 · Premier Double" },
    { id: "AGD-RT-50104", label: "AGD-RT-50104 · Garden Villa" },
  ],
  easemytrip: [
    { id: "EMT-9911-DLX", label: "EMT-9911-DLX Deluxe Room" },
    { id: "EMT-9912-SUT", label: "EMT-9912-SUT Executive Suite" },
    { id: "EMT-9913-PRM", label: "EMT-9913-PRM Premier Room" },
    { id: "EMT-9914-VIL", label: "EMT-9914-VIL Garden Villa" },
  ],
  cleartrip: [
    { id: "CLR-77401", label: "CLR-77401 — Deluxe Room" },
    { id: "CLR-77402", label: "CLR-77402 — Executive Suite" },
    { id: "CLR-77403", label: "CLR-77403 — Premier Room" },
    { id: "CLR-77404", label: "CLR-77404 — Garden Villa" },
  ],
  airbnb: [
    { id: "HM-77881101", label: "HM-77881101 · Deluxe King listing" },
    { id: "HM-77881102", label: "HM-77881102 · Executive Suite listing" },
    { id: "HM-77881103", label: "HM-77881103 · Premier Double listing" },
    { id: "HM-77881104", label: "HM-77881104 · Garden Villa listing" },
  ],
  oyo: [
    { id: "OYO-RT-33201", label: "OYO-RT-33201 Deluxe Room" },
    { id: "OYO-RT-33202", label: "OYO-RT-33202 Executive Suite" },
    { id: "OYO-RT-33203", label: "OYO-RT-33203 Premier Room" },
    { id: "OYO-RT-33204", label: "OYO-RT-33204 Garden Villa" },
  ],
  own_website: [
    { id: "OWN-DELUXE", label: "OWN-DELUXE (auto-mapped from Velurex)" },
    { id: "OWN-SUITE", label: "OWN-SUITE (auto-mapped from Velurex)" },
    { id: "OWN-PREMIER", label: "OWN-PREMIER (auto-mapped from Velurex)" },
    { id: "OWN-VILLA", label: "OWN-VILLA (auto-mapped from Velurex)" },
  ],
};

export const CHANNEL_DEFS: {
  key: ChannelKey;
  name: string;
  blurb: string;
  iconBg: string;
  monogram: string;
  credentialFields: { key: string; label: string; placeholder: string; required: boolean }[];
}[] = [
  {
    key: "booking_com", name: "Booking.com", monogram: "B.",
    blurb: "World's largest OTA — connectivity via XML partner API.",
    iconBg: "#003580",
    credentialFields: [
      { key: "hotelId", label: "Hotel ID (B_com property id)", placeholder: "e.g. 1073702", required: true },
      { key: "apiKey", label: "Partner API key", placeholder: "Paste Booking.com API key", required: true },
    ],
  },
  {
    key: "expedia", name: "Expedia", monogram: "EX",
    blurb: "Expedia Partner Central — ARN-based availability push.",
    iconBg: "#fbc02d",
    credentialFields: [
      { key: "hotelId", label: "Expedia Property ID", placeholder: "e.g. 2201001", required: true },
      { key: "apiKey", label: "API key + secret", placeholder: "key:secret", required: true },
    ],
  },
  {
    key: "mmt", name: "MakeMyTrip", monogram: "MM",
    blurb: "India's largest travel group — EasyXcelerate channel feed.",
    iconBg: "#e23c3c",
    credentialFields: [
      { key: "hotelId", label: "MMT Hotel Code", placeholder: "e.g. 202609260957123", required: true },
      { key: "apiKey", label: "Access key", placeholder: "Paste EasyXcelerate access key", required: true },
    ],
  },
  {
    key: "goibibo", name: "Goibibo", monogram: "GO",
    blurb: "Goibibo partner extranet — inventory via GO-RTX mapping.",
    iconBg: "#d84f57",
    credentialFields: [
      { key: "hotelId", label: "Goibibo Hotel ID", placeholder: "e.g. GOHOT4567", required: true },
      { key: "apiKey", label: "Partner token", placeholder: "Paste partner token", required: true },
    ],
  },
  {
    key: "yatra", name: "Yatra", monogram: "YT",
    blurb: "Yatra Online — hotel extranet availability feed.",
    iconBg: "#0f4c81",
    credentialFields: [
      { key: "hotelId", label: "Yatra Hotel Code", placeholder: "e.g. YTRH09123", required: true },
      { key: "apiKey", label: "Extranet password / key", placeholder: "Paste extranet key", required: true },
    ],
  },
  {
    key: "agoda", name: "Agoda", monogram: "AG",
    blurb: "Agoda Partner Central — deep APAC reach, ARI push API.",
    iconBg: "#ff690f",
    credentialFields: [
      { key: "hotelId", label: "Agoda Property ID", placeholder: "e.g. 1877450", required: true },
      { key: "apiKey", label: "Partner API key", placeholder: "Paste Agoda API key", required: true },
    ],
  },
  {
    key: "easemytrip", name: "EasyMyTrip", monogram: "EM",
    blurb: "Easy My Trip — India value OTA with full ARI partner feed.",
    iconBg: "#274690",
    credentialFields: [
      { key: "hotelId", label: "EMT Hotel Code", placeholder: "e.g. EMT-H-99123", required: true },
      { key: "apiKey", label: "Partner access token", placeholder: "Paste EMT access token", required: true },
    ],
  },
  {
    key: "cleartrip", name: "Cleartrip", monogram: "CT",
    blurb: "Cleartrip Hotels — extranet availability + rate channel.",
    iconBg: "#0e56c0",
    credentialFields: [
      { key: "hotelId", label: "Cleartrip Hotel ID", placeholder: "e.g. CTH-45678", required: true },
      { key: "apiKey", label: "API key", placeholder: "Paste Cleartrip API key", required: true },
    ],
  },
  {
    key: "airbnb", name: "Airbnb", monogram: "AB",
    blurb: "Airbnb marketplace — per-listing availability sync.",
    iconBg: "#ff5a5f",
    credentialFields: [
      { key: "hotelId", label: "Listing host ID", placeholder: "e.g. host-778811", required: true },
      { key: "apiKey", label: "OAuth token", placeholder: "Paste Airbnb OAuth token", required: true },
    ],
  },
  {
    key: "oyo", name: "OYO", monogram: "OY",
    blurb: "OYO Travel — storefront inventory via partner feed.",
    iconBg: "#ee2e24",
    credentialFields: [
      { key: "hotelId", label: "OYO Property ID", placeholder: "e.g. OYO-33201", required: true },
      { key: "apiKey", label: "Partner token", placeholder: "Paste OYO partner token", required: true },
    ],
  },
  {
    key: "own_website", name: "Own Website", monogram: "VX",
    blurb: "The Velurex booking engine widget — always in sync, zero keys.",
    iconBg: "#1f4b43",
    credentialFields: [],
  },
];

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

/** Generic mock adapter: latency 250–700ms, ~14% first-attempt flake (retries succeed). */
function makeMockAdapter(channel: ChannelKey): ChannelAdapter {
  return {
    channel,
    async testConnection(credentials) {
      await sleep(350 + Math.random() * 250);
      if (channel === "own_website") {
        return { ok: true, message: "Booking engine linked — inventory streams from Velurex directly." };
      }
      const missing = ["hotelId", "apiKey"].filter((k) => !credentials[k] || credentials[k].trim().length < 4);
      if (missing.length > 0) {
        return { ok: false, message: `Connection rejected — missing or too short: ${missing.join(", ")}.` };
      }
      return { ok: true, message: "Handshake succeeded — credentials accepted by (mock) channel API." };
    },
    async pushInventory(p) {
      await sleep(220 + Math.random() * 480);
      if (channel !== "own_website" && !p.credentials?.apiKey) {
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
