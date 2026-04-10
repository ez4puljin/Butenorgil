import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  History,
  PackageSearch,
  Save,
  Send,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Plus,
  Minus,
  Search,
  X,
  ShoppingCart,
  Warehouse,
  Tag,
  RotateCcw,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { useManagerOrderStore, type MProduct, type OrderSummary } from "../store/managerOrderStore";

type OrderLineDetail = {
  product_id: number;
  item_code: string;
  name: string;
  order_qty_box: number;
  order_qty_pcs: number;
  computed_weight: number;
  stock_qty_snapshot: number;
};

const STATUS_LABEL: Record<string, { label: string; cls: string }> = {
  draft:     { label: "Ноорог",   cls: "bg-gray-100 text-gray-600" },
  submitted: { label: "Илгээсэн", cls: "bg-blue-50 text-blue-700" },
  finalized: { label: "Баталсан", cls: "bg-emerald-50 text-emerald-700" },
};

// ── Numpad keys layout ────────────────────────────────────────────────────────
const NUMPAD_ROWS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["C", "0", "⌫"],
];

// ── NumPad Modal ──────────────────────────────────────────────────────────────
interface NumpadModalProps {
  product: MProduct;
  initialQty: number;
  onConfirm: (qty: number) => void;
  onClose: () => void;
}

