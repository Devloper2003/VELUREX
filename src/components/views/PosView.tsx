"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtTime, fmtDateShort, fmtDate, STATUS_LABELS, amountInWordsINR } from "@/lib/format";
import { money2, splitHalf } from "@/lib/invoice-format";
import { computePosTotals, posBillHtml, posRateBreakup, discountLabel, type PosBill } from "@/lib/pos-gst";
import { useSession } from "@/lib/store";
import { useRealtime } from "@/lib/realtime";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Banknote,
  Bell,
  CakeSlice,
  Check,
  CheckCircle2,
  ChefHat,
  ChevronUp,
  Clock,
  Coffee,
  ConciergeBell,
  CookingPot,
  CreditCard,
  Calculator,
  Download,
  Flame,
  ImagePlus,
  LayoutGrid,
  Minus,
  Pencil,
  Plus,
  Printer,
  RefreshCw,
  Repeat,
  ReceiptText,
  Salad,
  Search,
  Send,
  Eye,
  ShoppingBag,
  Smartphone,
  Trash2,
  Utensils,
  Wallet,
  Wine,
  X,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

interface MenuItemT {
  id: string;
  name: string;
  category: string;
  price: number;
  isVeg: boolean;
  available: boolean;
  description: string;
  taxRate: number;
  imageUrl?: string;
}

interface CartLine {
  menuItemId: string;
  name: string;
  price: number;
  taxRate: number;
  isVeg: boolean;
  qty: number;
  notes: string;
}

interface OrderItemT {
  id: string;
  name: string;
  qty: number;
  notes: string;
  status: string;
  price: number;
  amount: number;
  menuItemId?: string | null;
  menuItem?: { category: string; taxRate: number } | null;
}

interface OrderT {
  id: string;
  orderNumber: string;
  orderType: string;
  tableNumber: string;
  roomNumber: string;
  guestName: string;
  status: string;
  subtotal: number;
  discountMode: string;
  discountValue: number;
  discountAmount: number;
  taxAmount: number;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  servedBy: string;
  reservationId: string | null;
  createdAt: string;
  updatedAt: string;
  items: OrderItemT[];
  reservation?: { guest?: { fullName: string }; room?: { number: string } } | null;
}

interface InhouseT {
  reservationId: string;
  guestName: string;
  roomNumber: string;
}

/** Online payment gateway assigned to this property by the platform owner. */
interface GatewayT {
  id: string;
  provider: string;
  label: string;
  mode: string;
  isDefault: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

type OrderTypeKey = "dine_in" | "room_service" | "takeaway";

const ORDER_TYPES: { key: OrderTypeKey; label: string; icon: typeof Utensils }[] = [
  { key: "dine_in", label: "Dine-in", icon: Utensils },
  { key: "room_service", label: "Room Service", icon: ConciergeBell },
  { key: "takeaway", label: "Takeaway", icon: ShoppingBag },
];

const CATEGORY_TABS = [
  { key: "all", label: "All" },
  { key: "starter", label: "Starter" },
  { key: "main", label: "Main" },
  { key: "dessert", label: "Dessert" },
  { key: "beverage", label: "Beverage" },
  { key: "bar", label: "Bar" },
];

const CAT_ICONS: Record<string, typeof Utensils> = {
  all: LayoutGrid,
  starter: Salad,
  main: CookingPot,
  dessert: CakeSlice,
  beverage: Coffee,
  bar: Wine,
};

const NEXT_STATUS: Record<string, string> = { pending: "preparing", preparing: "served", served: "completed" };
const NEXT_LABEL: Record<string, string> = { pending: "Start prep", preparing: "Mark served", served: "Complete" };

// Item-level KOT progression (mirrors the Kitchen Display)
const KOT_ITEM_NEXT: Record<string, string> = { pending: "preparing", preparing: "ready", ready: "served" };

const KOT_ITEM_CHIP: Record<string, string> = {
  pending: "border-line-strong bg-plaster text-ink",
  preparing: "border-warn/50 bg-warn/10 text-warn",
  ready: "border-brass/50 bg-brass-50 text-brass",
  served: "border-ok/50 bg-ok/10 text-ok",
};

const STATUS_BADGE: Record<string, string> = {
  pending: "border-warn/40 bg-warn/10 text-warn",
  preparing: "border-brass/40 bg-brass-50 text-brass",
  served: "border-pine-700/30 bg-pine-100 text-pine-700",
  completed: "border-ok/40 bg-ok/10 text-ok",
  cancelled: "border-danger/30 bg-danger/10 text-danger",
};

const PAY_BADGE: Record<string, string> = {
  unpaid: "border-danger/40 bg-danger/10 text-danger",
  paid: "border-ok/40 bg-ok/10 text-ok",
  posted_to_folio: "border-brass/40 bg-brass-50 text-brass",
};

const TYPE_LABEL: Record<string, string> = { dine_in: "Dine-in", room_service: "Room Svc", takeaway: "Takeaway" };

/** Provider key → display label for payment gateways assigned by the platform owner. */
const GATEWAY_LABELS: Record<string, string> = {
  razorpay: "Razorpay",
  cashfree: "Cashfree",
  payu: "PayU",
  paytm: "Paytm",
  phonepe: "PhonePe",
  stripe: "Stripe",
  upi_qr: "UPI QR",
  bank_transfer: "Bank transfer",
  custom: "Custom",
};
const gatewayLabel = (p: string) => GATEWAY_LABELS[p] ?? p.replace(/_/g, " ");

/** Uniform item GST rate across an order (null when rates are mixed). */
function orderUniformRate(o: OrderT): number | null {
  const rates = new Set(o.items.map((i) => i.menuItem?.taxRate ?? 5));
  return rates.size === 1 ? [...rates][0] : null;
}
const cgstLabel = (o: OrderT) => {
  const r = orderUniformRate(o);
  return r === null ? "CGST" : `CGST @ ${r / 2}%`;
};
const sgstLabel = (o: OrderT) => {
  const r = orderUniformRate(o);
  return r === null ? "SGST" : `SGST @ ${r / 2}%`;
};

const round2 = (n: number) => Math.round(n * 100) / 100;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/**
 * Client-side image compression for uploads: longest edge ≤ 512px, JPEG q0.82.
 * Returns raw base64 (no data: prefix) — small enough for POST /api/uploads.
 */
async function compressImageFile(file: File): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read the image file"));
    reader.readAsDataURL(file);
  });
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Unsupported image format — use JPEG, PNG or WebP"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, 512 / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas is not supported in this browser");
  ctx.drawImage(img, 0, 0, w, h);
  const out = canvas.toDataURL("image/jpeg", 0.82);
  const base64 = out.slice(out.indexOf(",") + 1);
  if (!base64) throw new Error("Could not compress the image");
  return base64;
}

/** Compress → POST /api/uploads → public URL (/api/uploads/<id>). */
async function uploadImageFile(file: File): Promise<string> {
  const base64 = await compressImageFile(file);
  const res = await api<{ url: string }>("/api/uploads", {
    method: "POST",
    body: JSON.stringify({ mime: "image/jpeg", dataBase64: base64 }),
  });
  return res.url;
}

