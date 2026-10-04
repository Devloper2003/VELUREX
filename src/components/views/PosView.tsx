"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api-client";
import { inr, fmtTime, fmtDateShort, STATUS_LABELS } from "@/lib/format";
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
  ChefHat,
  CheckCircle2,
  ConciergeBell,
  CreditCard,
  ImagePlus,
  Minus,
  Plus,
  Printer,
  RefreshCw,
  Search,
  Send,
  ShoppingBag,
  Smartphone,
  Trash2,
  Utensils,
  Wallet,
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
  taxAmount: number;
  totalAmount: number;
  paymentStatus: string;
  paymentMethod: string;
  reservationId: string | null;
  createdAt: string;
  items: OrderItemT[];
  reservation?: { guest?: { fullName: string }; room?: { number: string } } | null;
}

interface InhouseT {
  reservationId: string;
  guestName: string;
  roomNumber: string;
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

const NEXT_STATUS: Record<string, string> = { pending: "preparing", preparing: "served", served: "completed" };
const NEXT_LABEL: Record<string, string> = { pending: "Start prep", preparing: "Mark served", served: "Complete" };

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

  const [successOrder, setSuccessOrder] = useState<OrderT | null>(null);
  const [settleTarget, setSettleTarget] = useState<OrderT | null>(null);
  const [postingId, setPostingId] = useState<string | null>(null);

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

  useEffect(() => {
    loadMenu();
    loadInhouse();
  }, [loadMenu, loadInhouse]);

  useEffect(() => {
    loadOrders();
    const t = setInterval(loadOrders, 30000);
    return () => clearInterval(t);
  }, [loadOrders]);

  // Realtime: order status flips (kitchen screen, other terminals) land instantly.
  useRealtime((event) => {
    if (event === "kot:update") loadOrders();
  });

  // ── Derived ──
  const selectedGuest = inhouse.find((g) => g.reservationId === reservationId) ?? null;