function NumpadModal({ product, initialQty, onConfirm, onClose }: NumpadModalProps) {
  const [val, setVal] = useState(initialQty > 0 ? String(initialQty) : "");
  const valRef = useRef(val);
  useEffect(() => { valRef.current = val; }, [val]);

  const press = useCallback((key: string) => {
    if (key === "C") { setVal(""); return; }
    if (key === "⌫") { setVal(v => v.slice(0, -1)); return; }
    setVal(v => {
      const next = v + key;
      return parseInt(next) > 9999 ? v : next;
    });
  }, []);

  function confirm() {
    const n = parseInt(valRef.current);
    onConfirm(isNaN(n) || n < 0 ? 0 : n);
  }

  // Keyboard support: digits, Backspace, Enter, Escape
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" || e.key === "Return") { e.preventDefault(); confirm(); return; }
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Backspace") { press("⌫"); return; }
      if (e.key === "Delete") { press("C"); return; }
      if (/^\d$/.test(e.key)) { press(e.key); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const displayQty = val === "" ? "0" : val;
  const isChanged = parseInt(val || "0") !== initialQty;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <motion.div
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 60, opacity: 0 }}
        transition={{ type: "spring", stiffness: 360, damping: 32 }}
        className="w-full max-w-xs rounded-t-3xl sm:rounded-3xl bg-white shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between bg-gradient-to-br from-[#0071E3] to-[#0058b3] px-5 pt-4 pb-3">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-bold uppercase tracking-widest text-blue-200 mb-0.5">Захиалах тоо</p>
            <p className="text-white font-semibold text-sm leading-snug line-clamp-1">{product.name}</p>
            <p className="text-blue-300 text-[10px] mt-0.5 font-mono">{product.item_code}</p>
          </div>
          <button onClick={onClose} className="ml-3 mt-0.5 shrink-0 rounded-full bg-white/20 p-1.5 text-white hover:bg-white/30">
            <X size={14} />
          </button>
        </div>

        {/* Quantity display */}
        <div className="flex items-center justify-center bg-gray-50 border-b border-gray-100 px-4 py-3">
          <div className={`text-4xl font-bold tabular-nums tracking-tight transition-all ${
            val ? "text-gray-900" : "text-gray-300"
          }`}>
            {displayQty}
          </div>
          <span className="ml-2 text-xs text-gray-400 font-medium">хайрцаг</span>
        </div>

        {/* Numpad */}
        <div className="p-3 grid grid-cols-3 gap-2">
          {NUMPAD_ROWS.flat().map(key => (
            <button
              key={key}
              onPointerDown={e => e.preventDefault()}
              onClick={() => press(key)}
              className={`h-12 rounded-xl text-lg font-semibold transition-all active:scale-95 select-none ${
                key === "C"
                  ? "bg-red-50 text-red-500 hover:bg-red-100 active:bg-red-200"
                  : key === "⌫"
                  ? "bg-gray-100 text-gray-600 hover:bg-gray-200 active:bg-gray-300"
                  : "bg-gray-50 text-gray-900 hover:bg-gray-100 active:bg-gray-200"
              }`}
            >
              {key}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-3 pb-4">
          <button
            onClick={onClose}
            className="flex-1 h-12 rounded-xl border border-gray-200 text-sm font-semibold text-gray-600 hover:bg-gray-50 active:bg-gray-100"
          >
            Болих
          </button>
          <button
            onClick={confirm}
            className={`flex-[2] h-12 rounded-xl text-sm font-bold text-white transition-all active:scale-[0.98] ${
              isChanged
                ? "bg-[#0071E3] hover:bg-[#005ec4] shadow-[0_4px_12px_rgba(0,113,227,0.35)]"
                : "bg-gray-300"
            }`}
          >
            Хадгалах ↵
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Product Card ──────────────────────────────────────────────────────────────
interface ProductCardProps {
  product: MProduct;
  qty: number;
  onAdd: () => void;
  onSub: () => void;
  onTapQty: () => void;
}

function ProductCard({ product: p, qty, onAdd, onSub, onTapQty }: ProductCardProps) {
  const active = qty > 0;
  const w = qty * (p.pack_ratio || 1) * (p.unit_weight || 0);

  return (
    <motion.div
      layout
      className={`flex items-center gap-4 rounded-2xl border-2 p-4 transition-all duration-200 ${
        active
          ? "border-[#0071E3]/30 bg-blue-50/70 shadow-md shadow-blue-100"
          : "border-gray-100 bg-white"
      }`}
    >
      {/* Left: Product info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-mono text-xs text-gray-400 bg-gray-100 rounded px-1.5 py-0.5 shrink-0">
            {p.item_code}
          </span>
          {active && (
            <span className="text-[10px] font-bold text-[#0071E3] bg-blue-100 rounded-full px-2 py-0.5 shrink-0">
              {(w).toFixed(1)} кг
            </span>
          )}
        </div>
        <p className={`font-semibold leading-snug text-base ${active ? "text-[#0071E3]" : "text-gray-900"}`}>
          {p.name}
        </p>
        <div className="flex items-center gap-3 mt-1.5 text-xs text-gray-400">
          <span>Нөөц <span className="font-semibold text-gray-600">{(p.stock_qty ?? 0).toFixed(0)}</span></span>
          <span className="text-gray-200">·</span>
          <span>Борлуулалт <span className="font-semibold text-gray-600">{(p.sales_qty ?? 0).toFixed(0)}</span></span>
          <span className="text-gray-200">·</span>
          <span>{(p.pack_ratio ?? 1).toFixed(0)} ш/хб</span>
        </div>
      </div>

      {/* Right: Stepper */}
      <div className="flex items-center shrink-0" style={{ gap: 0 }}>
        {/* Minus */}
        <button
          onPointerDown={e => e.preventDefault()}
          onClick={onSub}
          disabled={qty === 0}
          className={`flex h-14 w-14 items-center justify-center rounded-l-2xl border-2 border-r-0 transition-all active:scale-95 select-none ${
            qty > 0
              ? "border-red-200 bg-red-50 text-red-500 hover:bg-red-100 active:bg-red-200"
              : "border-gray-100 bg-gray-50 text-gray-300"
          }`}
        >
          <Minus size={22} strokeWidth={2.5} />
        </button>

        {/* Qty display — tap to open numpad */}
        <button
          onClick={onTapQty}
          className={`flex h-14 w-20 flex-col items-center justify-center border-y-2 text-xl font-bold tabular-nums transition-all select-none ${
            active
              ? "border-[#0071E3]/30 bg-white text-gray-900"
              : "border-gray-100 bg-gray-50 text-gray-300"
          }`}
        >
          {active ? qty : <span className="text-2xl text-gray-200">—</span>}
        </button>

        {/* Plus */}
        <button
          onPointerDown={e => e.preventDefault()}
          onClick={onAdd}
          className="flex h-14 w-14 items-center justify-center rounded-r-2xl border-2 border-l-0 border-[#0071E3]/40 bg-blue-50 text-[#0071E3] hover:bg-blue-100 active:bg-blue-200 active:scale-95 transition-all select-none"
        >
          <Plus size={22} strokeWidth={2.5} />
        </button>
      </div>
    </motion.div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────
export default function ManagerOrders() {
  const { tagIds, userId } = useAuthStore();
  const store = useManagerOrderStore();

  const [tab, setTab] = useState<"order" | "history">("order");
  const [brands, setBrands] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Numpad
  const [numpadId, setNumpadId] = useState<number | null>(null);

  // Search
  const [search, setSearch] = useState("");

  // Filter: show only ordered
  const [onlyOrdered, setOnlyOrdered] = useState(false);

  // History
  const [historyLoading, setHistoryLoading] = useState(false);
  const [history, setHistory] = useState<OrderSummary[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [orderLines, setOrderLines] = useState<Record<number, OrderLineDetail[]>>({});

  // Init tagId
  useEffect(() => {
    if (!store.selectedTagId && tagIds.length > 0) {
      store.setSelectedTagId(tagIds[0]);
    }
  }, [tagIds]);

  // Load brands on tagId change
  useEffect(() => {
    if (!store.selectedTagId) return;
    api
      .get("/products/brands", { params: { warehouse_tag_id: store.selectedTagId } })
      .then((r) => {
        setBrands(r.data);
        if (!store.selectedBrand && r.data.length > 0) {
          store.setSelectedBrand(r.data[0]);
        }
      })
      .catch(() => {});
  }, [store.selectedTagId]);

  const draftKey = `${store.selectedBrand}_${store.selectedTagId}_${userId ?? 0}`;

  const loadProducts = async () => {
    if (!store.selectedTagId || !store.selectedBrand) return;
    setLoading(true);
    setSearch("");
    setOnlyOrdered(false);
    try {
      // Бүтээгдэхүүн болон server-ийн draft-ийг зэрэг авна
      const [prodRes, draftRes] = await Promise.all([
        api.get("/products", {
          params: { warehouse_tag_id: store.selectedTagId, brand: store.selectedBrand },
        }),
        api.get("/orders/my-draft", {
          params: { warehouse_tag_id: store.selectedTagId, brand: store.selectedBrand },
        }),
      ]);

      const items: MProduct[] = prodRes.data.items ?? prodRes.data;
      store.setProducts(items);
      store.resetQuantities();

      // Server-ийн draft order ID-г localStorage-ийн оронд ашиглана
      // Ямар ч device дээр нэвтэрсэн ч хуучин draft-аа авна
      const serverDraftId: number | null = draftRes.data.order_id;
      if (serverDraftId) {
        store.setOrderId(draftKey, serverDraftId);
        try {
          const linesRes = await api.get(`/orders/${serverDraftId}/lines`);
          const qtys: Record<number, number> = {};
          for (const l of linesRes.data as OrderLineDetail[]) {
            qtys[l.product_id] = l.order_qty_box;
          }
          store.applyQuantities(qtys);
        } catch {
          store.clearOrderId(draftKey);
        }
      } else {
        // Server дээр draft байхгүй → localStorage-ийн хуучин ID-г цэвэрлэнэ
        store.clearOrderId(draftKey);
      }
    } finally {
      setLoading(false);
    }
  };

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const saveLines = async (submit: boolean) => {
    if (!store.selectedTagId || !store.selectedBrand) {
      flash("Агуулах болон брэнд сонгоно уу", false);
      return;
    }
    if (submit) setSubmitting(true);
    else setSaving(true);

    try {
      // create endpoint нь backend дээр idempotent: ижил user+warehouse+brand draft байвал дахин үүсгэхгүй
      // → localStorage болон server аль нэгнийг нь ашигладаг, давхардахгүй
      let orderId = store.currentOrderIds[draftKey];
      if (!orderId) {
        const res = await api.post("/orders/create", {
          warehouse_tag_id: store.selectedTagId,
          brand: store.selectedBrand,
        });
        orderId = res.data.order_id;
        store.setOrderId(draftKey, orderId);
      }

      const lines = store.products
        .filter((p) => (store.quantities[p.id] ?? 0) > 0)
        .map((p) => ({ product_id: p.id, order_qty_box: store.quantities[p.id] }));

      await api.post(`/orders/${orderId}/set-lines`, lines);

      if (submit) {
        await api.post("/orders/submit", { order_id: orderId });
        store.clearOrderId(draftKey);
        store.resetQuantities();
        flash("Захиалга амжилттай илгээгдлээ!");
        // Түүхийг шинэчлэнэ
        loadHistory();
      } else {
        flash("Ноорог хадгалагдлаа!");
      }
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSaving(false);
      setSubmitting(false);
    }
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      const res = await api.get("/orders/manager/my");
      setHistory(res.data);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (tab === "history") loadHistory();
  }, [tab]);

  const toggleOrderDetail = async (orderId: number) => {
    if (expandedId === orderId) { setExpandedId(null); return; }
    setExpandedId(orderId);
    if (!orderLines[orderId]) {
      try {
        const res = await api.get(`/orders/${orderId}/lines`);
        setOrderLines((prev) => ({ ...prev, [orderId]: res.data }));
      } catch {}
    }
  };

  // Computed totals
  const { totalBoxes, totalWeight, orderedCount } = useMemo(() => {
    let boxes = 0, weight = 0, count = 0;
    for (const p of store.products) {
      const qty = store.quantities[p.id] ?? 0;
      if (qty > 0) { count++; }
      boxes += qty;
      weight += qty * (p.pack_ratio || 1) * (p.unit_weight || 0);
    }
    return { totalBoxes: boxes, totalWeight: weight, orderedCount: count };
  }, [store.products, store.quantities]);

  // Filtered + sorted products
  const filteredProducts = useMemo(() => {
    let list = store.products;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) || p.item_code.toLowerCase().includes(q)
      );
    }
    if (onlyOrdered) {
      list = list.filter(p => (store.quantities[p.id] ?? 0) > 0);
    }
    return list;
  }, [store.products, search, onlyOrdered, store.quantities]);

  const hasDraft = !!store.currentOrderIds[draftKey];
  const numpadProduct = numpadId != null ? store.products.find(p => p.id === numpadId) : null;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col min-h-0">
      {/* ── Tab bar ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-1 rounded-2xl bg-gray-100/80 p-1">
          {([
            { key: "order", label: "Захиалга оруулах", icon: PackageSearch },
            { key: "history", label: "Захиалгын түүх",  icon: History },
          ] as const).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all ${
                tab === key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Icon size={16} />
              {label}
            </button>
          ))}
        </div>

        {/* Flash */}
        <AnimatePresence>
          {msg && (
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className={`rounded-xl px-4 py-2.5 text-sm font-semibold shadow-sm ${
                msg.ok ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"
              }`}
            >
              {msg.text}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ══ ORDER TAB ═══════════════════════════════════════════════════════ */}
      {tab === "order" && (
        <div className="flex flex-col gap-3">

          {/* ── Selector bar ─────────────────────────────────────────────── */}
          <div className="rounded-2xl bg-white shadow-sm border border-gray-100 p-4">
            <div className="flex flex-wrap items-end gap-3">

              {/* Warehouse selector */}
              <div className="flex flex-col gap-1.5 min-w-[160px]">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <Warehouse size={12} /> Агуулах
                </label>
                <select
                  value={store.selectedTagId ?? ""}
                  onChange={(e) => {
                    store.setSelectedTagId(Number(e.target.value));
                    store.setProducts([]);
                    store.resetQuantities();
                  }}
                  className="h-12 rounded-xl border border-gray-200 px-3 text-sm font-medium outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 bg-gray-50"
                >
                  {tagIds.map((id) => (
                    <option key={id} value={id}>Агуулах #{id}</option>
                  ))}
                </select>
              </div>

              {/* Brand selector */}
              <div className="flex flex-col gap-1.5 min-w-[200px] flex-1">
                <label className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                  <Tag size={12} /> Брэнд
                </label>
                <select
                  value={store.selectedBrand}
                  onChange={(e) => {
                    store.setSelectedBrand(e.target.value);
                    store.setProducts([]);
                    store.resetQuantities();
                  }}
                  className="h-12 rounded-xl border border-gray-200 px-3 text-sm font-medium outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 bg-gray-50"
                >
                  {brands.length === 0 && <option value="">— брэнд алга —</option>}
                  {brands.map((b) => <option key={b} value={b}>{b}</option>)}
                </select>
              </div>

              {/* Load button */}
              <button
                onClick={loadProducts}
                disabled={loading || !store.selectedTagId || !store.selectedBrand}
                className="h-12 flex items-center gap-2 rounded-xl bg-[#0071E3] px-6 text-sm font-semibold text-white shadow-[0_4px_14px_rgba(0,113,227,0.35)] hover:bg-[#005ec4] active:scale-95 disabled:opacity-50 disabled:shadow-none transition-all"
              >
                {loading ? <RefreshCw size={16} className="animate-spin" /> : <PackageSearch size={16} />}
                Бараа харах
              </button>

              {/* Draft badge */}
              {hasDraft && (
                <div className="flex items-center gap-1.5 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2">
                  <div className="h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                  <span className="text-xs font-semibold text-amber-700">Ноорог байна</span>
                </div>
              )}
            </div>
          </div>

          {/* ── Products section ─────────────────────────────────────────── */}
          {store.products.length > 0 && (
            <>
              {/* Search + filter bar */}
              <div className="flex items-center gap-3">
                <div className="relative flex-1">
                  <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Бараа хайх (нэр эсвэл код)..."
                    className="h-12 w-full rounded-xl border border-gray-200 bg-white pl-10 pr-10 text-sm outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
                  />
                  {search && (
                    <button
                      onClick={() => setSearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <X size={16} />
                    </button>
                  )}
                </div>

                {/* Only ordered toggle */}
                <button
                  onClick={() => setOnlyOrdered(v => !v)}
                  className={`flex h-12 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-all ${
                    onlyOrdered
                      ? "border-[#0071E3]/30 bg-blue-50 text-[#0071E3]"
                      : "border-gray-200 bg-white text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  <ShoppingCart size={16} />
                  {orderedCount > 0 ? (
                    <span>{orderedCount} бараа</span>
                  ) : "Захиалсан"}
                </button>

                {/* Clear all */}
                {orderedCount > 0 && (
                  <button
                    onClick={() => store.resetQuantities()}
                    className="flex h-12 items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 text-sm font-semibold text-red-500 hover:bg-red-100 transition-all"
                  >
                    <RotateCcw size={15} />
                    Тэглэх
                  </button>
                )}
              </div>

              {/* Results count */}
              <p className="text-xs text-gray-400 px-1">
                {filteredProducts.length} / {store.products.length} бараа харагдаж байна
                {orderedCount > 0 && <span className="ml-2 text-[#0071E3] font-medium">· {orderedCount} бараа захиалагдсан ({totalBoxes} хайрцаг)</span>}
              </p>

              {/* Product card list — pb: action bar + bottom nav */}
              <div className="space-y-2 pb-44 lg:pb-28">
                <AnimatePresence mode="popLayout">
                  {filteredProducts.map((p) => {
                    const qty = store.quantities[p.id] ?? 0;
                    return (
                      <ProductCard
                        key={p.id}
                        product={p}
                        qty={qty}
                        onAdd={() => store.setQuantity(p.id, qty + 1)}
                        onSub={() => store.setQuantity(p.id, Math.max(0, qty - 1))}
                        onTapQty={() => setNumpadId(p.id)}
                      />
                    );
                  })}
                </AnimatePresence>

                {filteredProducts.length === 0 && (
                  <div className="flex flex-col items-center gap-3 py-16 text-gray-400">
                    <Search size={36} />
                    <p className="text-sm">Бараа олдсонгүй</p>
                  </div>
                )}
              </div>

              {/* ── Sticky bottom action bar ─────────────────────────────── */}
              {/* bottom-16 = bottom nav-аас дээш (tablet), lg:bottom-0 = desktop */}
              <div className="fixed bottom-16 lg:bottom-0 left-0 right-0 z-30">
                <div className="mx-auto max-w-[calc(100%-0px)]">
                  <div className="flex items-center justify-between gap-4 bg-white/95 backdrop-blur-md border-t border-gray-100 shadow-[0_-8px_32px_rgba(0,0,0,0.1)] px-5 py-3">
                    {/* Totals */}
                    <div className="flex items-center gap-4">
                      <div className="flex flex-col items-center">
                        <span className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{totalBoxes}</span>
                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mt-0.5">хайрцаг</span>
                      </div>
                      <div className="w-px h-8 bg-gray-200" />
                      <div className="flex flex-col items-center">
                        <span className="text-2xl font-bold text-gray-900 tabular-nums leading-none">{totalWeight.toFixed(1)}</span>
                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mt-0.5">кг</span>
                      </div>
                      <div className="w-px h-8 bg-gray-200" />
                      <div className="flex flex-col items-center">
                        <span className="text-2xl font-bold text-[#0071E3] tabular-nums leading-none">{orderedCount}</span>
                        <span className="text-[10px] text-gray-400 font-medium uppercase tracking-wide mt-0.5">бараа</span>
                      </div>
                    </div>

                    {/* Action buttons */}
                    <div className="flex gap-3">
                      <button
                        onClick={() => saveLines(false)}
                        disabled={saving}
                        className="flex h-13 items-center gap-2 rounded-xl border-2 border-gray-200 bg-white px-5 py-3 text-sm font-semibold text-gray-700 hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 transition-all"
                      >
                        {saving ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                        Ноорог
                      </button>
                      <button
                        onClick={() => saveLines(true)}
                        disabled={submitting || totalBoxes === 0}
                        className="flex h-13 items-center gap-2 rounded-xl bg-[#0071E3] px-6 py-3 text-sm font-bold text-white shadow-[0_4px_14px_rgba(0,113,227,0.4)] hover:bg-[#005ec4] active:scale-95 disabled:opacity-50 disabled:shadow-none transition-all"
                      >
                        {submitting ? <RefreshCw size={16} className="animate-spin" /> : <Send size={16} />}
                        Захиалга илгээх
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </>
          )}

          {/* Empty state */}
          {store.products.length === 0 && !loading && store.selectedTagId && store.selectedBrand && (
            <div className="flex flex-col items-center gap-4 py-20 text-gray-400">
              <div className="rounded-3xl bg-gray-100 p-6">
                <PackageSearch size={48} className="text-gray-300" />
              </div>
              <div className="text-center">
                <p className="text-base font-semibold text-gray-500">Бараа ачаалаагүй байна</p>
                <p className="text-sm mt-1">"Бараа харах" товч дарж барааг харна уу</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══ HISTORY TAB ═════════════════════════════════════════════════════ */}
      {tab === "history" && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-gray-600">{history.length} захиалга</p>
            <button
              onClick={loadHistory}
              disabled={historyLoading}
              className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-600 hover:bg-gray-50 transition-all"
            >
              <RefreshCw size={14} className={historyLoading ? "animate-spin" : ""} />
              Шинэчлэх
            </button>
          </div>

          <div className="space-y-2 pb-6">
            {history.length === 0 && !historyLoading && (
              <div className="flex flex-col items-center gap-3 rounded-2xl bg-white p-12 text-center shadow-sm">
                <History size={36} className="text-gray-300" />
                <p className="text-sm text-gray-400">Захиалга байхгүй байна</p>
              </div>
            )}

            {history.map((o) => {
              const st = STATUS_LABEL[o.status] ?? { label: o.status, cls: "bg-gray-100 text-gray-600" };
              const expanded = expandedId === o.id;
              const lines = orderLines[o.id];
              return (
                <div key={o.id} className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden">
                  <button
                    onClick={() => toggleOrderDetail(o.id)}
                    className="flex w-full items-center justify-between px-5 py-4 hover:bg-gray-50 active:bg-gray-100 transition-colors"
                  >
                    <div className="flex items-center gap-3">
                      <div className={`flex h-10 w-10 items-center justify-center rounded-xl transition-colors ${
                        expanded ? "bg-[#0071E3]/10 text-[#0071E3]" : "bg-gray-100 text-gray-400"
                      }`}>
                        {expanded ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </div>
                      <div className="text-left">
                        <div className="text-sm font-bold text-gray-900">
                          {o.brand} — Агуулах #{o.warehouse_tag_id}
                        </div>
                        <div className="text-xs text-gray-400 mt-0.5">
                          #{o.id} · {new Date(o.created_at).toLocaleDateString("mn-MN")}
                        </div>
                      </div>
                    </div>
                    <span className={`rounded-full px-4 py-1.5 text-xs font-bold ${st.cls}`}>
                      {st.label}
                    </span>
                  </button>

                  <AnimatePresence>
                    {expanded && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <div className="border-t border-gray-100 px-5 pb-5">
                          {!lines ? (
                            <p className="mt-4 text-xs text-gray-400 text-center">Уншиж байна...</p>
                          ) : lines.length === 0 ? (
                            <p className="mt-4 text-xs text-gray-400 text-center">Мөр байхгүй</p>
                          ) : (
                            <div className="mt-3 space-y-2">
                              {lines.map((l) => (
                                <div key={l.product_id} className="flex items-center justify-between rounded-xl bg-gray-50 px-4 py-3">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold text-gray-800 truncate">{l.name}</p>
                                    <p className="text-xs text-gray-400 font-mono mt-0.5">{l.item_code}</p>
                                  </div>
                                  <div className="flex items-center gap-4 ml-4 shrink-0 text-right">
                                    {/* Нөөц — захиалга үүсгэх үеийн Үлдэгдлийн тайланаас */}
                                    {(l.stock_qty_snapshot ?? 0) > 0 && (
                                      <div>
                                        <p className="text-sm font-semibold text-emerald-700 tabular-nums">{(l.stock_qty_snapshot ?? 0).toFixed(0)}</p>
                                        <p className="text-[10px] text-emerald-500">нөөц</p>
                                      </div>
                                    )}
                                    <div>
                                      <p className="text-base font-bold text-gray-900 tabular-nums">{l.order_qty_box}</p>
                                      <p className="text-[10px] text-gray-400">захиалга</p>
                                    </div>
                                    <div>
                                      <p className="text-base font-bold text-gray-700 tabular-nums">{(l.computed_weight ?? 0).toFixed(2)}</p>
                                      <p className="text-[10px] text-gray-400">кг</p>
                                    </div>
                                  </div>
                                </div>
                              ))}
                              {/* Footer totals */}
                              <div className="flex justify-end gap-6 border-t border-gray-200 pt-3 px-1">
                                <span className="text-sm font-bold text-gray-900">
                                  Нийт: {lines.reduce((s, l) => s + (l.order_qty_box ?? 0), 0)} хайрцаг
                                </span>
                                <span className="text-sm font-bold text-gray-700">
                                  {lines.reduce((s, l) => s + (l.computed_weight ?? 0), 0).toFixed(2)} кг
                                </span>
                              </div>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Numpad Modal ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {numpadId != null && numpadProduct && (
          <NumpadModal
            product={numpadProduct}
            initialQty={store.quantities[numpadId] ?? 0}
            onConfirm={(qty) => {
              store.setQuantity(numpadId, qty);
              setNumpadId(null);
            }}
            onClose={() => setNumpadId(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}