/** 44px manage-row thumbnail with veg/non-veg letter fallback; click to replace. */
function ItemThumb({
  name,
  isVeg,
  imageUrl,
  busy,
  onPick,
  onRemove,
}: {
  name: string;
  isVeg: boolean;
  imageUrl: string;
  busy: boolean;
  onPick: () => void;
  onRemove?: () => void;
}) {
  return (
    <span className="relative shrink-0">
      <button
        type="button"
        onClick={onPick}
        disabled={busy}
        title={imageUrl ? "Replace photo" : "Add photo"}
        aria-label={imageUrl ? `Replace photo for ${name}` : `Add photo for ${name}`}
        className="group relative block h-11 w-11 overflow-hidden rounded-md border border-line transition hover:border-brass disabled:opacity-50"
      >
        {imageUrl ? (
          <img src={imageUrl} alt={`${name} photo`} className="h-full w-full object-cover" />
        ) : (
          <span
            className={cn(
              "flex h-full w-full items-center justify-center font-display text-base font-semibold",
              isVeg ? "bg-ok/15 text-ok" : "bg-danger/10 text-danger"
            )}
          >
            {name.charAt(0).toUpperCase()}
          </span>
        )}
        <span className="absolute inset-0 hidden items-center justify-center bg-pine/60 text-panel group-hover:flex">
          <ImagePlus className="h-4 w-4" />
        </span>
      </button>
      {imageUrl && onRemove && (
        <button
          type="button"
          onClick={onRemove}
          disabled={busy}
          title="Remove photo"
          aria-label={`Remove photo for ${name}`}
          className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-line bg-panel text-danger shadow-sm transition hover:bg-danger hover:text-white disabled:opacity-50"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}

// ─── Small pieces ────────────────────────────────────────────────────────────

function VegDot({ isVeg }: { isVeg: boolean }) {
  return (
    <span
      title={isVeg ? "Veg" : "Non-veg"}
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 bg-panel",
        isVeg ? "border-ok" : "border-danger"
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", isVeg ? "bg-ok" : "bg-danger")} />
    </span>
  );
}

/** Item status chip on a KOT ticket — tap to advance (pending → preparing → ready → served). */
function KotItemChip({
  item,
  busy,
  onClick,
}: {
  item: OrderItemT;
  busy: boolean;
  onClick: () => void;
}) {
  const next = KOT_ITEM_NEXT[item.status];
  const Icon = item.status === "pending" ? Clock : item.status === "preparing" ? Flame : item.status === "ready" ? Bell : Check;
  if (!next) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold", KOT_ITEM_CHIP[item.status])}>
        <Icon className="h-3.5 w-3.5" /> {STATUS_LABELS[item.status] ?? item.status}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      title={`Tap → ${STATUS_LABELS[next] ?? next}`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition hover:scale-[1.04] active:scale-95 disabled:opacity-60",
        KOT_ITEM_CHIP[item.status]
      )}
    >
      <Icon className="h-3.5 w-3.5" /> {STATUS_LABELS[item.status] ?? item.status}
      <span className="text-[10px] opacity-60">▸</span>
    </button>
  );
}

/**
 * White-labeled kitchen ticket — one shared receipt format for the "order sent"
 * dialog (#kot-print) and the order-detail sheet (#kot-print-detail).
 * Header: property name + ticket class + big order number · items with a brass
 * qty column and hanging notes · subtotal/GST/total footer. No platform brand.
 */
function KotReceipt({ id, order, propertyName }: { id: string; order: OrderT; propertyName: string }) {
  return (
    <div id={id} className="rounded-md border border-line bg-panel p-4 font-mono text-sm space-y-2.5">
      <div className="text-center space-y-1">
        <p className="font-display text-[13px] font-semibold uppercase tracking-[0.18em] text-pine">
          {propertyName || "Restaurant"}
        </p>
        <p className="text-[9px] font-semibold uppercase tracking-[0.32em] text-brass">Kitchen Order Ticket</p>
        <p className="font-display text-3xl font-bold text-pine tracking-wide">{order.orderNumber}</p>
        <p className="text-xs text-muted-ink">
          {fmtTime(order.createdAt)} ·{" "}
          {order.orderType === "dine_in"
            ? `Table ${order.tableNumber || "—"}`
            : order.orderType === "room_service"
              ? `Room ${order.roomNumber || "—"}`
              : "Takeaway"}
        </p>
      </div>
      <div className="border-t border-dashed border-line-strong pt-2.5 space-y-2">
        {order.items.map((i) => (
          <div key={i.id} className="leading-tight">
            <div className="flex items-baseline gap-2.5">
              <span className="w-7 shrink-0 text-right font-bold text-brass">{i.qty}×</span>
              <span className="min-w-0 flex-1">{i.name}</span>
            </div>
            {i.notes && <p className="pl-[42px] text-xs font-medium text-warn italic">↳ {i.notes}</p>}
          </div>
        ))}
      </div>
      <div className="border-t border-dashed border-line-strong pt-2 space-y-1">
        <div className="flex justify-between text-xs text-muted-ink">
          <span>Gross amount</span>
          <span>{inr(order.subtotal, { decimals: true })}</span>
        </div>
        {order.discountAmount > 0 && (
          <div className="flex justify-between text-xs text-muted-ink">
            <span>{discountLabel(order.discountMode, order.discountValue)}</span>
            <span>−{inr(order.discountAmount, { decimals: true })}</span>
          </div>
        )}
        <div className="flex justify-between text-xs text-muted-ink">
          <span>Taxable value</span>
          <span>{inr(order.subtotal - order.discountAmount, { decimals: true })}</span>
        </div>
        <div className="flex justify-between text-xs text-muted-ink">
          <span>{cgstLabel(order)}</span>
          <span>{inr(splitHalf(order.taxAmount), { decimals: true })}</span>
        </div>
        <div className="flex justify-between text-xs text-muted-ink">
          <span>{sgstLabel(order)}</span>
          <span>{inr(order.taxAmount - splitHalf(order.taxAmount), { decimals: true })}</span>
        </div>
        <div className="flex justify-between border-t border-line pt-1.5">
          <span className="text-xs uppercase tracking-wider">Total (incl. GST)</span>
          <span className="font-bold text-pine">{inr(order.totalAmount, { decimals: true })}</span>
        </div>
      </div>
    </div>
  );
}

function TypeCell({ o }: { o: OrderT }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-medium text-ink">
        {TYPE_LABEL[o.orderType] ?? o.orderType}
        {o.orderType === "dine_in" && o.tableNumber ? ` · T${o.tableNumber}` : ""}
        {o.orderType === "room_service" && o.roomNumber ? ` · Room ${o.roomNumber}` : ""}
      </p>
      {o.guestName && <p className="text-xs text-muted-ink truncate">{o.guestName}</p>}
    </div>
  );
}

// ─── View ────────────────────────────────────────────────────────────────────

export default function PosView() {
  const user = useSession((s) => s.user);
  const propertyName = user?.propertyName ?? "";
  const { toast } = useToast();
  const canManage = user?.role === "hotel_admin" || user?.role === "restaurant_staff";

  const [menu, setMenu] = useState<MenuItemT[]>([]);
  const [inhouse, setInhouse] = useState<InhouseT[]>([]);
  const [orders, setOrders] = useState<OrderT[]>([]);

  const [cat, setCat] = useState("all");
  const [search, setSearch] = useState("");

  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderType, setOrderType] = useState<OrderTypeKey>("dine_in");
  const [tableNumber, setTableNumber] = useState("");
  const [reservationId, setReservationId] = useState("");
  const [guestName, setGuestName] = useState("");
  const [sending, setSending] = useState(false);

  const [manageOpen, setManageOpen] = useState(false);
  const [mgCat, setMgCat] = useState("all");
  const [mgSearch, setMgSearch] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [newName, setNewName] = useState("");
  const [newCat, setNewCat] = useState("starter");
  const [newPrice, setNewPrice] = useState("");
  const [newVeg, setNewVeg] = useState(true);
  const [newDesc, setNewDesc] = useState("");
  const [newTax, setNewTax] = useState("5");
  const [newImageUrl, setNewImageUrl] = useState("");
  const [imageBusy, setImageBusy] = useState(false);
  const [pickingFor, setPickingFor] = useState<string | null>(null); // "new" | menuItemId
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // ── Order-level discount (applied BEFORE GST — official CGST §15 semantics) ──
  const [discMode, setDiscMode] = useState<"none" | "percent" | "flat">("none");
  const [discValue, setDiscValue] = useState("");

  // ── Official restaurant tax invoice (guest bill) ──
  const [hotel, setHotel] = useState({
    name: "",
    address: "",
    city: "",
    state: "",
    gstin: "",
    phone: "",
    email: "",
  });
  const [billOrderId, setBillOrderId] = useState<string | null>(null);

  // ── Day sales summary (Z-report) ──
  const [dayOpen, setDayOpen] = useState(false);

  const [successOrder, setSuccessOrder] = useState<OrderT | null>(null);
  const [successKotNote, setSuccessKotNote] = useState("");
  const [settleTarget, setSettleTarget] = useState<OrderT | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);

  // ── Order details — tap any order row to inspect & drive its KOT from this terminal ──
  const [detailId, setDetailId] = useState<string | null>(null);
  const [itemBusyId, setItemBusyId] = useState<string | null>(null);

  // ── Online payment gateways assigned by the platform owner ──
  const [gateways, setGateways] = useState<GatewayT[]>([]);

  // ── Loaders ──
  const loadMenu = useCallback(async () => {
    try {
      const d = await api<{ items: MenuItemT[] }>("/api/menu");
      setMenu(d.items);
    } catch {
      /* keep stale */
    }
  }, []);

  const loadInhouse = useCallback(async () => {
    try {
      const d = await api<{ guests: InhouseT[] }>("/api/pos/inhouse");
      setInhouse(d.guests);
    } catch {
      /* keep stale */
    }
  }, []);

  const loadOrders = useCallback(async () => {
    try {
      const d = await api<{ orders: OrderT[] }>("/api/pos/orders?today=1");
      setOrders(d.orders);
    } catch {
      /* keep stale */
    }
  }, []);

  // Property identity for the official GST bill (GSTIN, address, place of supply).
  const loadHotel = useCallback(async () => {
    try {
      const d = await api<{ property: { name: string; address: string; city: string; state: string; gstin: string; phone: string; email: string } }>("/api/settings");
      setHotel(d.property);
    } catch {
      /* optional — bill falls back to the session property name */
    }
  }, []);

  const loadGateways = useCallback(async () => {
    try {
      const d = await api<{ gateways: GatewayT[] }>("/api/payments/gateways");
      setGateways(d.gateways);
    } catch {
      /* optional feature — stay quiet */
    }
  }, []);

  useEffect(() => {
    loadMenu();
    loadInhouse();
  }, [loadMenu, loadInhouse]);

  useEffect(() => {
    loadOrders();
    loadGateways();
    loadHotel();
    const t = setInterval(loadOrders, 30000);
    return () => clearInterval(t);
  }, [loadOrders, loadGateways, loadHotel]);

  // First-run setup: opening the manager on an empty menu pops the composer open.
  useEffect(() => {
    if (manageOpen && menu.length === 0) setComposerOpen(true);
  }, [manageOpen, menu.length]);

  // Realtime: order status flips (kitchen screen, other terminals) land instantly.
  useRealtime((event) => {
    if (event === "kot:update") loadOrders();
  });

  // ── Derived ──
  const selectedGuest = inhouse.find((g) => g.reservationId === reservationId) ?? null;
  const detailOrder = detailId ? orders.find((o) => o.id === detailId) ?? null : null;
  const detailBusy = detailOrder ? itemBusyId === detailOrder.id : false;
  const billOrder = billOrderId ? orders.find((o) => o.id === billOrderId) ?? null : null;

  /** Official restaurant tax invoice payload for the selected order. */
  const bill: PosBill | null = billOrder
    ? {
        billNo: billOrder.orderNumber,
        date: billOrder.createdAt,
        orderType: billOrder.orderType,
        tableNumber: billOrder.tableNumber,
        roomNumber: billOrder.roomNumber,
        guestName: billOrder.guestName,
        servedBy: billOrder.servedBy,
        hotel: { ...hotel, name: hotel.name || propertyName },
        items: billOrder.items.map((i) => ({
          name: i.name,
          category: i.menuItem?.category,
          qty: i.qty,
          price: i.price,
          amount: i.amount,
          taxRate: i.menuItem?.taxRate ?? 5,
          notes: i.notes || undefined,
        })),
        subtotal: billOrder.subtotal,
        discountMode: billOrder.discountMode,
        discountValue: billOrder.discountValue,
        discountAmount: billOrder.discountAmount,
        taxAmount: billOrder.taxAmount,
        totalAmount: billOrder.totalAmount,
        paymentStatus: billOrder.paymentStatus,
        paymentMethod: billOrder.paymentMethod,
        settledAt: billOrder.updatedAt,
      }
    : null;

  // ── Day sales summary (Z-report) — aggregates stored order totals ──
  const dayStats = useMemo(() => {
    const live = orders.filter((o) => o.status !== "cancelled");
    const sum = (f: (o: OrderT) => number) => round2(live.reduce((s, o) => s + f(o), 0));
    const byMethod = new Map<string, number>();
    for (const o of live) {
      if (o.paymentStatus === "unpaid") continue;
      const key =
        o.paymentStatus === "posted_to_folio"
          ? "Room folio"
          : (o.paymentMethod || "online").toUpperCase();
      byMethod.set(key, round2((byMethod.get(key) ?? 0) + o.totalAmount));
    }
    return {
      count: live.length,
      unpaid: live.filter((o) => o.paymentStatus === "unpaid").length,
      gross: sum((o) => o.subtotal),
      discount: sum((o) => o.discountAmount),
      taxable: sum((o) => o.subtotal - o.discountAmount),
      tax: sum((o) => o.taxAmount),
      net: sum((o) => o.totalAmount),
      byMethod: [...byMethod.entries()].sort((a, b) => b[1] - a[1]),
    };
  }, [orders]);

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menu.filter(
      (m) =>
        (cat === "all" || m.category === cat) &&
        (q === "" || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
    );
  }, [menu, cat, search]);

  // ── Menu manager derived: rail stats + filtered pane list ──
  const railItems = useMemo(() => {
    const counts: Record<string, { total: number; soldOut: number }> = {};
    for (const m of menu) {
      const e = counts[m.category] ?? (counts[m.category] = { total: 0, soldOut: 0 });
      e.total += 1;
      if (!m.available) e.soldOut += 1;
    }
    const soldOutAll = menu.reduce((s, m) => s + (m.available ? 0 : 1), 0);
    return CATEGORY_TABS.map((c) => ({
      key: c.key,
      label: c.label,
      total: c.key === "all" ? menu.length : (counts[c.key]?.total ?? 0),
      soldOut: c.key === "all" ? soldOutAll : (counts[c.key]?.soldOut ?? 0),
    }));
  }, [menu]);

  const mgItems = useMemo(() => {
    const q = mgSearch.trim().toLowerCase();
    return menu.filter(
      (m) =>
        (mgCat === "all" || m.category === mgCat) &&
        (q === "" || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
    );
  }, [menu, mgCat, mgSearch]);

  const activeRail = railItems.find((r) => r.key === mgCat) ?? railItems[0];
  const allStats = railItems.find((r) => r.key === "all") ?? { total: 0, soldOut: 0, key: "all", label: "All" };

  const totals = useMemo(
    () => computePosTotals(cart, discMode, Number(discValue) || 0),
    [cart, discMode, discValue]
  );

  // Uniform GST rate across the cart (null when mixed) — drives the CGST/SGST labels.
  const cartRate = useMemo(() => {
    const rates = new Set(cart.map((l) => l.taxRate));
    return rates.size === 1 ? [...rates][0] : null;
  }, [cart]);

  const cartQty = (menuItemId: string) => cart.find((l) => l.menuItemId === menuItemId)?.qty ?? 0;

  // ── Cart actions ──
  const addToCart = (m: MenuItemT) => {
    if (!m.available) return;
    setCart((prev) => {
      const found = prev.find((l) => l.menuItemId === m.id);
      if (found) return prev.map((l) => (l.menuItemId === m.id ? { ...l, qty: l.qty + 1 } : l));
      return [
        ...prev,
        { menuItemId: m.id, name: m.name, price: m.price, taxRate: m.taxRate, isVeg: m.isVeg, qty: 1, notes: "" },
      ];
    });
  };

  const changeQty = (menuItemId: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => (l.menuItemId === menuItemId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0)
    );
  };

  const setNote = (menuItemId: string, notes: string) => {
    setCart((prev) => prev.map((l) => (l.menuItemId === menuItemId ? { ...l, notes } : l)));
  };

  // ── Order actions ──
  const sendToKitchen = async () => {
    if (cart.length === 0 || sending) return;
    if (orderType === "dine_in" && !tableNumber.trim()) {
      toast({ title: "Table number required", description: "Enter a table number for dine-in orders.", variant: "destructive" });
      return;
    }
    if (orderType === "room_service" && !reservationId) {
      toast({ title: "Select a room", description: "Pick the in-house guest to charge.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const payload: Record<string, unknown> = {
        orderType,
        items: cart.map((l) => ({ menuItemId: l.menuItemId, qty: l.qty, notes: l.notes || undefined })),
      };
      if (orderType === "dine_in") payload.tableNumber = tableNumber.trim();
      if (orderType === "room_service") {
        payload.reservationId = reservationId;
        if (selectedGuest) payload.roomNumber = selectedGuest.roomNumber;
      }
      if (orderType === "takeaway") payload.guestName = guestName.trim() || "Walk-in Guest";
      if (discMode !== "none" && Number(discValue) > 0) {
        payload.discountMode = discMode;
        payload.discountValue = Number(discValue);
      }

      const res = await api<{
        order: OrderT;
        kotBroadcast?: { recipients: number; sent: number; failed: number; skipped: string } | null;
      }>("/api/pos/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setCart([]);
      setDiscMode("none");
      setDiscValue("");
      const kb = res.kotBroadcast;
      setSuccessKotNote(
        kb && kb.sent > 0
          ? `KOT broadcast to ${kb.sent} WhatsApp number${kb.sent === 1 ? "" : "s"}${kb.failed > 0 ? ` · ${kb.failed} failed` : ""}`
          : ""
      );
      setSuccessOrder(res.order);
      toast({ title: `Order ${res.order.orderNumber} sent to kitchen` });
      loadOrders();
    } catch (e) {
      toast({ title: "Could not send order", description: errMsg(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const doSettle = async (method: string) => {
    if (!settleTarget) return;
    try {
      await api(`/api/pos/orders/${settleTarget.id}/settle`, {
        method: "POST",
        body: JSON.stringify({ method }),
      });
      toast({
        title: `Settled via ${method.toUpperCase()}`,
        description: `${settleTarget.orderNumber} · ${inr(settleTarget.totalAmount, { decimals: true })}`,
      });
      setSettleTarget(null);
      loadOrders();
    } catch (e) {
      toast({ title: "Settle failed", description: errMsg(e), variant: "destructive" });
    }
  };

  const doPostFolio = async (order: OrderT) => {
    setPostingId(order.id);
    try {
      await api(`/api/pos/orders/${order.id}/post-folio`, {
        method: "POST",
        body: JSON.stringify({ reservationId: order.reservationId ?? undefined }),
      });
      toast({
        title: `Posted to Room ${order.roomNumber} folio`,
        description: `${order.orderNumber} · ${inr(order.totalAmount, { decimals: true })}`,
      });
      setSuccessOrder(null);
      loadOrders();
    } catch (e) {
      toast({ title: "Folio posting failed", description: errMsg(e), variant: "destructive" });
    } finally {
      setPostingId(null);
    }
  };

  const advance = async (order: OrderT) => {
    const next = NEXT_STATUS[order.status];
    if (!next) return;
    try {
      await api(`/api/pos/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      loadOrders();
    } catch (e) {
      toast({ title: "Status update failed", description: errMsg(e), variant: "destructive" });
    }
  };

  const cancelOrder = async (order: OrderT) => {
    try {
      await api(`/api/pos/orders/${order.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) });
      toast({ title: `Order ${order.orderNumber} cancelled` });
      loadOrders();
    } catch (e) {
      toast({ title: "Cancel failed", description: errMsg(e), variant: "destructive" });
    }
  };

  // ── Reorder — pull a past order's items back into the cart ──
  const reorder = (o: OrderT) => {
    let added = 0;
    let skipped = 0;
    setCart((prev) => {
      const next = prev.map((l) => ({ ...l }));
      for (const it of o.items) {
        const m =
          menu.find((mm) => mm.id === it.menuItemId) ??
          menu.find((mm) => mm.name.toLowerCase() === it.name.toLowerCase());
        if (!m || !m.available) {
          skipped += 1;
          continue;
        }
        const found = next.find((l) => l.menuItemId === m.id);
        if (found) found.qty += it.qty;
        else next.push({ menuItemId: m.id, name: m.name, price: m.price, taxRate: m.taxRate, isVeg: m.isVeg, qty: it.qty, notes: it.notes || "" });
        added += 1;
      }
      return next;
    });
    toast({
      title: added > 0 ? `Reordered ${added} item${added === 1 ? "" : "s"} from ${o.orderNumber}` : "Nothing to reorder",
      description: skipped > 0 ? `${skipped} item${skipped === 1 ? "" : "s"} unavailable or sold out — skipped.` : undefined,
    });
  };

  // ── Guest bill download — official restaurant tax invoice as standalone HTML ──
  const downloadBill = () => {
    if (!bill) return;
    const blob = new Blob([posBillHtml(bill)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bill.billNo}-tax-invoice.html`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Tax invoice downloaded", description: `${bill.billNo} · ${inr(bill.totalAmount, { decimals: true })}` });
  };

  // ── Order detail / KOT actions — drive the kitchen ticket from this terminal ──
  const advanceOrderItem = async (item: OrderItemT) => {
    const next = KOT_ITEM_NEXT[item.status];
    if (!next || itemBusyId) return;
    setItemBusyId(item.id);
    try {
      await api(`/api/pos/items/${item.id}`, { method: "PATCH", body: JSON.stringify({ status: next }) });
      await loadOrders();
    } catch (e) {
      toast({ title: "Could not update item", description: errMsg(e), variant: "destructive" });
    } finally {
      setItemBusyId(null);
    }
  };

  const detailAllReady = async (o: OrderT) => {
    const targets = o.items.filter((i) => i.status === "pending" || i.status === "preparing");
    if (targets.length === 0 || itemBusyId) return;
    setItemBusyId(o.id);
    try {
      await Promise.all(
        targets.map((i) => api(`/api/pos/items/${i.id}`, { method: "PATCH", body: JSON.stringify({ status: "ready" }) }))
      );
      toast({ title: `${o.orderNumber} — all items ready` });
      await loadOrders();
    } catch (e) {
      toast({ title: "Could not update items", description: errMsg(e), variant: "destructive" });
      await loadOrders();
    } finally {
      setItemBusyId(null);
    }
  };

  const detailServed = async (o: OrderT) => {
    if (itemBusyId) return;
    setItemBusyId(o.id);
    try {
      await api(`/api/pos/orders/${o.id}`, { method: "PATCH", body: JSON.stringify({ status: "served" }) });
      toast({ title: `${o.orderNumber} marked served` });
      await loadOrders();
    } catch (e) {
      toast({ title: "Could not update order", description: errMsg(e), variant: "destructive" });
    } finally {
      setItemBusyId(null);
    }
  };

  // ── Menu management ──
  const addMenuItem = async () => {
    const price = Number(newPrice);
    if (!newName.trim() || !Number.isFinite(price) || price <= 0) {
      toast({ title: "Name and a positive price are required", variant: "destructive" });
      return;
    }
    const addedCat = newCat;
    try {
      await api("/api/menu", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          category: addedCat,
          price,
          isVeg: newVeg,
          description: newDesc.trim(),
          taxRate: Number(newTax) || 5, // flat 5% GST (CGST 2.5% + SGST 2.5%) unless overridden
          imageUrl: newImageUrl || undefined,
        }),
      });
      toast({ title: `${newName.trim()} added to menu` });
      setNewName("");
      setNewPrice("");
      setNewDesc("");
      setNewVeg(true);
      setNewTax("5");
      setNewImageUrl("");
      setMgCat(addedCat); // jump the rail so the new dish is visible immediately
      loadMenu();
    } catch (e) {
      toast({ title: "Could not add item", description: errMsg(e), variant: "destructive" });
    }
  };

  const openComposer = () => {
    if (mgCat !== "all") setNewCat(mgCat);
    setComposerOpen(true);
  };

  const startRename = (m: MenuItemT) => {
    setEditingNameId(m.id);
    setNameEdits((prev) => ({ ...prev, [m.id]: m.name }));
  };

  const cancelRename = (id: string) => {
    setEditingNameId(null);
    setNameEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const saveName = async (m: MenuItemT) => {
    const raw = (nameEdits[m.id] ?? "").trim();
    cancelRename(m.id);
    if (!raw || raw === m.name) return;
    try {
      await api(`/api/menu/${m.id}`, { method: "PATCH", body: JSON.stringify({ name: raw }) });
      toast({ title: "Dish renamed", description: `${m.name} → ${raw}` });
      loadMenu();
    } catch (e) {
      toast({ title: "Rename failed", description: errMsg(e), variant: "destructive" });
    }
  };

  const toggleAvailable = async (m: MenuItemT, available: boolean) => {
    try {
      await api(`/api/menu/${m.id}`, { method: "PATCH", body: JSON.stringify({ available }) });
      loadMenu();
    } catch (e) {
      toast({ title: "Could not update availability", description: errMsg(e), variant: "destructive" });
    }
  };

  const savePrice = async (m: MenuItemT) => {
    const raw = priceEdits[m.id];
    if (raw === undefined) return;
    const p = Number(raw);
    setPriceEdits((prev) => {
      const next = { ...prev };
      delete next[m.id];
      return next;
    });
    if (!Number.isFinite(p) || p <= 0 || p === m.price) return;
    try {
      await api(`/api/menu/${m.id}`, { method: "PATCH", body: JSON.stringify({ price: p }) });
      toast({ title: `${m.name} price updated to ${inr(p)}` });
      loadMenu();
    } catch (e) {
      toast({ title: "Price update failed", description: errMsg(e), variant: "destructive" });
    }
  };

  const deleteMenuItem = async (m: MenuItemT) => {
    if (!window.confirm(`Delete "${m.name}" from the menu?`)) return;
    try {
      await api(`/api/menu/${m.id}`, { method: "DELETE" });
      toast({ title: `${m.name} removed` });
      loadMenu();
    } catch (e) {
      toast({ title: "Delete failed", description: errMsg(e), variant: "destructive" });
    }
  };

  // ── Menu item images ──
  const openPicker = (target: string) => {
    setPickingFor(target);
    const el = fileInputRef.current;
    if (el) {
      el.value = "";
      el.click();
    }
  };

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const target = pickingFor;
    const file = e.target.files?.[0];
    setPickingFor(null);
    if (!file || !target) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Please choose an image file", variant: "destructive" });
      return;
    }
    setImageBusy(true);
    try {
      const url = await uploadImageFile(file);
      if (target === "new") {
        setNewImageUrl(url);
      } else {
        await api(`/api/menu/${target}`, { method: "PATCH", body: JSON.stringify({ imageUrl: url }) });
        toast({ title: "Photo updated" });
        loadMenu();
      }
    } catch (err) {
      toast({ title: "Image upload failed", description: errMsg(err), variant: "destructive" });
    } finally {
      setImageBusy(false);
    }
  };

  const removeItemImage = async (m: MenuItemT) => {
    setImageBusy(true);
    try {
      await api(`/api/menu/${m.id}`, { method: "PATCH", body: JSON.stringify({ imageUrl: "" }) });
      toast({ title: "Photo removed" });
      loadMenu();
    } catch (e) {
      toast({ title: "Could not remove photo", description: errMsg(e), variant: "destructive" });
    } finally {
      setImageBusy(false);
    }
  };

  // ── Render ──
  return (
    <div className="space-y-4">
      <style>{`@media print { body * { visibility: hidden !important; } #kot-print, #kot-print * , #kot-print-detail, #kot-print-detail *, #pos-bill-print, #pos-bill-print *, #pos-day-print, #pos-day-print * { visibility: visible !important; } #kot-print, #kot-print-detail, #pos-bill-print, #pos-day-print { position: fixed; inset: 0; padding: 24px; background: #fff; z-index: 9999; } }`}</style>

      <div className="grid xl:grid-cols-3 gap-4 items-start">
        {/* ── Left: menu ── */}
        <div className="xl:col-span-2">
          <div className="panel flex flex-col xl:h-[calc(100vh-11rem)]">
            <div className="panel-header flex-wrap shrink-0">
              <div className="flex items-center gap-3">
                <p className="panel-title">Menu</p>
                <span className="text-xs text-muted-ink">{visibleItems.length} items</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-ink" />
                  <input
                    className="field w-44 sm:w-56 pl-8"
                    placeholder="Search dishes…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
                {canManage && (
                  <button className="btn-outline h-9" onClick={() => setManageOpen(true)}>
                    <ChefHat className="h-4 w-4" /> Manage
                  </button>
                )}
              </div>
            </div>

            <div className="px-3 pt-3 shrink-0">
              <Tabs value={cat} onValueChange={setCat}>
                <TabsList className="flex-wrap h-auto">
                  {CATEGORY_TABS.map((c) => (
                    <TabsTrigger key={c.key} value={c.key} className="min-h-9 px-3">
                      {c.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto scroll-slim p-3 max-h-[62vh] xl:max-h-none">
              {visibleItems.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-ink">No dishes match this filter.</p>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2.5">
                  {visibleItems.map((m) => {
                    const qty = cartQty(m.id);
                    return (
                      <button
                        key={m.id}
                        onClick={() => addToCart(m)}
                        disabled={!m.available}
                        className={cn(
                          "panel p-3 h-auto text-left w-full transition active:scale-[.98] hover:border-brass/60",
                          !m.available && "opacity-50 hover:border-line cursor-not-allowed"
                        )}
                      >
                        <div className="flex items-start gap-2.5">
                          {m.imageUrl ? (
                            <span className="shrink-0">
                              <img
                                src={m.imageUrl}
                                alt=""
                                className="h-14 w-14 rounded-lg object-cover border border-line"
                              />
                            </span>
                          ) : null}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-1.5">
                              <span className="flex items-center gap-1.5 min-w-0">
                                <VegDot isVeg={m.isVeg} />
                                <span className="text-sm font-medium text-ink truncate">{m.name}</span>
                              </span>
                              {!m.available && (
                                <span className="badge border-danger/30 bg-danger/10 text-danger shrink-0">Sold out</span>
                              )}
                            </div>
                            {m.description && (
                              <p className="text-xs text-muted-ink mt-1 line-clamp-2">{m.description}</p>
                            )}
                            <div className="flex items-center justify-between mt-2">
                              <span className="font-display font-semibold text-pine">{inr(m.price)}</span>
                              {qty > 0 && (
                                <span className="badge border-pine-700/30 bg-pine-100 text-pine-700">{qty} in cart</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── Right: cart ── */}
        <div className="xl:sticky xl:top-4">
          <div className="panel">
            <div className="panel-header">
              <p className="panel-title">Current Order</p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-ink">
                  {cart.reduce((s, l) => s + l.qty, 0)} items
                </span>
                {cart.length > 0 && (
                  <button className="btn-ghost h-8 px-2 text-xs" onClick={() => setCart([])}>
                    <X className="h-3.5 w-3.5" /> Clear
                  </button>
                )}
              </div>
            </div>

            <div className="p-3 space-y-3">
              {/* Order type segmented control */}
              <div className="grid grid-cols-3 gap-2">
                {ORDER_TYPES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setOrderType(t.key)}
                    className={cn(
                      "flex flex-col items-center justify-center gap-1 rounded-md border py-2.5 transition active:scale-[.98]",
                      orderType === t.key
                        ? "border-pine-700 bg-pine-700 text-panel"
                        : "border-line-strong bg-panel text-pine-700 hover:bg-plaster-deep/50"
                    )}
                  >
                    <t.icon className="h-5 w-5" />
                    <span className="text-[11px] font-medium leading-none">{t.label}</span>
                  </button>
                ))}
              </div>

              {orderType === "dine_in" && (
                <div>
                  <label className="field-label">Table number</label>
                  <input
                    className="field h-10"
                    placeholder="e.g. T12"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                  />
                </div>
              )}

              {orderType === "room_service" && (
                <div className="space-y-1.5">
                  <div>
                    <label className="field-label">Room (in-house guest)</label>
                    <Select value={reservationId} onValueChange={setReservationId}>
                      <SelectTrigger className="w-full h-10">
                        <SelectValue placeholder={inhouse.length ? "Select room" : "No in-house guests"} />
                      </SelectTrigger>
                      <SelectContent>
                        {inhouse.map((g) => (
                          <SelectItem key={g.reservationId} value={g.reservationId}>
                            {g.roomNumber} — {g.guestName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {selectedGuest && (
                    <p className="text-xs font-medium text-ok">
                      Bills to Room {selectedGuest.roomNumber} · {selectedGuest.guestName} (folio)
                    </p>
                  )}
                </div>
              )}

              {orderType === "takeaway" && (
                <div>
                  <label className="field-label">Guest name</label>
                  <input
                    className="field h-10"
                    placeholder="Walk-in guest"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                  />
                </div>
              )}

              {/* Cart lines — capped so Totals + Send stay on screen for long orders */}
              <div className="divide-y divide-line border-y border-line max-h-[300px] overflow-y-auto scroll-slim">
                {cart.length === 0 && (
                  <p className="py-6 text-center text-sm text-muted-ink">
                    Tap menu items to build the order.
                  </p>
                )}
                {cart.map((l) => (
                  <div key={l.menuItemId} className="py-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-1.5 min-w-0">
                        <VegDot isVeg={l.isVeg} />
                        <span className="text-sm font-medium text-ink truncate">{l.name}</span>
                      </span>
                      <span className="text-sm font-semibold text-pine shrink-0">
                        {inr(l.price * l.qty)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        <button
                          className="btn-outline h-9 w-9 px-0"
                          onClick={() => changeQty(l.menuItemId, -1)}
                          aria-label={`Remove one ${l.name}`}
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="w-8 text-center text-sm font-semibold">{l.qty}</span>
                        <button
                          className="btn-outline h-9 w-9 px-0"
                          onClick={() => changeQty(l.menuItemId, 1)}
                          aria-label={`Add one ${l.name}`}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>
                      <input
                        className="field h-9 flex-1 min-w-0"
                        placeholder="Note (e.g. less spicy)"
                        value={l.notes}
                        onChange={(e) => setNote(l.menuItemId, e.target.value)}
                      />
                    </div>
                  </div>
                ))}
              </div>

              {/* Order-level discount — GST is charged on the discounted taxable value */}
              <div className="rounded-md border border-line bg-plaster/40 p-2 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">
                    Discount (before GST)
                  </p>
                  {totals.discountAmount > 0 && (
                    <span className="badge border-danger/30 bg-danger/10 px-1.5 py-0 text-[10px] text-danger">
                      −{inr(totals.discountAmount, { decimals: true })}
                    </span>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <Select value={discMode} onValueChange={(v) => setDiscMode(v as "none" | "percent" | "flat")}>
                    <SelectTrigger className="h-9 w-[108px]" aria-label="Discount type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">None</SelectItem>
                      <SelectItem value="percent">% off</SelectItem>
                      <SelectItem value="flat">Flat ₹</SelectItem>
                    </SelectContent>
                  </Select>
                  <input
                    className="field h-9 flex-1 disabled:opacity-50"
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder={discMode === "percent" ? "e.g. 10" : discMode === "flat" ? "e.g. 100" : "—"}
                    disabled={discMode === "none"}
                    value={discValue}
                    onChange={(e) => setDiscValue(e.target.value)}
                    aria-label="Discount value"
                  />
                </div>
                <p className="text-[10px] leading-snug text-muted-ink">
                  GST is charged on the discounted taxable value (CGST §15).
                </p>
              </div>

              {/* Totals — official GST marking: taxable → CGST 2.5% + SGST 2.5% */}
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">Gross amount</span>
                  <span className="font-medium">{inr(totals.subtotal, { decimals: true })}</span>
                </div>
                {totals.discountAmount > 0 && (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-ink">{discountLabel(discMode, Number(discValue) || 0)}</span>
                    <span className="font-medium text-danger">−{inr(totals.discountAmount, { decimals: true })}</span>
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">Taxable value</span>
                  <span className="font-medium">{inr(totals.taxable, { decimals: true })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">
                    {cartRate === null ? "CGST" : `CGST @ ${cartRate / 2}%`}
                  </span>
                  <span className="font-medium">{inr(splitHalf(totals.tax), { decimals: true })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">
                    {cartRate === null ? "SGST" : `SGST @ ${cartRate / 2}%`}
                  </span>
                  <span className="font-medium">{inr(totals.tax - splitHalf(totals.tax), { decimals: true })}</span>
                </div>
                <div className="flex items-center justify-between border-t border-line pt-1.5 mt-1.5">
                  <span className="font-display font-semibold text-pine">Total</span>
                  <span className="font-display font-semibold text-pine text-xl">
                    {inr(totals.total, { decimals: true })}
                  </span>
                </div>
              </div>

              <button
                className="btn-pine w-full h-11 text-base"
                disabled={cart.length === 0 || sending}
                onClick={sendToKitchen}
              >
                <Send className="h-4 w-4" /> {sending ? "Sending…" : "Send to Kitchen"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Today's orders ── */}
      <div className="panel">
        <div className="panel-header">
          <div className="flex items-center gap-3">
            <p className="panel-title">Today&apos;s Orders</p>
            <span className="text-xs text-muted-ink">
              {fmtDateShort(new Date())} · {orders.length} order{orders.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button className="btn-outline h-8 text-xs" onClick={() => setDayOpen(true)}>
              <Calculator className="h-3.5 w-3.5" /> Day Summary
            </button>
            <button className="btn-ghost h-8 text-xs" onClick={loadOrders}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
          </div>
        </div>
        <div className="overflow-x-auto max-h-[440px] overflow-y-auto scroll-slim">
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr>
                <th className="th">Order</th>
                <th className="th">Type</th>
                <th className="th">Items</th>
                <th className="th text-right">Total</th>
                <th className="th">Status</th>
                <th className="th">Payment</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 && (
                <tr>
                  <td className="td text-center text-muted-ink" colSpan={7}>
                    No orders yet today.
                  </td>
                </tr>
              )}
              {orders.map((o) => {
                const next = NEXT_STATUS[o.status];
                const itemCount = o.items.reduce((s, i) => s + i.qty, 0);
                const readyCount = o.items.filter((i) => i.status === "ready" || i.status === "served").length;
                const cooking = readyCount > 0 && readyCount < o.items.length;
                return (
                  <tr
                    key={o.id}
                    className="cursor-pointer transition hover:bg-plaster-deep/40"
                    onClick={() => setDetailId(o.id)}
                    title="Open order details"
                  >
                    <td className="td">
                      <p className="font-medium text-pine underline-offset-2 hover:underline">{o.orderNumber}</p>
                      <p className="text-xs text-muted-ink">{fmtTime(o.createdAt)}</p>
                    </td>
                    <td className="td"><TypeCell o={o} /></td>
                    <td className="td">
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <span>{itemCount}</span>
                        {o.status !== "cancelled" && o.items.length > 0 && (
                          <span
                            className={cn(
                              "badge px-1.5 py-0 text-[10px]",
                              readyCount === o.items.length
                                ? "border-ok/40 bg-ok/10 text-ok"
                                : cooking
                                  ? "border-brass/40 bg-brass-50 text-brass"
                                  : "border-line-strong bg-plaster text-muted-ink"
                            )}
                            title="Items ready / total"
                          >
                            {readyCount}/{o.items.length} ready
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="td text-right font-medium whitespace-nowrap">
                      {inr(o.totalAmount, { decimals: true })}
                    </td>
                    <td className="td">
                      <span className={cn("badge", STATUS_BADGE[o.status])}>
                        {STATUS_LABELS[o.status] ?? o.status}
                      </span>
                    </td>
                    <td className="td">
                      <span className={cn("badge", PAY_BADGE[o.paymentStatus])}>
                        {STATUS_LABELS[o.paymentStatus] ?? o.paymentStatus}
                      </span>
                    </td>
                    <td className="td" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
                        <button
                          className="btn-ghost h-9 w-9 px-0 text-pine-700"
                          title="Open order details"
                          aria-label={`Open details for ${o.orderNumber}`}
                          onClick={() => setDetailId(o.id)}
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          className="btn-ghost h-9 w-9 px-0 text-brass"
                          title="Guest tax invoice (official GST bill)"
                          aria-label={`Open GST bill for ${o.orderNumber}`}
                          onClick={() => setBillOrderId(o.id)}
                        >
                          <ReceiptText className="h-4 w-4" />
                        </button>
                        {o.status !== "cancelled" && o.items.length > 0 && (
                          <button
                            className="btn-ghost h-9 w-9 px-0 text-pine-700"
                            title="Reorder — pull items back into the cart"
                            aria-label={`Reorder ${o.orderNumber}`}
                            onClick={() => reorder(o)}
                          >
                            <Repeat className="h-4 w-4" />
                          </button>
                        )}
                        {o.paymentStatus === "unpaid" && (
                          <button
                            className="btn-brass h-9 px-3 text-xs"
                            onClick={() => setSettleTarget(o)}
                          >
                            <Wallet className="h-3.5 w-3.5" /> Settle
                          </button>
                        )}
                        {o.paymentStatus === "unpaid" && o.orderType === "room_service" && o.reservationId && (
                          <button
                            className="btn-outline h-9 px-3 text-xs"
                            disabled={postingId === o.id}
                            onClick={() => doPostFolio(o)}
                          >
                            <ConciergeBell className="h-3.5 w-3.5" /> Post to Folio
                          </button>
                        )}
                        {next && (
                          <button className="btn-pine h-9 px-3 text-xs" onClick={() => advance(o)}>
                            {NEXT_LABEL[o.status]}
                          </button>
                        )}
                        {(o.status === "pending" || o.status === "preparing") && o.paymentStatus === "unpaid" && (
                          <button
                            className="btn-ghost h-9 w-9 px-0 text-danger"
                            title="Cancel order"
                            onClick={() => cancelOrder(o)}
                          >
                            <X className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── KOT success dialog ── */}
      <Dialog open={!!successOrder} onOpenChange={(open) => !open && setSuccessOrder(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-ok" /> Order sent to kitchen
            </DialogTitle>
            <DialogDescription>
              KOT printed to the kitchen display. Settle or post to the room folio below.
              {successKotNote && (
                <span className="mt-1 flex items-center gap-1.5 text-ok">
                  <Check className="h-3.5 w-3.5" /> {successKotNote}
                </span>
              )}
            </DialogDescription>
          </DialogHeader>

          {successOrder && (
            <>
              <KotReceipt id="kot-print" order={successOrder} propertyName={propertyName} />

              <div className="grid grid-cols-2 gap-2">
                <button className="btn-outline h-10" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Print KOT
                </button>
                {successOrder.paymentStatus === "unpaid" ? (
                  <button
                    className="btn-pine h-10"
                    onClick={() => {
                      setSettleTarget(successOrder);
                      setSuccessOrder(null);
                    }}
                  >
                    <Wallet className="h-4 w-4" /> Settle now
                  </button>
                ) : (
                  <span className="btn-ghost h-10 pointer-events-none">{STATUS_LABELS[successOrder.paymentStatus]}</span>
                )}
                {successOrder.orderType === "room_service" && successOrder.paymentStatus === "unpaid" && (
                  <button
                    className="btn-brass h-10"
                    disabled={postingId === successOrder.id}
                    onClick={() => doPostFolio(successOrder)}
                  >
                    <ConciergeBell className="h-4 w-4" /> Post to Folio
                  </button>
                )}
                <button className="btn-ghost h-10" onClick={() => setSuccessOrder(null)}>
                  Close
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Settle dialog ── */}
      <Dialog open={!!settleTarget} onOpenChange={(open) => !open && setSettleTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Settle order {settleTarget?.orderNumber}</DialogTitle>
            <DialogDescription>Receive direct payment — the order completes immediately.</DialogDescription>
          </DialogHeader>
          <p className="font-display text-3xl font-semibold text-pine text-center">
            {inr(settleTarget?.totalAmount ?? 0, { decimals: true })}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { key: "cash", label: "Cash", icon: Banknote },
              { key: "upi", label: "UPI", icon: Smartphone },
              { key: "card", label: "Card", icon: CreditCard },
            ].map((m) => (
              <button
                key={m.key}
                className="btn-outline h-16 flex-col gap-1"
                onClick={() => doSettle(m.key)}
              >
                <m.icon className="h-5 w-5" />
                <span className="text-xs">{m.label}</span>
              </button>
            ))}
          </div>
          {gateways.length > 0 && (
            <div className="space-y-1.5">
              <p className="field-label">Online — via your payment gateway</p>
              <div className="grid gap-2">
                {gateways.map((g) => (
                  <button
                    key={g.id}
                    className="btn-outline h-11 justify-start px-3"
                    title={`${g.mode === "live" ? "Live" : "Test"} mode · configured by the platform owner`}
                    onClick={() => doSettle(g.provider)}
                  >
                    <CreditCard className="h-4 w-4 text-brass" />
                    <span className="text-sm">Pay via {g.label || gatewayLabel(g.provider)}</span>
                    <span
                      className={cn(
                        "badge ml-auto px-1.5 py-0 text-[10px]",
                        g.mode === "live" ? "border-ok/40 bg-ok/10 text-ok" : "border-warn/40 bg-warn/10 text-warn"
                      )}
                    >
                      {g.mode}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Order detail dialog — inspect the KOT & drive it from this terminal ── */}
      <Dialog open={!!detailOrder} onOpenChange={(open) => !open && setDetailId(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto scroll-slim sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              <ReceiptText className="h-5 w-5 text-brass" />
              Order {detailOrder?.orderNumber}
              {detailOrder && (
                <span className={cn("badge", STATUS_BADGE[detailOrder.status])}>
                  {STATUS_LABELS[detailOrder.status] ?? detailOrder.status}
                </span>
              )}
              {detailOrder && (
                <span className={cn("badge", PAY_BADGE[detailOrder.paymentStatus])}>
                  {STATUS_LABELS[detailOrder.paymentStatus] ?? detailOrder.paymentStatus}
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              {detailOrder && (
                <>
                  {fmtTime(detailOrder.createdAt)} ·{" "}
                  {detailOrder.orderType === "dine_in"
                    ? `Table ${detailOrder.tableNumber || "—"}`
                    : detailOrder.orderType === "room_service"
                      ? `Room ${detailOrder.roomNumber}`
                      : "Takeaway"}
                  {detailOrder.guestName ? ` · ${detailOrder.guestName}` : ""}
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {detailOrder && (
            <div className="space-y-3">
              {/* KOT items with live status — tap a chip to advance it */}
              <div className="rounded-md border border-line bg-panel">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-ink">
                    Kitchen ticket — items
                  </p>
                  <span className="text-[11px] text-muted-ink">tap a status to advance</span>
                </div>
                <ul className="divide-y divide-line">
                  {detailOrder.items.map((it) => (
                    <li key={it.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="leading-snug">
                          <span className="font-bold text-pine">{it.qty}×</span> <span className="text-sm text-ink">{it.name}</span>
                        </p>
                        {it.notes && <p className="truncate text-xs font-medium text-warn">↳ {it.notes}</p>}
                      </div>
                      {canManage ? (
                        <KotItemChip item={it} busy={itemBusyId === it.id} onClick={() => advanceOrderItem(it)} />
                      ) : (
                        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold", KOT_ITEM_CHIP[it.status])}>
                          {STATUS_LABELS[it.status] ?? it.status}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Bill breakdown — official GST marking: taxable → CGST + SGST */}
              <div className="rounded-md border border-line bg-plaster/40 px-3 py-2.5 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-ink">Gross amount</span>
                  <span>{inr(detailOrder.subtotal, { decimals: true })}</span>
                </div>
                {detailOrder.discountAmount > 0 && (
                  <div className="flex justify-between">
                    <span className="text-muted-ink">{discountLabel(detailOrder.discountMode, detailOrder.discountValue)}</span>
                    <span className="text-danger">−{inr(detailOrder.discountAmount, { decimals: true })}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-ink">Taxable value</span>
                  <span>{inr(detailOrder.subtotal - detailOrder.discountAmount, { decimals: true })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-ink">{cgstLabel(detailOrder)}</span>
                  <span>{inr(splitHalf(detailOrder.taxAmount), { decimals: true })}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-ink">{sgstLabel(detailOrder)}</span>
                  <span>{inr(detailOrder.taxAmount - splitHalf(detailOrder.taxAmount), { decimals: true })}</span>
                </div>
                <div className="flex justify-between border-t border-line pt-1.5 font-semibold text-pine">
                  <span>Total</span>
                  <span className="font-display text-lg">{inr(detailOrder.totalAmount, { decimals: true })}</span>
                </div>
                {detailOrder.paymentStatus !== "unpaid" && (
                  <p className="text-xs text-muted-ink pt-0.5">
                    Payment: <b className="uppercase text-ink">{detailOrder.paymentMethod || "—"}</b>
                  </p>
                )}
              </div>

              {/* KOT receipt (printable) */}
              <KotReceipt id="kot-print-detail" order={detailOrder} propertyName={propertyName} />

              {/* Kitchen + billing actions */}
              <div className="grid grid-cols-2 gap-2">
                {canManage && (
                  <button
                    type="button"
                    className="btn-outline h-10 text-[13px]"
                    disabled={detailBusy || detailOrder.items.every((i) => i.status === "served")}
                    onClick={() => detailAllReady(detailOrder)}
                  >
                    <Bell className="h-4 w-4" /> All ready
                  </button>
                )}
                {canManage && (
                  <button
                    type="button"
                    className="btn-pine h-10 text-[13px]"
                    disabled={detailBusy || !detailOrder.items.every((i) => i.status === "ready" || i.status === "served")}
                    title={detailOrder.items.every((i) => i.status === "ready" || i.status === "served") ? "Mark the whole order served" : "All items must be ready first"}
                    onClick={() => detailServed(detailOrder)}
                  >
                    <Check className="h-4 w-4" /> Mark served
                  </button>
                )}
                <button className="btn-outline h-10" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Print KOT
                </button>
                <button
                  className="btn-brass h-10"
                  onClick={() => {
                    setBillOrderId(detailOrder.id);
                    setDetailId(null);
                  }}
                >
                  <ReceiptText className="h-4 w-4" /> Guest Bill
                </button>
                {detailOrder.status !== "cancelled" && detailOrder.items.length > 0 && (
                  <button className="btn-outline h-10" onClick={() => reorder(detailOrder)}>
                    <Repeat className="h-4 w-4" /> Reorder
                  </button>
                )}
                {detailOrder.paymentStatus === "unpaid" && (
                  <button
                    className="btn-brass h-10"
                    onClick={() => {
                      setSettleTarget(detailOrder);
                      setDetailId(null);
                    }}
                  >
                    <Wallet className="h-4 w-4" /> Settle payment
                  </button>
                )}
                {detailOrder.paymentStatus === "unpaid" && detailOrder.orderType === "room_service" && detailOrder.reservationId && (
                  <button
                    className="btn-brass h-10"
                    disabled={postingId === detailOrder.id}
                    onClick={() => doPostFolio(detailOrder)}
                  >
                    <ConciergeBell className="h-4 w-4" /> Post to Folio
                  </button>
                )}
                {NEXT_STATUS[detailOrder.status] && (
                  <button className="btn-pine h-10" onClick={() => advance(detailOrder)}>
                    {NEXT_LABEL[detailOrder.status]}
                  </button>
                )}
                <button className="btn-ghost h-10" onClick={() => setDetailId(null)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Guest Bill — official restaurant tax invoice (same GST marking as folio invoices) ── */}
      <Dialog open={!!billOrder} onOpenChange={(open) => !open && setBillOrderId(null)}>
        <DialogContent className="max-h-[92vh] overflow-y-auto scroll-slim sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ReceiptText className="h-5 w-5 text-brass" /> Guest Bill — Tax Invoice
            </DialogTitle>
            <DialogDescription>
              Official GST format — taxable value, CGST 2.5% + SGST 2.5%, amount in words. Print or download for the guest.
            </DialogDescription>
          </DialogHeader>

          {bill && (
            <>
              <div id="pos-bill-print" className="rounded-md border border-line bg-panel p-4 font-mono text-[13px] space-y-3">
                {/* Header */}
                <div className="text-center space-y-0.5">
                  <p className="font-display text-base font-bold uppercase tracking-[0.14em] text-pine">
                    {bill.hotel.name || "Restaurant"}
                  </p>
                  <p className="text-[10px] text-muted-ink leading-snug">
                    {bill.hotel.address}
                    {bill.hotel.address ? ", " : ""}
                    {bill.hotel.city}
                    <br />
                    GSTIN: <b className="text-ink">{bill.hotel.gstin || "—"}</b>
                    {bill.hotel.phone ? ` · ${bill.hotel.phone}` : ""}
                  </p>
                  <p className="pt-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-brass">Tax Invoice</p>
                  <p className="font-display text-2xl font-bold text-pine tracking-wide">{bill.billNo}</p>
                  <p className="text-[11px] text-muted-ink">
                    {fmtDate(bill.date)} · {bill.orderType === "dine_in" ? `Table ${bill.tableNumber || "—"}` : bill.orderType === "room_service" ? `Room ${bill.roomNumber || "—"}` : "Takeaway"}
                    {bill.guestName ? ` · ${bill.guestName}` : ""}
                  </p>
                  <p className="text-[10px] text-muted-ink">
                    Place of Supply: {bill.hotel.state || bill.hotel.city || "—"}
                  </p>
                </div>

                {/* Items */}
                <div className="border-t border-dashed border-line-strong pt-2">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wider text-muted-ink">
                        <th className="py-1 text-left font-semibold">#</th>
                        <th className="py-1 text-left font-semibold">Item</th>
                        <th className="py-1 text-right font-semibold">Qty</th>
                        <th className="py-1 text-right font-semibold">Rate</th>
                        <th className="py-1 text-right font-semibold">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bill.items.map((it, idx) => (
                        <tr key={idx} className="border-t border-line/70 align-top">
                          <td className="py-1.5 text-muted-ink">{idx + 1}</td>
                          <td className="py-1.5">
                            {it.name}
                            {it.notes && <span className="block text-[10px] font-medium text-warn italic">↳ {it.notes}</span>}
                          </td>
                          <td className="py-1.5 text-right">{it.qty}</td>
                          <td className="py-1.5 text-right">{money2(it.price)}</td>
                          <td className="py-1.5 text-right">{money2(it.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* GST summary + totals */}
                <div className="border-t border-dashed border-line-strong pt-2 space-y-1">
                  <div className="flex justify-between">
                    <span className="text-muted-ink">Gross amount</span>
                    <span>{money2(bill.subtotal)}</span>
                  </div>
                  {bill.discountAmount > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-ink">{discountLabel(bill.discountMode, bill.discountValue)}</span>
                      <span className="text-danger">−{money2(bill.discountAmount)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-ink">Taxable value</span>
                    <span>{money2(bill.subtotal - bill.discountAmount)}</span>
                  </div>
                  {posRateBreakup(bill.items, bill.discountAmount).map((r) => (
                    <div key={r.gstRate} className="flex justify-between text-[11px] text-muted-ink">
                      <span>
                        CGST @ {r.gstRate / 2}% + SGST @ {r.gstRate / 2}%
                      </span>
                      <span>
                        {money2(splitHalf(r.tax))} + {money2(r.tax - splitHalf(r.tax))} = {money2(r.tax)}
                      </span>
                    </div>
                  ))}
                  <div className="flex justify-between">
                    <span className="text-muted-ink">Total GST (CGST + SGST)</span>
                    <span>{money2(bill.taxAmount)}</span>
                  </div>
                  <div className="flex justify-between border-t border-line pt-1.5">
                    <span className="uppercase tracking-wider">Grand Total</span>
                    <span className="font-bold text-pine">{money2(bill.totalAmount)}</span>
                  </div>
                  <div className="flex justify-between text-[11px] text-muted-ink">
                    <span>Payment</span>
                    <span className={bill.paymentStatus === "unpaid" ? "font-semibold uppercase text-danger" : "uppercase text-ink"}>
                      {bill.paymentStatus === "unpaid"
                        ? "DUE"
                        : bill.paymentStatus === "posted_to_folio"
                          ? "Room Folio"
                          : bill.paymentMethod || "Paid"}
                    </span>
                  </div>
                </div>

                <p className="border-t border-dashed border-line-strong pt-2 text-[11px] italic text-muted-ink">
                  <b className="not-italic">Amount in words:</b> {amountInWordsINR(bill.totalAmount)}
                </p>

                <div className="border-t border-line pt-2 text-center">
                  <p className="text-[10px] text-muted-ink">
                    Declaration: This invoice shows the actual price of the food &amp; beverages served. GST is charged on
                    the discounted taxable value. Computer-generated bill.
                  </p>
                  <p className="mt-2 text-[11px] font-semibold text-pine">For {bill.hotel.name || "Restaurant"}</p>
                  <p className="mt-4 border-t border-line pt-1 text-[9px] uppercase tracking-[0.2em] text-muted-ink">
                    Authorised Signatory
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <button className="btn-outline h-10" onClick={() => window.print()}>
                  <Printer className="h-4 w-4" /> Print Bill
                </button>
                <button className="btn-pine h-10" onClick={downloadBill}>
                  <Download className="h-4 w-4" /> Download HTML
                </button>
                {bill.paymentStatus === "unpaid" && (
                  <button
                    className="btn-brass h-10"
                    onClick={() => {
                      setSettleTarget(billOrder);
                      setBillOrderId(null);
                    }}
                  >
                    <Wallet className="h-4 w-4" /> Settle Payment
                  </button>
                )}
                <button className="btn-ghost h-10" onClick={() => setBillOrderId(null)}>
                  Close
                </button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Day sales summary — Z-report with GST collection split ── */}
      <Dialog open={dayOpen} onOpenChange={setDayOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto scroll-slim sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Calculator className="h-5 w-5 text-brass" /> Day Sales Summary
            </DialogTitle>
            <DialogDescription>Z-report — today&apos;s non-cancelled POS orders with the GST collected.</DialogDescription>
          </DialogHeader>

          <div id="pos-day-print" className="rounded-md border border-line bg-panel p-4 font-mono text-[13px] space-y-2">
            <div className="text-center space-y-0.5">
              <p className="font-display text-sm font-bold uppercase tracking-[0.14em] text-pine">
                {hotel.name || propertyName || "Restaurant"}
              </p>
              <p className="text-[10px] font-semibold uppercase tracking-[0.3em] text-brass">Day Sales Summary (Z-Report)</p>
              <p className="text-[11px] text-muted-ink">
                {fmtDate(new Date())} · GSTIN {hotel.gstin || "—"}
              </p>
            </div>
            <div className="border-t border-dashed border-line-strong pt-2 space-y-1">
              <div className="flex justify-between">
                <span className="text-muted-ink">Orders</span>
                <span>{dayStats.count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-ink">Gross amount</span>
                <span>{money2(dayStats.gross)}</span>
              </div>
              {dayStats.discount > 0 && (
                <div className="flex justify-between">
                  <span className="text-muted-ink">Discounts given</span>
                  <span className="text-danger">−{money2(dayStats.discount)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-muted-ink">Taxable value</span>
                <span>{money2(dayStats.taxable)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-ink">CGST collected</span>
                <span>{money2(splitHalf(dayStats.tax))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-ink">SGST collected</span>
                <span>{money2(dayStats.tax - splitHalf(dayStats.tax))}</span>
              </div>
              <div className="flex justify-between border-t border-line pt-1.5">
                <span className="uppercase tracking-wider">Net sales (incl. GST)</span>
                <span className="font-bold text-pine">{money2(dayStats.net)}</span>
              </div>
            </div>
            <div className="border-t border-dashed border-line-strong pt-2">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-ink">Collections by method</p>
              {dayStats.byMethod.length === 0 ? (
                <p className="text-[11px] text-muted-ink">No settled payments yet today.</p>
              ) : (
                dayStats.byMethod.map(([m, amt]) => (
                  <div key={m} className="flex justify-between">
                    <span className="text-muted-ink">{m}</span>
                    <span>{money2(amt)}</span>
                  </div>
                ))
              )}
              {dayStats.unpaid > 0 && (
                <p className="pt-1 text-[11px] text-warn">{dayStats.unpaid} order(s) still unpaid / unsettled.</p>
              )}
            </div>
            <p className="border-t border-line pt-2 text-center text-[9px] uppercase tracking-[0.2em] text-muted-ink">
              Computer-generated report — Velurex HMS POS
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button className="btn-outline h-10" onClick={() => window.print()}>
              <Printer className="h-4 w-4" /> Print Report
            </button>
            <button className="btn-ghost h-10" onClick={() => setDayOpen(false)}>
              Close
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Menu management dialog — category rail + detail pane ── */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="flex max-h-[92vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="flex items-center gap-2">
              <ChefHat className="h-5 w-5 text-brass" /> Menu management
            </DialogTitle>
            <DialogDescription>
              Organize dishes by course — rename, edit prices, or mark items sold out.
            </DialogDescription>
          </DialogHeader>

          {/* Mobile: category chips */}
          <div
            className="md:hidden -mx-1 flex shrink-0 gap-1.5 overflow-x-auto px-1 pb-1 scroll-slim"
            role="tablist"
            aria-label="Filter by course"
          >
            {railItems.map((r) => {
              const Icon = CAT_ICONS[r.key] ?? Utensils;
              const active = mgCat === r.key;
              return (
                <button
                  key={r.key}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMgCat(r.key)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-medium transition",
                    active
                      ? "border-pine-700 bg-pine-700 text-panel"
                      : "border-line-strong bg-panel text-pine-700 hover:bg-plaster-deep/50"
                  )}
                >
                  <Icon className={cn("h-3.5 w-3.5", active ? "text-brass-light" : "text-brass")} />
                  {r.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-[10px] tabular-nums",
                      active ? "bg-white/15 text-panel" : "bg-plaster-deep/70 text-muted-ink"
                    )}
                  >
                    {r.total}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Scrollable middle — rail pins, pane scrolls */}
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto scroll-slim">
            <div className="md:grid md:grid-cols-[184px_1fr] md:items-start md:gap-4">
            {/* Desktop: category rail */}
            <nav
              className="hidden md:flex md:flex-col gap-0.5 border-r border-line pr-3 md:sticky md:top-1"
              aria-label="Menu courses"
            >
              {railItems.map((r) => {
                const Icon = CAT_ICONS[r.key] ?? Utensils;
                const active = mgCat === r.key;
                return (
                  <button
                    key={r.key}
                    type="button"
                    onClick={() => setMgCat(r.key)}
                    aria-current={active ? "true" : undefined}
                    title={r.soldOut > 0 ? `${r.total} dishes · ${r.soldOut} sold out` : `${r.total} dishes`}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-md px-2.5 py-2 text-sm transition",
                      active
                        ? "bg-pine-700 font-medium text-panel shadow-sm"
                        : "text-pine-700 hover:bg-plaster-deep/60"
                    )}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-brass-light" : "text-brass")} />
                      <span className="truncate">{r.label}</span>
                    </span>
                    <span
                      className={cn(
                        "rounded-full px-1.5 py-0.5 text-[11px] tabular-nums",
                        active ? "bg-white/15 text-panel" : "bg-plaster-deep/70 text-muted-ink"
                      )}
                    >
                      {r.total}
                    </span>
                  </button>
                );
              })}
              <div className="mt-2 space-y-1 border-t border-dashed border-line-strong px-2.5 pt-2">
                <p className="flex items-center gap-1.5 text-[11px] text-muted-ink">
                  <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                  {allStats.total - allStats.soldOut} live
                </p>
                {allStats.soldOut > 0 && (
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-ink">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                    {allStats.soldOut} sold out
                  </p>
                )}
              </div>
            </nav>

            {/* Detail pane */}
            <div className="min-w-0">
              <div className="mb-2.5 flex items-center gap-2">
                <div className="relative min-w-0 flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-ink" />
                  <input
                    className="field pl-8"
                    placeholder={mgCat === "all" ? "Search all dishes…" : `Search ${activeRail.label.toLowerCase()} dishes…`}
                    value={mgSearch}
                    onChange={(e) => setMgSearch(e.target.value)}
                    aria-label="Search dishes"
                  />
                </div>
                <button
                  type="button"
                  className={cn("h-9 shrink-0", composerOpen ? "btn-outline" : "btn-pine")}
                  onClick={() => (composerOpen ? setComposerOpen(false) : openComposer())}
                >
                  {composerOpen ? (
                    <>
                      <ChevronUp className="h-4 w-4" /> Close form
                    </>
                  ) : (
                    <>
                      <Plus className="h-4 w-4" /> New dish
                    </>
                  )}
                </button>
              </div>

              {/* Collapsible composer */}
              {composerOpen && (
                <div className="mb-3 space-y-2.5 rounded-lg border border-line bg-plaster/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-pine-700">
                      <Plus className="h-3.5 w-3.5 text-brass" /> New menu item
                    </p>
                    {mgCat !== "all" && (
                      <span className="text-[11px] text-muted-ink">
                        will be added to <span className="font-medium text-ink">{activeRail.label}</span>
                      </span>
                    )}
                  </div>
                  <div className="grid min-w-0 grid-cols-2 gap-2">
                    <div className="col-span-2 min-w-0">
                      <label className="field-label" htmlFor="new-dish-name">
                        Dish name
                      </label>
                      <input
                        id="new-dish-name"
                        className="field h-10"
                        placeholder="e.g. Paneer Tikka"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && addMenuItem()}
                        autoFocus
                      />
                    </div>
                    <div className="min-w-0">
                      <label className="field-label">Course</label>
                      <Select
                        value={newCat}
                        onValueChange={(v) => {
                          setNewCat(v);
                          setNewTax("5");
                        }}
                      >
                        <SelectTrigger className="h-10 w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CATEGORY_TABS.filter((c) => c.key !== "all").map((c) => (
                            <SelectItem key={c.key} value={c.key}>
                              {c.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="min-w-0">
                      <label className="field-label" htmlFor="new-dish-price">
                        Price
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-ink">₹</span>
                        <input
                          id="new-dish-price"
                          className="field h-10 pl-7"
                          type="number"
                          min="1"
                          placeholder="0"
                          value={newPrice}
                          onChange={(e) => setNewPrice(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addMenuItem()}
                        />
                      </div>
                    </div>
                    <div className="min-w-0">
                      <label className="field-label" htmlFor="new-dish-tax">
                        GST
                      </label>
                      <div className="relative">
                        <input
                          id="new-dish-tax"
                          className="field h-10 pr-7"
                          type="number"
                          min="0"
                          max="100"
                          value={newTax}
                          onChange={(e) => setNewTax(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && addMenuItem()}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-ink">
                          %
                        </span>
                      </div>
                      <p className="mt-1 text-[10px] leading-snug text-muted-ink">
                        Flat 5% — CGST 2.5% + SGST 2.5%. Override only for special slabs.
                      </p>
                    </div>
                    <div className="min-w-0">
                      <span className="field-label">Food type</span>
                      <div className="grid h-10 grid-cols-2 gap-1 rounded-md border border-line-strong bg-panel p-1">
                        <button
                          type="button"
                          onClick={() => setNewVeg(true)}
                          aria-pressed={newVeg}
                          className={cn(
                            "rounded border text-xs font-medium transition",
                            newVeg
                              ? "border-ok/40 bg-ok/15 text-ok"
                              : "border-transparent text-muted-ink hover:bg-plaster-deep/50"
                          )}
                        >
                          Veg
                        </button>
                        <button
                          type="button"
                          onClick={() => setNewVeg(false)}
                          aria-pressed={!newVeg}
                          className={cn(
                            "rounded border text-xs font-medium transition",
                            !newVeg
                              ? "border-danger/40 bg-danger/10 text-danger"
                              : "border-transparent text-muted-ink hover:bg-plaster-deep/50"
                          )}
                        >
                          Non-veg
                        </button>
                      </div>
                    </div>
                    <div className="col-span-2 min-w-0">
                      <label className="field-label" htmlFor="new-dish-desc">
                        Description <span className="normal-case text-muted-ink/70">(optional)</span>
                      </label>
                      <input
                        id="new-dish-desc"
                        className="field h-10"
                        placeholder="Short line shown on menus and bills"
                        value={newDesc}
                        onChange={(e) => setNewDesc(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && addMenuItem()}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      onClick={() => openPicker("new")}
                      disabled={imageBusy}
                      title="Add a food photo"
                      aria-label="Add a food photo"
                      className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-md border border-dashed border-line-strong text-muted-ink transition hover:border-brass hover:text-brass disabled:opacity-50"
                    >
                      {newImageUrl ? (
                        <img src={newImageUrl} alt="New dish photo preview" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex flex-col items-center gap-0.5">
                          <ImagePlus className="h-4 w-4" />
                          <span className="text-[9px] uppercase tracking-wider">Photo</span>
                        </span>
                      )}
                    </button>
                    <div className="min-h-10 min-w-40 flex-1 text-xs text-muted-ink">
                      <p>Food photo (optional) — compressed to ≤512px before upload.</p>
                      {newImageUrl && (
                        <button
                          type="button"
                          className="btn-ghost mt-1 h-7 px-2 text-danger hover:bg-danger/10"
                          onClick={() => setNewImageUrl("")}
                        >
                          <X className="h-3.5 w-3.5" /> Remove photo
                        </button>
                      )}
                      {imageBusy && pickingFor === "new" && <p className="mt-1 text-brass">Uploading…</p>}
                    </div>
                    <button type="button" className="btn-pine h-10 shrink-0" onClick={addMenuItem} disabled={imageBusy}>
                      <Plus className="h-4 w-4" /> Add item
                    </button>
                  </div>
                </div>
              )}

              {/* Item rows */}
              <div className="space-y-1.5" role="list" aria-label="Menu items">
                {mgItems.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-line-strong px-4 py-8 text-center">
                    {menu.length === 0 ? (
                      <>
                        <ChefHat className="mx-auto h-8 w-8 text-muted-ink/50" />
                        <p className="mt-2 text-sm font-medium text-ink">Your menu is empty</p>
                        <p className="mt-1 text-xs text-muted-ink">
                          Add your first dish — a name, price and course is all it takes.
                        </p>
                        {!composerOpen && (
                          <button type="button" className="btn-pine mt-3 h-9" onClick={openComposer}>
                            <Plus className="h-4 w-4" /> Add first dish
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <Search className="mx-auto h-8 w-8 text-muted-ink/50" />
                        <p className="mt-2 text-sm font-medium text-ink">No dishes match</p>
                        <p className="mt-1 text-xs text-muted-ink">Try a different search or course filter.</p>
                      </>
                    )}
                  </div>
                ) : (
                  mgItems.map((m) => (
                    <div
                      key={m.id}
                      role="listitem"
                      className={cn(
                        "flex items-center gap-2.5 rounded-lg border border-line bg-panel px-2.5 py-2 transition hover:border-brass/50",
                        !m.available && "opacity-60"
                      )}
                    >
                      <ItemThumb
                        name={m.name}
                        isVeg={m.isVeg}
                        imageUrl={m.imageUrl ?? ""}
                        busy={imageBusy}
                        onPick={() => openPicker(m.id)}
                        onRemove={m.imageUrl ? () => removeItemImage(m) : undefined}
                      />
                      <VegDot isVeg={m.isVeg} />
                      <div className="min-w-0 flex-1">
                        {editingNameId === m.id ? (
                          <input
                            autoFocus
                            className="field h-8"
                            value={nameEdits[m.id] ?? m.name}
                            onChange={(e) => setNameEdits((prev) => ({ ...prev, [m.id]: e.target.value }))}
                            onBlur={() => saveName(m)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                              if (e.key === "Escape") cancelRename(m.id);
                            }}
                            aria-label={`Rename ${m.name}`}
                          />
                        ) : (
                          <button
                            type="button"
                            onClick={() => startRename(m)}
                            title="Click to rename"
                            className="group/nm flex max-w-full items-center gap-1 text-left"
                          >
                            <span className="truncate text-sm font-medium text-ink">{m.name}</span>
                            <Pencil className="h-3 w-3 shrink-0 text-muted-ink opacity-0 transition group-hover/nm:opacity-70" />
                          </button>
                        )}
                        <div className="mt-0.5 flex items-center gap-1.5">
                          {mgCat === "all" && (
                            <span className="badge border-line bg-plaster-deep/40 text-[10px] uppercase tracking-wide text-muted-ink">
                              {m.category}
                            </span>
                          )}
                          {!m.available && (
                            <span className="badge border-warn/40 bg-warn/10 text-[10px] text-warn">Sold out</span>
                          )}
                          {m.description && (
                            <span className="hidden truncate text-[11px] text-muted-ink sm:inline">{m.description}</span>
                          )}
                        </div>
                      </div>
                      <div className="relative shrink-0">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-ink">₹</span>
                        <input
                          className="field h-9 w-20 pl-6 pr-2 text-right sm:w-24"
                          type="number"
                          min="1"
                          aria-label={`Price for ${m.name}`}
                          value={priceEdits[m.id] ?? String(m.price)}
                          onChange={(e) => setPriceEdits((prev) => ({ ...prev, [m.id]: e.target.value }))}
                          onBlur={() => savePrice(m)}
                          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                        />
                      </div>
                      <Switch
                        checked={m.available}
                        onCheckedChange={(v) => toggleAvailable(m, v)}
                        aria-label={`Toggle ${m.name} availability`}
                      />
                      {user?.role === "hotel_admin" && (
                        <button
                          className="btn-ghost h-9 w-9 shrink-0 px-0 text-danger"
                          title="Delete item"
                          aria-label={`Delete ${m.name}`}
                          onClick={() => deleteMenuItem(m)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
            </div>
          </div>

          {/* Footer summary */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-line pt-3">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-ink">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                <span className="font-medium text-ink">{allStats.total - allStats.soldOut}</span> live
              </span>
              <span className="text-line-strong">·</span>
              <span>{allStats.total} total</span>
              {allStats.soldOut > 0 && (
                <>
                  <span className="text-line-strong">·</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-warn" />
                    {allStats.soldOut} sold out
                  </span>
                </>
              )}
            </p>
            <button type="button" className="btn-pine h-9 px-6" onClick={() => setManageOpen(false)}>
              Done
            </button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Hidden image picker — shared by the new-item form and existing rows */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFilePicked}
        aria-hidden
        tabIndex={-1}
      />
    </div>
  );
}
