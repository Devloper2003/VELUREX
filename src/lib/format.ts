/** Formatting helpers — Indian conventions (₹, en-IN, dd MMM yyyy). */

export function inr(amount: number | null | undefined, opts?: { decimals?: boolean }): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return "₹0";
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: opts?.decimals ? 2 : 0,
    maximumFractionDigits: opts?.decimals ? 2 : 0,
  }).format(amount);
}

export function num(n: number | null | undefined): string {
  return new Intl.NumberFormat("en-IN").format(n ?? 0);
}

export function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDateShort(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  // Explicit "26 Sep" style (locale-independent) — consistent with the
  // Inventory Control grid and Availability Calendar date formats.
  return `${String(date.getDate()).padStart(2, "0")} ${MONTHS_SHORT[date.getMonth()]}`;
}

export function fmtTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true });
}

export function fmtDateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  return `${fmtDate(d)} · ${fmtTime(d)}`;
}

/** yyyy-mm-dd for <input type="date"> / API params */
export function toISODate(d: string | Date | null | undefined): string {
  if (!d) return "";
  const date = typeof d === "string" ? new Date(d) : d;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayISO(): string {
  return toISODate(new Date());
}

export function addDays(d: string | Date, days: number): Date {
  const date = typeof d === "string" ? new Date(d) : new Date(d.getTime());
  date.setDate(date.getDate() + days);
  return date;
}

export function nightsBetween(a: string | Date, b: string | Date): number {
  const d1 = typeof a === "string" ? new Date(a) : a;
  const d2 = typeof b === "string" ? new Date(b) : b;
  const start = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate()).getTime();
  const end = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate()).getTime();
  return Math.max(1, Math.round((end - start) / 86400000));
}

export const STATUS_LABELS: Record<string, string> = {
  vacant: "Vacant",
  occupied: "Occupied",
  dirty: "Dirty",
  clean: "Clean",
  out_of_order: "Out of Order",
  hold: "Hold",
  confirmed: "Confirmed",
  checked_in: "Checked In",
  checked_out: "Checked Out",
  cancelled: "Cancelled",
  no_show: "No-Show",
  pending: "Pending",
  in_progress: "In Progress",
  completed: "Completed",
  blocked: "Blocked",
  open: "Open",
  resolved: "Resolved",
  preparing: "Preparing",
  served: "Served",
  unpaid: "Unpaid",
  paid: "Paid",
  posted_to_folio: "Posted to Folio",
  mock: "Simulated",
  queued: "Queued",
  sent: "Sent",
  failed: "Failed",
};

export const CATEGORY_LABELS: Record<string, string> = {
  room: "Room",
  fnb: "F&B",
  laundry: "Laundry",
  misc: "Misc",
  bar: "Bar",
  tax: "Tax",
  discount: "Discount",
  no_show: "No-Show",
};

/** Indian-format amount in words — "Rupees Fifty Two Thousand Four Hundred and Fifty Only". */
export function amountInWordsINR(value: number): string {
  const rupees = Math.floor(Math.abs(value));
  const paise = Math.round((Math.abs(value) - rupees) * 100);
  const ones = [
    "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
    "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen",
  ];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const twoDigits = (n: number): string =>
    n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ""}`;
  const threeDigits = (n: number): string =>
    `${n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? " and " : ""}` : ""}${n % 100 ? twoDigits(n % 100) : ""}`;

  if (rupees === 0 && paise === 0) return "Rupees Zero Only";

  const crore = Math.floor(rupees / 10_000_000);
  const lakh = Math.floor((rupees % 10_000_000) / 100_000);
  const thousand = Math.floor((rupees % 100_000) / 1_000);
  const rest = rupees % 1_000;

  let words = "";
  if (crore) words += `${crore > 99 ? threeDigits(crore) : twoDigits(crore)} Crore `;
  if (lakh) words += `${twoDigits(lakh)} Lakh `;
  if (thousand) words += `${twoDigits(thousand)} Thousand `;
  if (rest) words += threeDigits(rest);
  words = words.trim();

  let out = `Rupees ${words || "Zero"}`;
  if (paise > 0) out += ` and ${twoDigits(paise)} Paise`;
  return `${out} Only`;
}