  const visibleItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menu.filter(
      (m) =>
        (cat === "all" || m.category === cat) &&
        (q === "" || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
    );
  }, [menu, cat, search]);

  const totals = useMemo(() => {
    const subtotal = round2(cart.reduce((s, l) => s + l.price * l.qty, 0));
    const tax = round2(cart.reduce((s, l) => s + (l.price * l.qty * l.taxRate) / 100, 0));
    return { subtotal, tax, total: round2(subtotal + tax) };
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

      const res = await api<{ order: OrderT }>("/api/pos/orders", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setCart([]);
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

  // ── Menu management ──
  const addMenuItem = async () => {
    const price = Number(newPrice);
    if (!newName.trim() || !Number.isFinite(price) || price <= 0) {
      toast({ title: "Name and a positive price are required", variant: "destructive" });
      return;
    }
    try {
      await api("/api/menu", {
        method: "POST",
        body: JSON.stringify({
          name: newName.trim(),
          category: newCat,
          price,
          isVeg: newVeg,
          description: newDesc.trim(),
          taxRate: Number(newTax) || (newCat === "bar" ? 12 : 5),
          imageUrl: newImageUrl || undefined,
        }),
      });
      toast({ title: `${newName.trim()} added to menu` });
      setNewName("");
      setNewPrice("");
      setNewDesc("");
      setNewVeg(true);
      setNewTax(newCat === "bar" ? "12" : "5");
      setNewImageUrl("");
      loadMenu();
    } catch (e) {
      toast({ title: "Could not add item", description: errMsg(e), variant: "destructive" });
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
      <style>{`@media print { body * { visibility: hidden !important; } #kot-print, #kot-print * { visibility: visible !important; } #kot-print { position: fixed; inset: 0; padding: 24px; background: #fff; z-index: 9999; } }`}</style>

      <div className="grid xl:grid-cols-3 gap-4 items-start">
        {/* ── Left: menu ── */}
        <div className="xl:col-span-2">
          <div className="panel">
            <div className="panel-header flex-wrap">
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

            <div className="px-3 pt-3">
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

            <div className="p-3">
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

              {/* Cart lines */}
              <div className="divide-y divide-line border-y border-line">
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

              {/* Totals */}
              <div className="space-y-1 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">Subtotal</span>
                  <span className="font-medium">{inr(totals.subtotal, { decimals: true })}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-ink">GST</span>
                  <span className="font-medium">{inr(totals.tax, { decimals: true })}</span>
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
          <button className="btn-ghost h-8 text-xs" onClick={loadOrders}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </button>
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
                return (
                  <tr key={o.id}>
                    <td className="td">
                      <p className="font-medium text-pine">{o.orderNumber}</p>
                      <p className="text-xs text-muted-ink">{fmtTime(o.createdAt)}</p>
                    </td>
                    <td className="td"><TypeCell o={o} /></td>
                    <td className="td">{itemCount}</td>
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
                    <td className="td">
                      <div className="flex items-center justify-end gap-1.5 flex-wrap">
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
            </DialogDescription>
          </DialogHeader>

          {successOrder && (
            <>
              <div id="kot-print" className="rounded-md border border-line bg-panel p-4 font-mono text-sm space-y-2">
                <div className="text-center space-y-0.5">
                  <p className="text-[10px] uppercase tracking-[0.2em] text-muted-ink">Velurex HMS · Kitchen Order Ticket</p>
                  <p className="text-2xl font-bold text-pine">{successOrder.orderNumber}</p>
                  <p className="text-xs text-muted-ink">
                    {fmtTime(successOrder.createdAt)} ·{" "}
                    {successOrder.orderType === "dine_in"
                      ? `Table ${successOrder.tableNumber || "—"}`
                      : successOrder.orderType === "room_service"
                        ? `Room ${successOrder.roomNumber}`
                        : "Takeaway"}
                  </p>
                </div>
                <div className="border-t border-dashed border-line-strong pt-2 space-y-1">
                  {successOrder.items.map((i) => (
                    <div key={i.id} className="flex items-baseline justify-between gap-2">
                      <span>
                        <span className="font-bold">{i.qty}×</span> {i.name}
                      </span>
                      {i.notes && <span className="text-xs text-warn italic">{i.notes}</span>}
                    </div>
                  ))}
                </div>
                <div className="border-t border-dashed border-line-strong pt-2 flex items-center justify-between">
                  <span className="text-xs uppercase tracking-wider text-muted-ink">Total (incl. GST)</span>
                  <span className="font-bold">{inr(successOrder.totalAmount, { decimals: true })}</span>
                </div>
              </div>

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
        </DialogContent>
      </Dialog>

      {/* ── Menu management dialog ── */}
      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Menu management</DialogTitle>
            <DialogDescription>Add dishes, edit prices, or mark items sold out.</DialogDescription>
          </DialogHeader>

          <div className="border border-line rounded-md p-3 space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-ink">+ New menu item</p>
            <div className="grid grid-cols-2 gap-2">
              <input className="field h-10 col-span-2" placeholder="Dish name" value={newName} onChange={(e) => setNewName(e.target.value)} />
              <Select
                value={newCat}
                onValueChange={(v) => {
                  setNewCat(v);
                  setNewTax(v === "bar" ? "12" : "5");
                }}
              >
                <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORY_TABS.filter((c) => c.key !== "all").map((c) => (
                    <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input className="field h-10" type="number" min="1" placeholder="Price ₹" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
              <input className="field h-10" type="number" min="0" max="100" placeholder="GST %" value={newTax} onChange={(e) => setNewTax(e.target.value)} />
              <div className="flex items-center justify-between rounded-md border border-line-strong px-3 h-10">
                <span className="text-sm text-muted-ink">{newVeg ? "Veg" : "Non-veg"}</span>
                <Switch checked={newVeg} onCheckedChange={setNewVeg} />
              </div>
              <input className="field h-10 col-span-2" placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => openPicker("new")}
                disabled={imageBusy}
                title="Add a food photo"
                aria-label="Add a food photo"
                className="h-16 w-16 shrink-0 rounded-md border border-dashed border-line-strong grid place-items-center text-muted-ink hover:border-brass hover:text-brass transition disabled:opacity-50 overflow-hidden"
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
              <div className="min-w-0 flex-1 text-xs text-muted-ink">
                <p>Food photo (optional) — compressed to ≤512px before upload.</p>
                {newImageUrl && (
                  <button
                    type="button"
                    className="btn-ghost h-7 px-2 mt-1 text-danger hover:bg-danger/10"
                    onClick={() => setNewImageUrl("")}
                  >
                    <X className="h-3.5 w-3.5" /> Remove photo
                  </button>
                )}
                {imageBusy && pickingFor === "new" && <p className="text-brass mt-1">Uploading…</p>}
              </div>
            </div>
            <button className="btn-pine w-full h-10" onClick={addMenuItem} disabled={imageBusy}>
              <Plus className="h-4 w-4" /> Add menu item
            </button>
          </div>

          <div className="border border-line rounded-md divide-y divide-line max-h-64 overflow-y-auto scroll-slim">
            {menu.length === 0 && (
              <p className="px-3 py-6 text-center text-sm text-muted-ink">No items yet — add the first dish above.</p>
            )}
            {menu.map((m) => (
              <div key={m.id} className="flex items-center gap-2 px-3 py-2">
                <ItemThumb
                  name={m.name}
                  isVeg={m.isVeg}
                  imageUrl={m.imageUrl ?? ""}
                  busy={imageBusy}
                  onPick={() => openPicker(m.id)}
                  onRemove={m.imageUrl ? () => removeItemImage(m) : undefined}
                />
                <VegDot isVeg={m.isVeg} />
                <span className="text-sm font-medium text-ink flex-1 min-w-0 truncate">{m.name}</span>
                <span className="hidden sm:block text-[11px] text-muted-ink w-14">{m.category}</span>
                <input
                  className="field h-9 w-20 sm:w-24 text-right"
                  type="number"
                  min="1"
                  value={priceEdits[m.id] ?? String(m.price)}
                  onChange={(e) => setPriceEdits((prev) => ({ ...prev, [m.id]: e.target.value }))}
                  onBlur={() => savePrice(m)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                />
                <Switch
                  checked={m.available}
                  onCheckedChange={(v) => toggleAvailable(m, v)}
                  aria-label={`Toggle ${m.name} availability`}
                />
                {user?.role === "hotel_admin" && (
                  <button className="btn-ghost h-9 w-9 px-0 text-danger" title="Delete item" onClick={() => deleteMenuItem(m)}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
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
