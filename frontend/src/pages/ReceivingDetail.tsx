import { useEffect, useState, useRef, useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ChevronLeft, Search, Plus, Trash2, Upload, Check, X, FileDown,
  RefreshCw, Image as ImageIcon, AlertCircle, Package, Camera,
  Calendar, User, Hash, CheckCircle2, Clock, Undo2, Eye, TrendingUp,
  ChevronRight, ChevronDown, AlertTriangle,
} from "lucide-react";
import { api } from "../lib/api";
import { useLiveRefresh } from "../lib/liveEvents";
import { useAuthStore } from "../store/authStore";
import BarcodeScanner from "../components/BarcodeScanner";

type Line = {
  id: number;
  product_id: number;
  item_code: string;
  name: string;
  brand: string;             // effective brand (override_brand буюу үгүй бол original_brand)
  original_brand: string;    // Product.brand-аас ирсэн анхдагч brand
  override_brand: string;    // Хэрвээ override хийгдсэн бол энэ нь утгатай
  warehouse_name: string;
  pack_ratio: number;
  last_purchase_price: number;
  qty_pcs: number;
  stock_box: number;
  stock_extra_pcs: number;
  unit_price: number;
  total_amount: number;
  price_reviewed: boolean;   // price_review статусын үед хэрэглэгчийн toggle
  note: string;
};

// Богино мөнгөний формат
const fmtMnt = (v: number): string => {
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}тэрбум₮`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}сая₮`;
  if (v >= 1e3) return `${Math.round(v / 1000)}мян₮`;
  return `${Math.round(v)}₮`;
};

type BrandInfo = {
  brand: string;
  line_count: number;
  total_pcs: number;
  total_amount: number;
  has_price_diff: boolean;
  is_matched: boolean;
  supplier_total_pcs: number;
  supplier_total_amount: number;
  receipt_image_path: string;
  matched_at: string | null;
};

type Session = {
  id: number;
  date: string;
  notes: string;
  status: string;
  status_label: string;
  is_archived: boolean;
  created_by_username: string;
  created_at: string;
  line_count: number;
  total_pcs: number;
  total_amount: number;
  all_brands_matched: boolean;
  brands: BrandInfo[];
  lines: Line[];
};

type SearchProduct = {
  id: number;
  item_code: string;
  name: string;
  brand: string;
  warehouse_name: string;
  pack_ratio: number;
  unit_weight: number;
};

const STATUS_CHIP: Record<string, string> = {
  matching: "bg-amber-50 text-amber-700 ring-amber-200/60",
  price_review: "bg-indigo-50 text-indigo-700 ring-indigo-200/60",
  received: "bg-emerald-50 text-emerald-700 ring-emerald-200/60",
};
const STATUS_DOT: Record<string, string> = {
  matching: "bg-amber-500",
  price_review: "bg-indigo-500",
  received: "bg-emerald-500",
};

function StatusChip({ status, label }: { status: string; label: string }) {
  const cls = STATUS_CHIP[status] ?? "bg-gray-50 text-gray-600 ring-gray-200/60";
  const dot = STATUS_DOT[status] ?? "bg-gray-400";
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

/**
 * Searchable brand picker — input + filtered list. Replaces a native <select>
 * which doesn't support typing-to-search well on phones with long brand lists.
 */
function BrandSearchPicker({
  value,
  options,
  onChange,
  placeholder = "Бренд сонгох…",
  warn = false,
  className = "",
}: {
  value: string;
  options: string[];
  onChange: (b: string) => void;
  placeholder?: string;
  warn?: boolean;
  className?: string;
}) {
  const [open, setOpen]   = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Auto-focus the search input when opening
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(b => b.toLowerCase().includes(q));
  }, [query, options]);

  const triggerCls =
    `flex w-full items-center justify-between gap-2 rounded-xl border px-3 py-2 text-[13px] outline-none transition ${
      warn
        ? "border-red-300 bg-white text-red-700"
        : value
          ? "border-gray-200 bg-white text-gray-800"
          : "border-gray-200 bg-white text-gray-400"
    }`;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button type="button" onClick={() => setOpen(o => !o)} className={triggerCls}>
        <span className="truncate font-medium">{value || placeholder}</span>
        <ChevronDown size={14} className={`shrink-0 ${warn ? "text-red-500" : "text-gray-400"}`}/>
      </button>

      {open && (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-72 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl">
          <div className="flex items-center gap-2 border-b border-gray-100 px-3 py-2">
            <Search size={13} className="text-gray-400"/>
            <input
              ref={inputRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Хайх…"
              className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-gray-300"
            />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); inputRef.current?.focus(); }}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100"
                aria-label="Цэвэрлэх"
              >
                <X size={11}/>
              </button>
            )}
          </div>
          <div className="max-h-56 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="px-3 py-3 text-center text-[12px] text-gray-400">Олдсонгүй</div>
            )}
            {filtered.map(b => (
              <button
                key={b}
                type="button"
                onClick={() => { onChange(b); setOpen(false); setQuery(""); }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] transition ${
                  value === b ? "bg-[#0071E3]/10 font-semibold text-[#0071E3]" : "hover:bg-gray-50 text-gray-700"
                }`}
              >
                <span className="truncate">{b}</span>
                {value === b && <Check size={13} className="shrink-0 text-[#0071E3]"/>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/**
 * Тухайн line дээр харуулах боломжит брэндүүдийг нэгтгэн буцаана.
 * Дарааллыг: original → session brands → system brands → current override (хэрэв новч)
 */
function getBrandOptions(line: Line, sessionBrands: { brand: string }[], allBrands: string[]): string[] {
  const seen = new Set<string>();
  const opts: string[] = [];
  const add = (b: string) => {
    const v = (b || "").trim();
    if (v && v !== "Брэнд байхгүй" && !seen.has(v)) { seen.add(v); opts.push(v); }
  };
  add(line.original_brand);
  sessionBrands.forEach(b => add(b.brand));
  allBrands.forEach(b => add(b));
  add(line.override_brand);
  return opts;
}


export default function ReceivingDetail() {
  const { id } = useParams<{ id: string }>();
  const { role } = useAuthStore();
  const navigate = useNavigate();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState<SearchProduct[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<SearchProduct | null>(null);
  const [addQty, setAddQty] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [addBrand, setAddBrand] = useState<string>("");                    // override brand сонголт
  const [allBrands, setAllBrands] = useState<string[]>([]);                 // системийн бүх brand
  const [rescanInfo, setRescanInfo] = useState<{ lines: Line[]; productName: string } | null>(null);
  const [recentlyAdded, setRecentlyAdded] = useState<{ id: number; name: string; qty: number; amount: number }[]>([]);

  const [filterBrand, setFilterBrand] = useState("");
  const [priceDiffOnly, setPriceDiffOnly] = useState(false);
  const [filterText, setFilterText] = useState("");
  // Mobile-д "Брэнд тулгалт" ↔ "Бараа жагсаалт" хооронд toggle
  const [mobileView, setMobileView] = useState<"brands" | "lines">("brands");

  const [confirmBrand, setConfirmBrand] = useState<BrandInfo | null>(null);
  const [supplierPcs, setSupplierPcs] = useState("");
  const [supplierAmount, setSupplierAmount] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);

  const [errorModal, setErrorModal] = useState<string | null>(null);

  const [showERPModal, setShowERPModal] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [scanFlash, setScanFlash] = useState<string | null>(null);
  const [scanNotFound, setScanNotFound] = useState<string | null>(null);
  const [receiptView, setReceiptView] = useState<{ url: string; brand: string } | null>(null);
  const [receiptLoading, setReceiptLoading] = useState(false);
  const [receiptZoom, setReceiptZoom] = useState(false);

  const viewReceipt = async (brand: string) => {
    if (!session) return;
    setReceiptLoading(true);
    try {
      const res = await api.get(`/receivings/${session.id}/brands/receipt`, {
        params: { brand },
        responseType: "blob",
      });
      const blob = res.data instanceof Blob ? res.data : new Blob([res.data]);
      const url = URL.createObjectURL(blob);
      setReceiptView({ url, brand });
      setReceiptZoom(false);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Баримт татахад алдаа", false);
    } finally {
      setReceiptLoading(false);
    }
  };

  // Receipt viewer Esc-to-close
  useEffect(() => {
    if (!receiptView) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        URL.revokeObjectURL(receiptView.url);
        setReceiptView(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receiptView]);

  const handleBarcodeScan = async (code: string) => {
    setShowScanner(false);
    setScanNotFound(null);
    const clean = (code || "").trim();
    if (!clean) return;
    // Scan хийсэн утгыг хайлт хэсэгт үргэлж fill хийж, хэрэглэгч харж баталгаажуулна
    setSearch(clean);
    setScanFlash(`Сканласан: ${clean}`);
    try {
      const r = await api.get("/products/search", { params: { q: clean } });
      const list: SearchProduct[] = r.data;
      setSearchResults(list);
      if (list.length === 1) {
        // Нэг л match бол шууд сонгож "Ирсэн тоо" / "Нэгж үнэ" UI руу
        setSelected(list[0]);
        setAddQty("");
        setAddPrice("");
        setAddBrand("");
        checkRescan(list[0].id, list[0].name);
        flash(`Олдлоо: ${list[0].name}`);
      } else if (list.length > 1) {
        flash(`${list.length} бараа олдлоо — сонгоно уу`);
      } else {
        setScanNotFound(clean);
      }
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Хайх алдаа", false);
    }
    setTimeout(() => setScanFlash(null), 3500);
  };

  const load = async () => {
    if (!id) return;
    setLoading(true);
    try {
      const r = await api.get(`/receivings/${id}`);
      setSession(r.data);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [id]);

  // Live updates: бусад device-ээс энэ session-д өөрчлөлт орвол автомат refresh
  useLiveRefresh(["receivings"], (e) => {
    if (!id) return;
    const sid = (e.data as any)?.session_id;
    // Энэ session-той хамаагүй event-ийг алгасна (sid тодорхойгүй бол refresh хийнэ)
    if (sid !== undefined && String(sid) !== String(id)) return;
    load();
  });

  // Системийн бүх brand-ийг override dropdown-д ашиглахаар нэг удаа татна
  useEffect(() => {
    (async () => {
      try {
        const r = await api.get("/receivings/brands/all");
        setAllBrands(Array.isArray(r.data) ? r.data : []);
      } catch {
        setAllBrands([]);
      }
    })();
  }, []);

  // Скан/сонголтоор сонгогдсон product session-д аль хэдий нь нэмэгдсэн line-уудыг олж сэрэмжлүүлгийн banner харуулах
  const checkRescan = (productId: number, productName: string) => {
    if (!session) return;
    const matches = session.lines.filter(l => l.product_id === productId);
    if (matches.length > 0) {
      setRescanInfo({ lines: matches, productName });
    } else {
      setRescanInfo(null);
    }
  };

  // selected-ыг unset хийхэд override + rescan banner дагалдаж reset
  const clearSelection = () => {
    setSelected(null);
    setAddQty("");
    setAddPrice("");
    setAddBrand("");
    setRescanInfo(null);
  };

  // Debounced search
  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.get("/products/search", { params: { q: term } });
        setSearchResults(r.data);
      } catch { setSearchResults([]); }
      finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  const addLine = async () => {
    if (!selected || !session) return;
    const qty = parseFloat(addQty);
    const price = parseFloat(addPrice);
    if (isNaN(qty) || qty <= 0) { flash("Тоо оруулна уу", false); return; }
    if (isNaN(price) || price <= 0) { flash("Үнэ оруулна уу", false); return; }
    try {
      const sel = selected;
      const ob = (addBrand || "").trim();
      // Брендгүй бараа сонгосон бол бренд заавал сонгох
      if (!(sel.brand || "").trim() && !ob) {
        flash("Брэндгүй бараа байна. Аль брэнд дор тулгах вэ — сонгоно уу", false);
        return;
      }
      const payload: any = {
        product_id: sel.id,
        qty_pcs: qty,
        unit_price: price,
      };
      // Override-ыг зөвхөн product.brand-аас өөр бол илгээнэ
      if (ob && ob !== (sel.brand || "")) payload.override_brand = ob;
      await api.post(`/receivings/${session.id}/lines`, payload);
      const brandShown = ob && ob !== (sel.brand || "") ? ` (${ob} дор)` : "";
      flash(`${sel.name}${brandShown} нэмэгдлээ`);
      setRecentlyAdded(prev => [
        { id: Date.now(), name: sel.name, qty, amount: qty * price },
        ...prev,
      ].slice(0, 5));
      setSelected(null);
      setAddQty("");
      setAddPrice("");
      setAddBrand("");
      setRescanInfo(null);
      setSearch("");
      setSearchResults([]);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    }
  };

  const updateLine = async (lineId: number, patch: { qty_pcs?: number; unit_price?: number; override_brand?: string | null }) => {
    if (!session) return;
    try {
      await api.patch(`/receivings/${session.id}/lines/${lineId}`, patch);
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  // price_review статусын үед line-ын "хянагдсан" төлвийг toggle
  const togglePriceReview = async (lineId: number, reviewed: boolean) => {
    if (!session) return;
    try {
      await api.patch(`/receivings/${session.id}/lines/${lineId}/price-review`, null, {
        params: { reviewed },
      });
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  const deleteLine = async (lineId: number) => {
    if (!session) return;
    if (!confirm("Мөр устгах уу?")) return;
    try {
      await api.delete(`/receivings/${session.id}/lines/${lineId}`);
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  const confirmBrandMatch = async () => {
    if (!session || !confirmBrand) return;
    // Хэрэглэгчийн оруулсан мөрүүдийн нийлбэрийг supplier total болгоно.
    // (UI дотор тусдаа баримтны input хэрэггүй болсон.)
    const pcs    = confirmBrand.total_pcs;
    const amount = confirmBrand.total_amount;
    setConfirming(true);
    try {
      const fd = new FormData();
      fd.append("supplier_total_pcs", String(pcs));
      fd.append("supplier_total_amount", String(amount));
      if (receiptFile) fd.append("receipt", receiptFile);
      await api.post(
        `/receivings/${session.id}/brands/confirm`,
        fd,
        { params: { brand: confirmBrand.brand }, headers: { "Content-Type": "multipart/form-data" } }
      );
      flash(`${confirmBrand.brand} — баримт тулгалаа`);
      setConfirmBrand(null);
      setSupplierPcs("");
      setSupplierAmount("");
      setReceiptFile(null);
      await load();
    } catch (e: any) {
      const msg = e?.response?.data?.detail ?? e?.message ?? "Тодорхойгүй алдаа гарлаа";
      setErrorModal(msg);
    } finally { setConfirming(false); }
  };

  const unmatch = async (brand: string) => {
    if (!session) return;
    if (!confirm(`${brand} — тулгалтыг буцаах уу?`)) return;
    try {
      await api.post(`/receivings/${session.id}/brands/unmatch`, null, { params: { brand } });
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  const advanceTo = async (status: string) => {
    if (!session) return;
    try {
      await api.patch(`/receivings/${session.id}/status`, { status });
      flash("Статус шилжлээ");
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  // Admin/manager/supervisor зөвхөн өмнөх төлөв рүү (price_review→matching эсвэл
  // received→price_review) гар аргаар буцаах боломжтой. Confirm modal-аар хамгаалсан.
  const canRevertStatus = role === "admin" || role === "manager" || role === "supervisor";
  const revertToPrev = async () => {
    if (!session) return;
    const cur = session.status;
    const prev = cur === "received" ? "price_review" : cur === "price_review" ? "matching" : null;
    if (!prev) return;
    const labelOf: Record<string, string> = {
      matching: "Бараа хүлээн авч байна",
      price_review: "Падаан тулгаж байна",
      received: "Орлого авсан",
    };
    if (!window.confirm(
      `Статусыг "${labelOf[cur]}" → "${labelOf[prev]}" руу буцаах уу?\n\n` +
      `Анхааруулга: Хойшид хийсэн өөрчлөлт алдагдахгүй боловч өмнөх алхамд ороод дахин баталгаажуулах хэрэгтэй болно.`
    )) return;
    try {
      await api.patch(`/receivings/${session.id}/status`, { status: prev });
      flash(`Статус "${labelOf[prev]}" руу буцлаа`);
      await load();
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-gray-400">
        {loading ? <RefreshCw size={24} className="animate-spin"/> : <Package size={28} className="text-gray-200"/>}
        <span className="text-sm">{loading ? "Ачаалж байна…" : "Мэдээлэл байхгүй"}</span>
      </div>
    );
  }

  const filterTextLow = filterText.trim().toLowerCase();
  const visibleLines = session.lines.filter(l => {
    if (filterBrand) {
      // Брендгүй мөр (l.brand === "") нь "Брэнд байхгүй" дор бүлэглэгддэг
      const effective = (l.brand || "").trim() || "Брэнд байхгүй";
      if (effective !== filterBrand) return false;
    }
    if (priceDiffOnly) {
      const diff = l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01;
      if (!diff) return false;
    }
    if (filterTextLow) {
      const blob = `${l.name} ${l.item_code}`.toLowerCase();
      if (!blob.includes(filterTextLow)) return false;
    }
    return true;
  });
  const visibleByBrand: Record<string, Line[]> = {};
  for (const l of visibleLines) {
    const effective = (l.brand || "").trim() || "Брэнд байхгүй";
    (visibleByBrand[effective] ??= []).push(l);
  }

  const canEdit = session.status === "matching";
  const matchedBrandCount = session.brands.filter(b => b.is_matched).length;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="pb-16"
    >
      {/* Flash (sticky on mobile so user sees it during scroll) */}
      {msg && (
        <div className="sticky top-2 z-30 mb-3">
          <div className={`mx-auto rounded-apple px-4 py-2 text-sm shadow-sm ring-1 ring-inset ${
            msg.ok ? "bg-emerald-50 text-emerald-700 ring-emerald-200/60"
                   : "bg-red-50 text-red-700 ring-red-200/60"
          }`}>
            {msg.text}
          </div>
        </div>
      )}

      {/* Header — Receiving Redesign-ын дагуу summary card + brand progress + status action */}
      <div className="mb-4 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-gray-100 sm:p-4">
        {/* Top row — back + title + status chip */}
        <div className="flex items-start gap-2">
          <button
            onClick={() => navigate("/receivings")}
            className="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100"
            aria-label="Буцах"
          >
            <ChevronLeft size={18}/>
          </button>
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-400">
              Бараа тулгаж авах
            </div>
            <h1 className="text-[15px] font-bold tracking-tight text-gray-900 sm:text-base">
              <span className="tabular-nums">{session.date.replaceAll("-", "/")}</span>
              <span className="ml-2 text-xs font-medium text-gray-400">#{session.id}</span>
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <StatusChip status={session.status} label={session.status_label}/>
            {canRevertStatus && session.status !== "matching" && (
              <button
                onClick={revertToPrev}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700 ring-1 ring-inset ring-amber-200/80 hover:bg-amber-100"
                title={
                  session.status === "received"
                    ? "Падаан тулгах руу буцаах"
                    : "Бараа хүлээн авах руу буцаах"
                }
              >
                <Undo2 size={11}/>
                Буцаах
              </button>
            )}
          </div>
        </div>

        {/* Sub-info row — created_by + brand count */}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-gray-500">
          <span className="inline-flex items-center gap-1"><User size={11}/>{session.created_by_username}</span>
          {session.brands.length > 0 && (
            <span className="tabular-nums">
              {matchedBrandCount}/{session.brands.length} брэнд тулгагдсан
            </span>
          )}
        </div>

        {/* 3-col stats grid */}
        <div className="mt-2.5 grid grid-cols-3 gap-0 rounded-xl bg-gray-50/70 px-1 py-2.5">
          <div className="text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Мөр</div>
            <div className="mt-0.5 text-[14px] font-bold tabular-nums text-gray-900">{session.line_count}</div>
          </div>
          <div className="text-center border-x border-gray-200/70">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Ширхэг</div>
            <div className="mt-0.5 text-[14px] font-bold tabular-nums text-gray-900">{session.total_pcs.toLocaleString("mn-MN")}</div>
          </div>
          <div className="text-center">
            <div className="text-[9px] font-semibold uppercase tracking-wider text-gray-400">Дүн</div>
            <div className="mt-0.5 text-[14px] font-bold tabular-nums text-gray-900">{fmtMnt(session.total_amount)}</div>
          </div>
        </div>

        {/* Brand progress bar */}
        {session.brands.length > 0 && (
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
            <div
              className={`h-full rounded-full transition-all duration-300 ${
                session.all_brands_matched ? "bg-emerald-500" : "bg-[#0071E3]"
              }`}
              style={{ width: `${session.brands.length ? (matchedBrandCount / session.brands.length) * 100 : 0}%` }}
            />
          </div>
        )}

        {session.notes && (
          <p className="mt-2 text-[11px] italic text-gray-400">"{session.notes}"</p>
        )}

        {/* Status action button(s) — дизайны дагуу status-аас хамаарч өөр өөр товч */}
        {session.status === "matching" && (
          <button
            onClick={() => advanceTo("price_review")}
            disabled={!session.all_brands_matched}
            className={`mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-[13px] font-bold transition-all ${
              session.all_brands_matched
                ? "bg-indigo-600 text-white shadow-sm hover:bg-indigo-700 active:scale-[0.99]"
                : "bg-gray-100 text-gray-400 cursor-not-allowed"
            }`}
            title={session.all_brands_matched ? "" : "Эхлээд бүх брэндийн баримт тулгана уу"}
          >
            <TrendingUp size={15}/>
            Падаан тулгах руу шилжих
          </button>
        )}
        {session.status === "price_review" && (
          <>
            <div className="mt-3 grid grid-cols-2 gap-1.5">
              <button
                onClick={() => setShowERPModal(true)}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-indigo-50 text-[12px] font-bold text-indigo-700 ring-1 ring-inset ring-indigo-200/60 hover:bg-indigo-100"
              >
                <FileDown size={14}/>
                Нэгтгэсэн ERP
              </button>
              <button
                onClick={() => advanceTo("received")}
                className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-emerald-600 text-[12px] font-bold text-white shadow-sm hover:bg-emerald-700"
              >
                <CheckCircle2 size={14}/>
                Орлого авсан
              </button>
            </div>
            {canRevertStatus && (
              <button
                onClick={revertToPrev}
                className="mt-1.5 flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-amber-50 text-[12px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200/80 hover:bg-amber-100"
              >
                <Undo2 size={13}/>
                Бараа хүлээн авах руу буцаах
              </button>
            )}
          </>
        )}
        {session.status === "received" && canRevertStatus && (
          <button
            onClick={revertToPrev}
            className="mt-3 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl bg-amber-50 text-[13px] font-bold text-amber-700 ring-1 ring-inset ring-amber-200/80 hover:bg-amber-100"
          >
            <Undo2 size={14}/>
            Падаан тулгах руу буцаах
          </button>
        )}
      </div>

      {/* Desktop split-view: brand sidebar (left, 300px) + main column (right) with
         add-product on top and lines section below. Mobile стек хэвээр (single column). */}
      <div className="mb-4 grid grid-cols-1 gap-3 lg:items-start lg:[grid-template-columns:300px_minmax(0,1fr)] lg:[grid-template-areas:'sidebar_main-top'_'sidebar_main-bottom']">
        {/* Add-product (matching only) */}
        {canEdit && (
          <div className="rounded-apple bg-white p-4 shadow-sm ring-1 ring-gray-100 lg:[grid-area:main-top]">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">Бараа нэмэх</h3>
              <span className="text-[11px] text-gray-400">Баркод / нэр / кодоор</span>
            </div>

            {/* Search + scan */}
            <div className="flex items-stretch gap-2">
              <div className="flex flex-1 min-w-0 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 transition focus-within:border-[#0071E3] focus-within:ring-2 focus-within:ring-[#0071E3]/15">
                <Search size={16} className="shrink-0 text-gray-400"/>
                <input
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Бараа хайх…"
                  className="flex-1 min-w-0 bg-transparent text-[16px] outline-none placeholder:text-gray-400 sm:text-sm"
                  inputMode="search"
                />
                {searching && <RefreshCw size={14} className="animate-spin shrink-0 text-gray-400"/>}
                {search && !searching && (
                  <button
                    onClick={() => { setSearch(""); setSearchResults([]); }}
                    className="shrink-0 rounded p-1 text-gray-400 hover:bg-gray-100"
                    aria-label="Цэвэрлэх"
                  >
                    <X size={14}/>
                  </button>
                )}
              </div>
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                title="Камераар баркод скан хийх"
                aria-label="Скан"
                className="inline-flex shrink-0 items-center justify-center rounded-xl bg-[#0071E3] px-3 text-white shadow-sm hover:bg-[#005BB5] active:scale-95"
              >
                <Camera size={18}/>
              </button>
            </div>
            {scanFlash && (
              <div className="mt-1.5 text-[11px] text-gray-500">{scanFlash}</div>
            )}

            {/* Empty state hint — desktop дээр зүүн талын хоосон зайг дүүргэх */}
            {!selected && !search.trim() && recentlyAdded.length === 0 && (
              <div className="mt-3 hidden rounded-xl border border-dashed border-gray-200 bg-gray-50/60 p-4 text-center lg:block">
                <Camera size={22} className="mx-auto mb-1.5 text-gray-300"/>
                <p className="text-[12px] font-medium text-gray-500">Бараа нэмэхийн тулд</p>
                <p className="mt-0.5 text-[11px] text-gray-400">баркод скан, нэр эсвэл код-оор хайна уу</p>
              </div>
            )}

            {/* Search results */}
            {search.trim().length >= 2 && searchResults.length > 0 && !selected && (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-gray-100 bg-white">
                {searchResults.map(p => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setSelected(p);
                      setAddPrice("");
                      setAddQty("");
                      setAddBrand("");
                      checkRescan(p.id, p.name);
                    }}
                    className="group block w-full border-b border-gray-50 px-3 py-2.5 text-left transition hover:bg-blue-50/40 last:border-b-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-gray-800 group-hover:text-[#0071E3]">
                          {p.name}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-gray-400">
                          <span className="font-mono">{p.item_code}</span>
                          {p.brand && <span>· {p.brand}</span>}
                          {p.warehouse_name && <span>· {p.warehouse_name}</span>}
                          <span>· {p.pack_ratio}ш/хайрцаг</span>
                        </div>
                      </div>
                      <ChevronRight size={14} className="shrink-0 self-center text-gray-300 group-hover:text-[#0071E3]"/>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {/* Selected product — data entry card */}
            {selected && (
              <div className="mt-3 rounded-2xl border-2 border-[#0071E3]/25 bg-gradient-to-br from-blue-50/60 to-white p-3.5 sm:p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-gray-900 sm:text-base">{selected.name}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-gray-500">
                      <span className="font-mono">{selected.item_code}</span>
                      {selected.brand && <span>· {selected.brand}</span>}
                      <span>· {selected.pack_ratio}ш/хайрцаг</span>
                    </div>
                  </div>
                  <button
                    onClick={clearSelection}
                    className="rounded-lg p-1.5 text-gray-400 hover:bg-white hover:text-gray-700"
                    aria-label="Хаах"
                  >
                    <X size={16}/>
                  </button>
                </div>

                {/* Re-scan reminder banner — non-blocking сэрэмжлүүлэг */}
                {rescanInfo && (
                  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-900">
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-semibold">
                        <AlertTriangle size={14} className="shrink-0"/>
                        Энэ бараа аль хэдий нь нэмэгдсэн байна
                      </div>
                      <button
                        onClick={() => setRescanInfo(null)}
                        className="rounded p-0.5 text-amber-700 hover:bg-amber-100"
                        aria-label="Хаах"
                      >
                        <X size={12}/>
                      </button>
                    </div>
                    <ul className="space-y-0.5">
                      {rescanInfo.lines.map(l => (
                        <li key={l.id} className="tabular-nums">
                          • <span className="font-medium">{l.brand || "(брэндгүй)"}</span> дор{" "}
                          <span className="font-semibold">{l.qty_pcs.toFixed(0)}ш</span>,{" "}
                          <span className="font-semibold">{l.unit_price.toLocaleString("mn-MN")}₮/ш</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-1 text-[11px] text-amber-700/80">
                      Үргэлжлүүлэн нэмж болно — энэ зөвхөн сэрэмжлүүлэг.
                    </div>
                  </div>
                )}

                {/* Brand override — chips + searchable picker */}
                {(() => {
                  const isBrandless = !(selected.brand || "").trim();
                  const brandPicked = !!(addBrand && addBrand.trim());
                  const needsBrand  = isBrandless && !brandPicked;
                  // Сонгох боломжтой бүх брэндийн нэгдсэн жагсаалт (давхрагүй)
                  const sessionBrandNames = (session?.brands ?? [])
                    .map(b => b.brand)
                    .filter(b => b && b !== "Брэнд байхгүй");
                  const seen = new Set<string>();
                  const allOptions: string[] = [];
                  const pushOpt = (b: string) => {
                    const v = (b || "").trim();
                    if (v && !seen.has(v)) { seen.add(v); allOptions.push(v); }
                  };
                  if (selected.brand) pushOpt(selected.brand);
                  sessionBrandNames.forEach(pushOpt);
                  allBrands.forEach(pushOpt);

                  return (
                <div className={`mt-3 ${needsBrand ? "rounded-xl border-2 border-red-300 bg-red-50/60 p-2" : ""}`}>
                  <label className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold">
                    {needsBrand
                      ? <span className="text-red-600">⚠ Брэндгүй бараа — заавал брэнд сонгоно уу</span>
                      : <span className="text-gray-500">Тулгах брэнд</span>}
                  </label>

                  {/* 1) Хурдан chip товчнууд: барааны өөрийн brand + session brands */}
                  {(selected.brand || sessionBrandNames.length > 0) && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {selected.brand && (
                        <button
                          type="button"
                          onClick={() => setAddBrand("")}
                          className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-all ${
                            !addBrand || addBrand === selected.brand
                              ? "bg-[#0071E3] text-white shadow-sm"
                              : "bg-[#0071E3]/10 text-[#0071E3] hover:bg-[#0071E3]/20"
                          }`}
                        >
                          {selected.brand}
                        </button>
                      )}
                      {sessionBrandNames.filter(b => b !== selected.brand).map(b => (
                        <button
                          key={`s-${b}`}
                          type="button"
                          onClick={() => setAddBrand(b)}
                          className={`rounded-full px-3 py-1 text-[12px] font-semibold transition-all ${
                            addBrand === b
                              ? "bg-[#0071E3] text-white shadow-sm"
                              : "bg-[#0071E3]/10 text-[#0071E3] hover:bg-[#0071E3]/20"
                          }`}
                        >
                          {b}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* 2) Searchable picker for system brands */}
                  <BrandSearchPicker
                    value={addBrand && addBrand !== selected.brand ? addBrand : ""}
                    options={allOptions}
                    onChange={(b) => setAddBrand(b)}
                    placeholder={needsBrand ? "Брэнд сонгоно уу…" : "Бусад брэнд хайх…"}
                    warn={needsBrand}
                    className="max-w-xs"
                  />

                  {addBrand && addBrand !== (selected.brand || "") && (
                    <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200/60">
                      <AlertTriangle size={11}/>
                      <span className="font-semibold">{selected.brand || "брэндгүй"}</span> бараа{" "}
                      <span className="font-semibold">{addBrand}</span> брэнд дор тулгагдана
                    </p>
                  )}
                </div>
                  );
                })()}

                <div className="mt-3 grid grid-cols-2 gap-2.5">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-gray-500">
                      Ирсэн тоо (ширхэг)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={addQty}
                      onChange={e => setAddQty(e.target.value)}
                      autoFocus
                      placeholder="0"
                      inputMode="numeric"
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-right text-[18px] font-semibold tabular-nums outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-lg"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-gray-500">
                      Нэгж үнэ (₮/ш)
                    </label>
                    <input
                      type="number"
                      min={0}
                      step={1}
                      value={addPrice}
                      onChange={e => setAddPrice(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") addLine(); }}
                      placeholder="0"
                      inputMode="numeric"
                      className="w-full rounded-xl border border-gray-200 bg-white px-3 py-3 text-right text-[18px] font-semibold tabular-nums outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-lg"
                    />
                  </div>
                </div>

                {/* Live total preview */}
                {addQty && addPrice && !isNaN(parseFloat(addQty)) && !isNaN(parseFloat(addPrice)) && (
                  <div className="mt-2.5 flex items-center justify-between rounded-lg bg-white/70 px-3 py-1.5 text-xs">
                    <span className="text-gray-500">Нийт дүн</span>
                    <span className="font-bold tabular-nums text-gray-900">
                      {(parseFloat(addQty) * parseFloat(addPrice)).toLocaleString("mn-MN")}₮
                    </span>
                  </div>
                )}

                {(() => {
                  const isBrandless = !(selected.brand || "").trim();
                  const brandPicked = !!(addBrand && addBrand.trim());
                  const needsBrand  = isBrandless && !brandPicked;
                  return (
                    <button
                      onClick={addLine}
                      disabled={needsBrand}
                      className={`mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl py-3 text-sm font-semibold shadow-sm transition active:scale-[0.99] ${
                        needsBrand
                          ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                          : "bg-[#0071E3] text-white hover:bg-[#005BB5]"
                      }`}
                    >
                      <Plus size={16}/> {needsBrand ? "Эхлээд брэнд сонго" : "Нэмэх"}
                    </button>
                  );
                })()}
              </div>
            )}

            {/* Recently added — so user sees what's going in */}
            {recentlyAdded.length > 0 && (
              <div className="mt-3 rounded-xl bg-gray-50/70 p-2.5">
                <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-gray-400">
                  <span>Сүүлд нэмсэн</span>
                  <button
                    onClick={() => setRecentlyAdded([])}
                    className="rounded px-1.5 py-0.5 text-[10px] normal-case text-gray-400 hover:bg-white hover:text-gray-600"
                  >
                    Арилгах
                  </button>
                </div>
                <ul className="space-y-1">
                  {recentlyAdded.map(r => (
                    <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg bg-white px-2.5 py-1.5 text-[11px] ring-1 ring-gray-100">
                      <span className="truncate text-gray-700">
                        <CheckCircle2 size={11} className="mr-1 inline text-emerald-500"/>
                        {r.name}
                      </span>
                      <span className="shrink-0 tabular-nums text-gray-500">
                        {r.qty.toFixed(0)}ш · {r.amount.toLocaleString("mn-MN")}₮
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Brand summary — Desktop: side panel; Mobile: hidden when mobileView === 'lines' */}
        {session.brands.length > 0 && (
          <div className={`rounded-apple bg-white shadow-sm ring-1 ring-gray-100 lg:[grid-area:sidebar] lg:flex lg:flex-col lg:max-h-[calc(100vh-10rem)] lg:overflow-hidden ${mobileView === "lines" ? "hidden lg:block" : ""} p-4 lg:p-0`}>
            {/* Sidebar header (mobile: regular, desktop: compact sticky) */}
            <div className="mb-2.5 flex items-center justify-between lg:mb-0 lg:shrink-0 lg:border-b lg:border-gray-100 lg:bg-gray-50/60 lg:px-3 lg:py-2.5">
              <div>
                <div className="hidden lg:block text-[9px] font-semibold uppercase tracking-wider text-gray-400">Брэндүүд</div>
                <h3 className="text-sm font-semibold text-gray-800 lg:text-[12px] lg:mt-0.5">
                  <span className="lg:hidden">Брэнд бүрийн тулгалт</span>
                  <span className="hidden lg:inline">{session.brands.length} брэнд · {matchedBrandCount} тулгасан</span>
                </h3>
              </div>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600 lg:hidden">
                {matchedBrandCount}/{session.brands.length}
              </span>
            </div>

            <div className={`grid grid-cols-1 gap-2 ${canEdit ? "sm:grid-cols-2" : "sm:grid-cols-2 lg:grid-cols-3"} lg:!grid-cols-1 lg:gap-1 lg:overflow-y-auto lg:p-2`}>
              {/* "Бүгд" row — desktop only, шүүлтийг арилгана */}
              <button
                onClick={() => setFilterBrand("")}
                className={`hidden lg:flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left transition ${
                  !filterBrand
                    ? "bg-white shadow-sm ring-1 ring-gray-200"
                    : "hover:bg-white"
                }`}
              >
                <span className="text-[12px] font-semibold text-gray-800">Бүгд</span>
                <span className="text-[11px] text-gray-500 tabular-nums">{session.line_count}</span>
              </button>

              {session.brands.map(b => {
                const isActive = filterBrand === b.brand;
                const zColor = b.is_matched
                  ? (b.has_price_diff ? "bg-amber-400" : "bg-emerald-500")
                  : "bg-gray-300";
                const priceDiff = b.is_matched ? (b.supplier_total_amount - b.total_amount) : 0;
                return (
                <div
                  key={b.brand}
                  onClick={() => {
                    // Desktop: бүтэн карт дээр дарахад шүүх (toggle)
                    if (window.matchMedia("(min-width: 1024px)").matches) {
                      setFilterBrand(filterBrand === b.brand ? "" : b.brand);
                    }
                  }}
                  className={`relative rounded-xl border p-3 transition lg:cursor-pointer lg:rounded-lg lg:border-0 lg:p-2.5 lg:pl-3.5 lg:hover:bg-white ${
                    isActive
                      ? "lg:!bg-white lg:!shadow-sm lg:!ring-1 lg:!ring-gray-200"
                      : ""
                  } ${
                    b.is_matched
                      ? "border-emerald-200 bg-emerald-50/40 lg:!bg-transparent"
                      : "border-gray-200 bg-gray-50/40 lg:!bg-transparent"
                  } ${isActive ? "lg:!bg-white" : ""}`}
                >
                  {/* Status zusmel — design-ийн дагуу зүүн талд 3px зураас (lg only) */}
                  <span className={`hidden lg:block absolute left-0 top-2 bottom-2 w-[3px] rounded ${zColor}`}/>

                  {/* Title + status icon + receipt thumb */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {/* Mobile: бүрэн icon, Desktop: жижиг dot icon */}
                        <CheckCircle2 size={14} className={`shrink-0 text-emerald-600 lg:hidden ${b.is_matched ? "" : "hidden"}`}/>
                        <Clock size={14} className={`shrink-0 text-amber-500 lg:hidden ${!b.is_matched ? "" : "hidden"}`}/>
                        <span className="truncate text-sm font-semibold text-gray-900 lg:text-[13px]">{b.brand}</span>
                        {/* Desktop: status badge зөвхөн жижиг dot */}
                        {b.is_matched && !b.has_price_diff && (
                          <span className="hidden lg:inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-500 text-white shrink-0">
                            <Check size={9} strokeWidth={3.5}/>
                          </span>
                        )}
                        {b.has_price_diff && (
                          <span className="hidden lg:inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-amber-400 text-white shrink-0">
                            <AlertTriangle size={9} strokeWidth={3}/>
                          </span>
                        )}
                      </div>
                      {/* Stats — бүтэн label, бүтэн тоо. Sidebar нарийн тул 2 мөрөөр уралдана:
                          1-р мөр: Бараа: 4   ·   Нийт ширхэг: 330
                          2-р мөр: Дүн: 1,330,000₮
                          Хэт нарийн (mobile) дээр compact: 4 бараа · 330ш · 1.3сая₮ */}
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500 lg:mt-1.5 lg:text-[10.5px]">
                        {/* Mobile compact */}
                        <span className="tabular-nums lg:hidden">{b.line_count} бараа</span>
                        <span className="tabular-nums lg:hidden">· {b.total_pcs.toFixed(0)}ш</span>
                        <span className="ml-auto font-medium tabular-nums text-gray-700 lg:hidden">
                          {fmtMnt(b.total_amount)}
                        </span>
                        {/* Desktop sidebar: full labels, no abbreviation */}
                        <span className="hidden lg:inline tabular-nums">
                          <span className="opacity-70">Бараа:</span>{" "}
                          <span className="font-semibold text-gray-800">{b.line_count}</span>
                        </span>
                        <span className="hidden lg:inline tabular-nums">
                          <span className="opacity-70">·</span>{" "}
                          <span className="opacity-70">Нийт ширхэг:</span>{" "}
                          <span className="font-semibold text-gray-800">{b.total_pcs.toLocaleString("mn-MN")}</span>
                        </span>
                        <span className="hidden lg:inline w-full tabular-nums">
                          <span className="opacity-70">Дүн:</span>{" "}
                          <span className="font-bold text-gray-800">{b.total_amount.toLocaleString("mn-MN")}₮</span>
                        </span>
                      </div>
                    </div>
                    {/* Mobile: AlertTriangle badge для price diff */}
                    {b.has_price_diff && (
                      <span
                        title="Үнэ зөрүүтэй мөртэй"
                        className="lg:hidden shrink-0 inline-flex items-center gap-0.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 ring-1 ring-inset ring-red-200/60"
                      >
                        <AlertTriangle size={10}/> зөрүү
                      </span>
                    )}
                    {/* Desktop: receipt thumbnail */}
                    {b.is_matched && b.receipt_image_path && (
                      <button
                        onClick={(e) => { e.stopPropagation(); viewReceipt(b.brand); }}
                        disabled={receiptLoading}
                        title="Баримт харах"
                        className="hidden lg:grid h-6 w-6 place-items-center rounded bg-blue-100 text-[#0071E3] shrink-0 hover:bg-blue-200 disabled:opacity-50"
                      >
                        <ImageIcon size={11}/>
                      </button>
                    )}
                  </div>

                  {/* Matched meta — mobile only (desktop-д supplier нийлбэрийг хасна) */}
                  {b.is_matched && (
                    <div className="mt-2 rounded-lg bg-white/70 px-2 py-1 text-[10px] text-gray-500 lg:hidden">
                      <div className="flex items-center justify-between gap-1">
                        <span>Нийлүүлэгч:</span>
                        <span className="tabular-nums text-gray-700">
                          {b.supplier_total_pcs.toFixed(0)}ш · {b.supplier_total_amount.toLocaleString("mn-MN")}₮
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Desktop: Үнэ зөрүүний тэмдэглэл — амбер фон */}
                  {b.has_price_diff && Math.abs(priceDiff) > 0.5 && (
                    <div className="hidden lg:inline-block mt-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-800 ring-1 ring-inset ring-amber-200/60">
                      Үнэ {priceDiff.toLocaleString("mn-MN")}₮ зөрүүтэй
                    </div>
                  )}

                  {/* Desktop: "Баримт нэмэх" dashed button — зөвхөн not matched + canEdit */}
                  {!b.is_matched && canEdit && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmBrand(b);
                        setSupplierPcs(String(b.total_pcs.toFixed(0)));
                        setSupplierAmount(String(b.total_amount.toFixed(0)));
                        setReceiptFile(null);
                      }}
                      className="hidden lg:inline-flex mt-1.5 w-full items-center justify-center gap-1 rounded border border-dashed border-[#0071E3] bg-transparent px-2 py-1 text-[10.5px] font-semibold text-[#0071E3] hover:bg-[#0071E3]/5"
                    >
                      <Upload size={10}/> Баримт нэмэх
                    </button>
                  )}

                  {/* Mobile: legacy Шүүж харах / Тулгах / Буцаах товчнууд (lg:hidden) */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5 lg:hidden">
                    <button
                      onClick={(e) => { e.stopPropagation(); setFilterBrand(b.brand); setPriceDiffOnly(false); setMobileView("lines"); }}
                      className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-700 shadow-sm ring-1 ring-inset ring-gray-200/70 hover:bg-gray-50"
                    >
                      <Eye size={11}/> Шүүж харах
                    </button>
                    {!b.is_matched && canEdit && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmBrand(b);
                          setSupplierPcs(String(b.total_pcs.toFixed(0)));
                          setSupplierAmount(String(b.total_amount.toFixed(0)));
                          setReceiptFile(null);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-[#005BB5]"
                      >
                        <Check size={11}/> Тулгах
                      </button>
                    )}
                    {b.is_matched && b.receipt_image_path && (
                      <button
                        onClick={(e) => { e.stopPropagation(); viewReceipt(b.brand); }}
                        disabled={receiptLoading}
                        className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-medium text-blue-600 shadow-sm ring-1 ring-inset ring-blue-200/60 hover:bg-blue-50 disabled:opacity-50"
                      >
                        <ImageIcon size={11}/> Баримт
                      </button>
                    )}
                    {b.is_matched && canEdit && (role === "admin" || role === "manager" || role === "supervisor") && (
                      <button
                        onClick={(e) => { e.stopPropagation(); unmatch(b.brand); }}
                        className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1.5 text-[11px] font-medium text-red-500 ring-1 ring-inset ring-red-200/50 hover:bg-red-50"
                        title="Тулгалтыг буцаах"
                      >
                        <Undo2 size={11}/>
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>

            {/* Desktop: footer hint */}
            <div className="hidden lg:block shrink-0 border-t border-gray-100 px-3 py-2 text-center text-[10px] text-gray-400">
              Брэнд автоматаар бараагаар үүсгэгдэнэ
            </div>
          </div>
        )}

      {/* Mobile view toggle: Брэнд тулгалт ↔ Бараа жагсаалт (зөвхөн mobile дээр) */}
      {session.brands.length > 0 && (
        <div className="mb-3 flex rounded-2xl bg-white p-1 shadow-sm ring-1 ring-gray-100 lg:hidden">
          <button
            onClick={() => setMobileView("brands")}
            className={`flex-1 rounded-xl py-2 text-[12px] font-bold transition-all ${
              mobileView === "brands"
                ? "bg-[#0071E3] text-white shadow-sm"
                : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Брэнд тулгалт
          </button>
          <button
            onClick={() => setMobileView("lines")}
            className={`flex-1 rounded-xl py-2 text-[12px] font-bold transition-all ${
              mobileView === "lines"
                ? "bg-[#0071E3] text-white shadow-sm"
                : "text-gray-500 hover:bg-gray-50"
            }`}
          >
            Бараа жагсаалт
          </button>
        </div>
      )}

      {/* Lines section wrapper — Mobile дээр зөвхөн mobileView === "lines" үед харагдана */}
      <div className={`lg:[grid-area:main-bottom] ${mobileView === "brands" && session.brands.length > 0 ? "hidden lg:block" : ""}`}>

      {/* Filter bar — sticky on desktop, search + brand chips + diff toggle */}
      <div className="sticky top-0 z-20 mb-2 rounded-apple bg-white p-2 shadow-sm ring-1 ring-gray-100 lg:top-2">
        {/* Top row: count + search + clear */}
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-700 tabular-nums">
            {visibleLines.length} мөр
          </span>
          <div className="flex flex-1 min-w-0 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1 transition focus-within:border-[#0071E3] focus-within:ring-2 focus-within:ring-[#0071E3]/15">
            <Search size={13} className="shrink-0 text-gray-400"/>
            <input
              value={filterText}
              onChange={e => setFilterText(e.target.value)}
              placeholder="Барааны нэр / код-оор шүүх…"
              className="flex-1 min-w-0 bg-transparent text-[13px] outline-none placeholder:text-gray-400"
              inputMode="search"
            />
            {filterText && (
              <button
                onClick={() => setFilterText("")}
                className="shrink-0 rounded p-0.5 text-gray-400 hover:bg-gray-100"
                aria-label="Цэвэрлэх"
              >
                <X size={11}/>
              </button>
            )}
          </div>
          {session.status === "price_review" && (
            <button
              onClick={() => setPriceDiffOnly(v => !v)}
              className={`shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition ${
                priceDiffOnly
                  ? "bg-red-600 text-white shadow-sm"
                  : "bg-red-50 text-red-600 ring-1 ring-inset ring-red-200/60 hover:bg-red-100"
              }`}
            >
              <AlertTriangle size={11}/>
              <span className="hidden sm:inline">Зөрүү</span>
              {priceDiffOnly ? <X size={10}/> : null}
            </button>
          )}
          {(filterBrand || priceDiffOnly || filterText) && (
            <button
              onClick={() => { setFilterBrand(""); setPriceDiffOnly(false); setFilterText(""); }}
              className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-[11px] text-gray-600 hover:bg-gray-50"
              title="Бүх шүүлт цэвэрлэх"
            >
              <X size={11}/>
            </button>
          )}
        </div>

        {/* Brand chips row — quick visual filter */}
        {session.brands.length > 1 && (
          <div className="mt-1.5 flex flex-wrap gap-1 overflow-x-auto">
            <button
              onClick={() => setFilterBrand("")}
              className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                !filterBrand
                  ? "bg-[#0071E3] text-white shadow-sm"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              Бүгд · {session.brands.reduce((s, b) => s + b.line_count, 0)}
            </button>
            {session.brands.map(b => (
              <button
                key={b.brand}
                onClick={() => setFilterBrand(filterBrand === b.brand ? "" : b.brand)}
                className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition ${
                  filterBrand === b.brand
                    ? "bg-[#0071E3] text-white shadow-sm"
                    : b.is_matched
                      ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60 hover:bg-emerald-100"
                      : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {b.is_matched && <CheckCircle2 size={10}/>}
                <span className="truncate max-w-[140px]">{b.brand}</span>
                <span className="opacity-60">{b.line_count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Price-diff summary banner — price_review статусын үед */}
      {session.status === "price_review" && (() => {
        const diffLines = session.lines.filter(
          l => l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01
        );
        const fixedCount = diffLines.filter(l => l.price_reviewed).length;
        if (diffLines.length === 0) return null;
        const allFixed = fixedCount === diffLines.length;
        return (
          <div
            className={`mb-2 flex items-center justify-between rounded-2xl px-3.5 py-2.5 ring-1 ring-inset ${
              allFixed
                ? "bg-emerald-50 ring-emerald-200/60"
                : "bg-amber-50 ring-amber-200/60"
            }`}
          >
            <div className="flex items-center gap-2">
              {allFixed
                ? <CheckCircle2 size={16} className="text-emerald-600"/>
                : <AlertTriangle size={16} className="text-amber-700"/>}
              <div>
                <div className={`text-[12px] font-bold ${allFixed ? "text-emerald-800" : "text-amber-900"}`}>
                  {allFixed ? "Бүх үнэ хянагдсан" : "Үнийн зөрүү илэрсэн"}
                </div>
                <div className={`text-[10px] ${allFixed ? "text-emerald-700" : "text-amber-700"}`}>
                  {fixedCount}/{diffLines.length} мөрийн үнэ хянагдсан
                </div>
              </div>
            </div>
            <div className={`text-[18px] font-extrabold tabular-nums ${allFixed ? "text-emerald-600" : "text-red-500"}`}>
              {fixedCount}/{diffLines.length}
            </div>
          </div>
        );
      })()}

      {/* Lines list */}
      <div className="overflow-hidden rounded-apple bg-white shadow-sm ring-1 ring-gray-100">
        {visibleLines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14 text-gray-400">
            <Package size={28} className="text-gray-200"/>
            <span className="text-sm">Мөр байхгүй</span>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {Object.entries(visibleByBrand).sort(([a], [b]) => a.localeCompare(b)).map(([brand, lns]) => {
              const brandTotalQty = lns.reduce((s, l) => s + l.qty_pcs, 0);
              const brandTotalAmount = lns.reduce((s, l) => s + l.total_amount, 0);
              return (
                <div key={brand}>
                  {/* Brand header — sticky on desktop so it stays visible on long scroll */}
                  <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-gray-100 bg-gray-50/90 px-3 py-2 backdrop-blur">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-xs font-bold uppercase tracking-wide text-gray-700">{brand}</span>
                      <span className="shrink-0 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 ring-1 ring-inset ring-gray-200/60">
                        {lns.length}
                      </span>
                    </div>
                    <span className="text-[11px] font-medium tabular-nums text-gray-600">
                      {brandTotalQty.toFixed(0)}ш ·{" "}
                      <span className="text-gray-800">{brandTotalAmount.toLocaleString("mn-MN")}₮</span>
                    </span>
                  </div>

                  {/* Desktop: dense table; Mobile: cards */}
                  <div className="hidden lg:block">
                    <table className="w-full text-sm">
                      <thead className="border-b border-gray-100 bg-white text-left text-[10px] uppercase tracking-wide text-gray-400">
                        <tr>
                          <th className="px-3 py-2 font-medium">Бараа</th>
                          <th className="px-3 py-2 font-medium text-right w-[130px]">Тоо (ш)</th>
                          <th className="px-3 py-2 font-medium text-right w-[150px]">Нэгж үнэ</th>
                          <th className="px-3 py-2 font-medium text-right w-[130px]">Дүн</th>
                          {canEdit && <th className="px-3 py-2 w-[48px]"></th>}
                          {(session.status === "price_review" || session.status === "received") && <th className="px-3 py-2 text-right w-[110px]">Үнэ хянах</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {lns.map(l => {
                          const priceDiff = l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01;
                          // Үнэ хяналт нь price_review + received хоёр статуст ажиллах ёстой.
                          // Зөвхөн badge / column рамдаа л харагдаж байгаагаас гадна received-д
                          // зөвхөн зөрүүтэй мөрд "Хянах" товч харагдана (доорх showReviewBtn-тэй хослуулна).
                          const isPriceReview = session.status === "price_review" || session.status === "received";
                          const isReceivedReview = session.status === "received";
                          // received статуст: зөвхөн үнэ зөрсөн мөрд хянах боломж нээнэ.
                          // price_review статуст: бүх мөрд (хуучин зан үйл хэвээр)
                          const showReviewBtn = isPriceReview && (!isReceivedReview || priceDiff);
                          const rowBg = priceDiff && !l.price_reviewed && isPriceReview
                            ? "bg-red-50/40"
                            : l.price_reviewed && isPriceReview
                              ? "bg-emerald-50/40"
                              : priceDiff
                                ? "bg-red-50/30"
                                : "hover:bg-gray-50/40";
                          return (
                            <tr key={l.id} className={rowBg}>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <div className="text-sm font-medium text-gray-800 leading-snug">{l.name}</div>
                                  {l.override_brand && l.original_brand && l.override_brand !== l.original_brand && (
                                    <span
                                      title={`Анхдагч брэнд: ${l.original_brand}`}
                                      className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200/60"
                                    >
                                      ↺ {l.original_brand}
                                    </span>
                                  )}
                                  {isPriceReview && l.price_reviewed && (
                                    <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200/60">
                                      <Check size={9} strokeWidth={3}/> Үнэ хянасан
                                    </span>
                                  )}
                                  {isPriceReview && priceDiff && !l.price_reviewed && (
                                    <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 ring-1 ring-inset ring-red-200/60">
                                      <AlertTriangle size={9}/> Үнэ зөрүүтэй
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-400">
                                  <span className="font-mono">{l.item_code}</span>
                                  <span>· {l.pack_ratio}ш/хайрцаг</span>
                                  <span className="text-gray-300">
                                    · хасвал {l.stock_box} хайрцаг{l.stock_extra_pcs > 0 ? ` + ${l.stock_extra_pcs}ш` : ""}
                                  </span>
                                </div>
                                {/* Бренд солих dropdown */}
                                {canEdit && (
                                  <div className={`mt-1 flex items-center gap-1 rounded ${
                                    !(l.brand || "").trim() ? "bg-red-50 px-1 py-0.5 ring-1 ring-red-200" : ""
                                  }`}>
                                    <span className={`text-[10px] font-semibold ${
                                      !(l.brand || "").trim() ? "text-red-700" : "text-gray-400"
                                    }`}>
                                      {!(l.brand || "").trim() ? "⚠ Брэнд:" : "Бренд:"}
                                    </span>
                                    <select
                                      value={(l.brand || "").trim()}
                                      onChange={e => {
                                        const picked = e.target.value;
                                        const orig = (l.original_brand || "").trim();
                                        const newOverride = picked === orig ? "" : picked;
                                        updateLine(l.id, { override_brand: newOverride });
                                      }}
                                      className={`rounded border bg-white px-1.5 py-0.5 text-[10px] outline-none focus:ring-1 ${
                                        !(l.brand || "").trim()
                                          ? "border-red-300 focus:border-red-500 focus:ring-red-300/40"
                                          : "border-gray-200 focus:border-[#0071E3] focus:ring-[#0071E3]/15"
                                      }`}
                                    >
                                      {!l.brand && <option value="">— Сонго —</option>}
                                      {getBrandOptions(l, session?.brands ?? [], allBrands).map(b => (
                                        <option key={b} value={b}>
                                          {b}{b === l.original_brand ? " (анх)" : ""}
                                        </option>
                                      ))}
                                    </select>
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                {canEdit ? (
                                  <input
                                    type="number" min={0} step={1} defaultValue={l.qty_pcs}
                                    inputMode="numeric"
                                    onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== l.qty_pcs) updateLine(l.id, { qty_pcs: v }); }}
                                    className="w-full rounded-lg border border-gray-200 bg-white px-2 py-1.5 text-right text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                                  />
                                ) : (
                                  <div className="text-right text-sm tabular-nums text-gray-800">{l.qty_pcs.toFixed(0)}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 align-top">
                                {canEdit ? (
                                  <input
                                    type="number" min={0} step={1} defaultValue={l.unit_price}
                                    inputMode="numeric"
                                    onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== l.unit_price) updateLine(l.id, { unit_price: v }); }}
                                    className={`w-full rounded-lg border px-2 py-1.5 text-right text-sm tabular-nums outline-none ${
                                      priceDiff
                                        ? "border-red-300 bg-red-50 text-red-700 focus:border-red-400 focus:ring-1 focus:ring-red-300/30"
                                        : "border-gray-200 bg-white focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                                    }`}
                                  />
                                ) : (
                                  <div className={`text-right text-sm tabular-nums ${priceDiff ? "font-semibold text-red-600" : "text-gray-800"}`}>
                                    {l.unit_price.toLocaleString("mn-MN")}
                                  </div>
                                )}
                                <div className="mt-0.5 text-right text-[9px] text-gray-400">
                                  {l.last_purchase_price > 0 ? `хуучин ${l.last_purchase_price.toLocaleString("mn-MN")}` : "—"}
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right align-top">
                                <div className="text-sm font-semibold tabular-nums text-gray-900">
                                  {l.total_amount.toLocaleString("mn-MN")}
                                </div>
                              </td>
                              {canEdit && (
                                <td className="px-3 py-2.5 align-top text-right">
                                  <button
                                    onClick={() => deleteLine(l.id)}
                                    className="rounded-lg border border-red-200 bg-red-50 p-1.5 text-red-500 transition hover:bg-red-100"
                                    title="Устгах"
                                  >
                                    <Trash2 size={14}/>
                                  </button>
                                </td>
                              )}
                              {isPriceReview && (
                                <td className="px-3 py-2.5 align-top text-right">
                                  {showReviewBtn ? (
                                    <button
                                      onClick={() => togglePriceReview(l.id, !l.price_reviewed)}
                                      className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                                        l.price_reviewed
                                          ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60 hover:bg-emerald-100"
                                          : "bg-[#0071E3]/10 text-[#0071E3] hover:bg-[#0071E3]/20"
                                      }`}
                                      title={l.price_reviewed ? "Хянагдсан тэмдэглэгээг авах" : "Хянасан гэж тэмдэглэх"}
                                    >
                                      <Check size={11} strokeWidth={2.6}/>
                                      {l.price_reviewed ? "Хянасан" : "Хянах"}
                                    </button>
                                  ) : (
                                    <span className="text-[10px] text-gray-300">—</span>
                                  )}
                                </td>
                              )}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile/tablet cards */}
                  <div className="lg:hidden">
                    {lns.map(l => {
                      const priceDiff = l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01;
                      // Desktop-той ижил утга: price_review + received хоёрт үнэ хяналт нээгдэнэ;
                      // received-д зөвхөн зөрсөн мөрд "Хянах" товч харагдана.
                      const isPriceReview = session.status === "price_review" || session.status === "received";
                      const isReceivedReview = session.status === "received";
                      const showReviewBtn = isPriceReview && (!isReceivedReview || priceDiff);
                      const rowBg = priceDiff && !l.price_reviewed && isPriceReview
                        ? "bg-red-50/40"
                        : l.price_reviewed && isPriceReview
                          ? "bg-emerald-50/40"
                          : priceDiff
                            ? "bg-red-50/30"
                            : "";
                      return (
                        <div key={l.id} className={`px-3 py-3 ${rowBg}`}>
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <div className="break-words text-[13px] font-medium leading-snug text-gray-800">{l.name}</div>
                                {l.override_brand && l.original_brand && l.override_brand !== l.original_brand && (
                                  <span
                                    title={`Анхдагч брэнд: ${l.original_brand}`}
                                    className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200/60"
                                  >
                                    ↺ {l.original_brand}
                                  </span>
                                )}
                                {isPriceReview && l.price_reviewed && (
                                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700 ring-1 ring-inset ring-emerald-200/60">
                                    <Check size={9} strokeWidth={3}/> Үнэ хянасан
                                  </span>
                                )}
                                {isPriceReview && priceDiff && !l.price_reviewed && (
                                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[9px] font-bold text-red-700 ring-1 ring-inset ring-red-200/60">
                                    <AlertTriangle size={9}/> Үнэ зөрүүтэй
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 text-[10px] text-gray-400">
                                <span className="font-mono">{l.item_code}</span>
                                <span className="ml-1.5 text-gray-300">· {l.pack_ratio}ш/хайрцаг</span>
                              </div>
                              {/* Бренд солих dropdown (mobile) */}
                              {canEdit && (
                                <div className="mt-1.5 flex items-center gap-1.5">
                                  <span className="text-[10px] text-gray-400">Бренд:</span>
                                  <select
                                    value={(l.brand || "").trim()}
                                    onChange={e => {
                                      const picked = e.target.value;
                                      const orig = (l.original_brand || "").trim();
                                      const newOverride = picked === orig ? "" : picked;
                                      updateLine(l.id, { override_brand: newOverride });
                                    }}
                                    className="flex-1 rounded border border-gray-200 bg-white px-2 py-1 text-[11px] outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                                  >
                                    {!l.brand && <option value="">— Сонго —</option>}
                                    {getBrandOptions(l, session?.brands ?? [], allBrands).map(b => (
                                      <option key={b} value={b}>
                                        {b}{b === l.original_brand ? " (анх)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                </div>
                              )}
                            </div>
                            {canEdit && (
                              <button
                                onClick={() => deleteLine(l.id)}
                                className="shrink-0 rounded-lg border border-red-200 bg-red-50 p-2 text-red-500 active:bg-red-100"
                                title="Устгах"
                              >
                                <Trash2 size={14}/>
                              </button>
                            )}
                            {showReviewBtn && (
                              <button
                                onClick={() => togglePriceReview(l.id, !l.price_reviewed)}
                                className={`shrink-0 inline-flex items-center gap-1 rounded-lg px-2.5 py-2 text-[11px] font-bold transition active:scale-95 ${
                                  l.price_reviewed
                                    ? "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200/60"
                                    : "bg-[#0071E3]/10 text-[#0071E3]"
                                }`}
                              >
                                <Check size={12} strokeWidth={2.6}/>
                                {l.price_reviewed ? "Хянасан" : "Хянах"}
                              </button>
                            )}
                          </div>

                          <div className="mt-2 grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-[9px] font-medium uppercase tracking-wide text-gray-400">Тоо (ширхэг)</label>
                              {canEdit ? (
                                <input
                                  type="number" min={0} step={1} defaultValue={l.qty_pcs}
                                  inputMode="numeric"
                                  onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== l.qty_pcs) updateLine(l.id, { qty_pcs: v }); }}
                                  className="mt-0.5 w-full rounded-lg border border-gray-200 bg-white px-2 py-2 text-right text-[16px] font-semibold tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                                />
                              ) : (
                                <div className="mt-0.5 px-2 py-2 text-right text-sm font-semibold tabular-nums text-gray-800">{l.qty_pcs.toFixed(0)}</div>
                              )}
                              <div className="mt-0.5 text-right text-[9px] text-gray-400">
                                {l.stock_box} хайрцаг{l.stock_extra_pcs > 0 ? ` + ${l.stock_extra_pcs}ш` : ""}
                              </div>
                            </div>
                            <div>
                              <label className="block text-[9px] font-medium uppercase tracking-wide text-gray-400">Нэгж үнэ</label>
                              {canEdit ? (
                                <input
                                  type="number" min={0} step={1} defaultValue={l.unit_price}
                                  inputMode="numeric"
                                  onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== l.unit_price) updateLine(l.id, { unit_price: v }); }}
                                  className={`mt-0.5 w-full rounded-lg border px-2 py-2 text-right text-[16px] font-semibold tabular-nums outline-none ${
                                    priceDiff
                                      ? "border-red-300 bg-red-50 text-red-700"
                                      : "border-gray-200 bg-white focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                                  }`}
                                />
                              ) : (
                                <div className={`mt-0.5 px-2 py-2 text-right text-sm font-semibold tabular-nums ${priceDiff ? "text-red-600" : "text-gray-800"}`}>
                                  {l.unit_price.toLocaleString("mn-MN")}
                                </div>
                              )}
                              <div className="mt-0.5 text-right text-[9px] text-gray-400">
                                {l.last_purchase_price > 0
                                  ? <>хуучин {l.last_purchase_price.toLocaleString("mn-MN")}</>
                                  : "—"}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 flex items-center justify-between border-t border-dashed border-gray-100 pt-1.5">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-gray-400">Нийт дүн</span>
                            <span className="text-sm font-bold tabular-nums text-gray-900">
                              {l.total_amount.toLocaleString("mn-MN")}₮
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>{/* /Lines section wrapper */}
      </div>{/* /Outer split-view grid */}

      {/* Brand confirm modal */}
      {confirmBrand && (
        <BrandConfirmModal
          brand={confirmBrand}
          supplierPcs={supplierPcs}
          setSupplierPcs={setSupplierPcs}
          supplierAmount={supplierAmount}
          setSupplierAmount={setSupplierAmount}
          receiptFile={receiptFile}
          setReceiptFile={setReceiptFile}
          onClose={() => setConfirmBrand(null)}
          onSubmit={confirmBrandMatch}
          submitting={confirming}
        />
      )}

      {/* Error modal — дэлгэрэнгүй алдааны мессеж */}
      {errorModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => setErrorModal(null)}>
          <div
            className="w-full max-w-sm rounded-2xl bg-white shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 p-5">
              <div className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-500">
                <AlertCircle size={20}/>
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-sm font-semibold text-gray-900">Алдаа гарлаа</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-600 break-words">{errorModal}</p>
              </div>
            </div>
            <div className="border-t border-gray-100 px-5 py-3 flex justify-end">
              <button
                onClick={() => setErrorModal(null)}
                className="rounded-xl bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
              >
                Ойлголоо
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ERP modal */}
      {showERPModal && (
        <ERPExportModal session={session} onClose={() => setShowERPModal(false)}/>
      )}

      {/* Barcode scanner */}
      {showScanner && (
        <BarcodeScanner
          onDetected={handleBarcodeScan}
          onClose={() => setShowScanner(false)}
        />
      )}

      {/* Receipt image viewer */}
      {receiptView && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/85 p-4"
          onClick={() => { URL.revokeObjectURL(receiptView.url); setReceiptView(null); }}
        >
          <div
            className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 sm:px-5">
              <div className="flex items-center gap-2 min-w-0">
                <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#0071E3]/10 text-[#0071E3]">
                  <ImageIcon size={14}/>
                </div>
                <h3 className="truncate text-sm font-semibold text-gray-900">{receiptView.brand} — Баримт</h3>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setReceiptZoom(z => !z)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                  title={receiptZoom ? "Жижгэсгэх" : "Томруулах"}
                >
                  <span className="text-xs font-semibold tabular-nums">{receiptZoom ? "1×" : "2×"}</span>
                </button>
                <a
                  href={receiptView.url}
                  download={`receipt_${receiptView.brand}.jpg`}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
                  title="Татаж авах"
                >
                  <FileDown size={15}/>
                </a>
                <button
                  onClick={() => { URL.revokeObjectURL(receiptView.url); setReceiptView(null); }}
                  className="rounded-lg p-2 text-gray-400 hover:bg-gray-100"
                  title="Хаах (Esc)"
                >
                  <X size={16}/>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto bg-gray-50 p-2">
              <img
                src={receiptView.url}
                alt="receipt"
                onClick={() => setReceiptZoom(z => !z)}
                className={`mx-auto rounded-lg object-contain shadow-sm transition-transform duration-200 ${
                  receiptZoom ? "max-h-none cursor-zoom-out scale-[1.8] origin-top" : "max-h-[75vh] cursor-zoom-in"
                }`}
              />
            </div>
          </div>
        </div>
      )}

      {/* Scan: product not found modal */}
      {scanNotFound && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4" onClick={() => setScanNotFound(null)}>
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-600">
              <AlertCircle size={22}/>
            </div>
            <h3 className="text-center text-base font-semibold text-gray-900">Бараа олдсонгүй</h3>
            <p className="mt-2 text-center text-xs text-gray-500">
              <span className="font-mono font-medium text-gray-700">{scanNotFound}</span> гэсэн код/баркодтой бараа системд бүртгэгдээгүй байна.
            </p>
            <p className="mt-1.5 text-center text-[11px] text-gray-400">
              Нэрээр хайж үзэх, эсвэл шинэ бараа нэмэх хэрэгтэй байж магадгүй.
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => { setScanNotFound(null); setShowScanner(true); }}
                className="flex-1 rounded-lg border border-gray-200 bg-white py-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                Дахин скан
              </button>
              <button
                onClick={() => setScanNotFound(null)}
                className="flex-1 rounded-lg bg-[#0071E3] py-2.5 text-xs font-semibold text-white hover:bg-[#005BB5]"
              >
                Хаах
              </button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}

function BrandConfirmModal(p: {
  brand: BrandInfo;
  supplierPcs: string; setSupplierPcs: (v: string) => void;
  supplierAmount: string; setSupplierAmount: (v: string) => void;
  receiptFile: File | null; setReceiptFile: (f: File | null) => void;
  onClose: () => void; onSubmit: () => void; submitting: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);

  useEffect(() => {
    if (!p.receiptFile) { setPreview(null); return; }
    const url = URL.createObjectURL(p.receiptFile);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [p.receiptFile]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const ourPcs   = p.brand.total_pcs;
  const ourAmt   = p.brand.total_amount;
  const ourLines = p.brand.line_count;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={p.onClose}
    >
      <div
        className="flex max-h-[96vh] w-full max-w-md flex-col overflow-hidden rounded-t-3xl bg-white pb-[max(0px,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-apple sm:pb-0"
        onClick={e => e.stopPropagation()}
      >
        {/* grabber */}
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-200 sm:hidden"/>

        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <div className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <Check size={18}/>
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-gray-900">{p.brand.brand}</h2>
              <p className="text-[11px] text-gray-500">Баримт тулгах</p>
            </div>
          </div>
          <button onClick={p.onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100" aria-label="Хаах">
            <X size={16}/>
          </button>
        </div>

        <div className="flex-1 space-y-3.5 overflow-y-auto p-5">
          {/* Таны оруулсан мэдээлэл */}
          <div className="rounded-xl bg-gradient-to-br from-blue-50/60 to-gray-50 p-3.5 ring-1 ring-inset ring-blue-100/60">
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Таны оруулсан мэдээлэл
            </div>
            <div className="mt-1.5 grid grid-cols-3 gap-2">
              <div>
                <div className="text-[10px] text-gray-500">Бараа</div>
                <div className="text-base font-bold tabular-nums text-gray-900">{ourLines}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Нийт ш</div>
                <div className="text-base font-bold tabular-nums text-gray-900">{ourPcs.toFixed(0)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500">Нийт дүн</div>
                <div className="text-base font-bold tabular-nums text-gray-900">
                  {ourAmt.toLocaleString("mn-MN")}₮
                </div>
              </div>
            </div>
          </div>

          {/* Receipt upload / preview */}
          <div>
            <label className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-gray-500">
              Баримт зураг
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-normal text-gray-400">заавал биш</span>
            </label>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={e => p.setReceiptFile(e.target.files?.[0] ?? null)}
              className="hidden"
            />
            {preview ? (
              <div className="group relative overflow-hidden rounded-xl border-2 border-emerald-200 bg-black/5">
                <img src={preview} alt="баримт" className="w-full max-h-72 object-contain"/>
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2">
                  <span className="truncate text-[10px] text-white/90" title={p.receiptFile?.name}>
                    {p.receiptFile?.name}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => fileRef.current?.click()}
                      className="rounded-md bg-white/90 px-2 py-1 text-[10px] font-medium text-gray-700 backdrop-blur hover:bg-white"
                    >
                      <Camera size={10} className="mr-0.5 inline"/> Дахин авах
                    </button>
                    <button
                      onClick={() => p.setReceiptFile(null)}
                      className="rounded-md bg-white/90 p-1 text-red-600 backdrop-blur hover:bg-white"
                      title="Арилгах"
                    >
                      <Trash2 size={11}/>
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                className="flex min-h-[120px] w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 bg-gray-50 px-3 py-5 text-xs font-medium text-gray-600 transition hover:border-[#0071E3]/40 hover:bg-blue-50/40 hover:text-[#0071E3]"
              >
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-white ring-1 ring-gray-200">
                  <Camera size={18} className="text-gray-400"/>
                </div>
                <span>Зураг авах / сонгох</span>
                <span className="text-[10px] text-gray-400">Камер эсвэл галлерей</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={p.onClose}
            className="flex-1 rounded-apple border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:flex-none sm:px-4 sm:py-1.5"
          >
            Болих
          </button>
          <button
            onClick={p.onSubmit}
            disabled={p.submitting}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-apple bg-emerald-600 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-emerald-700 disabled:opacity-50 sm:flex-none sm:px-4 sm:py-1.5"
          >
            {p.submitting ? <RefreshCw size={13} className="animate-spin"/> : <Check size={13}/>}
            Тулгах
          </button>
        </div>
      </div>
    </div>
  );
}

function ERPExportModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const COMPANY_DEFAULTS: Record<string, { related_account: string; account: string; single_location: string }> = {
    buten_orgil:  { related_account: "310101", account: "150101", single_location: "" },
    orgil_khorum: { related_account: "310104", account: "150101", single_location: "05" },
  };
  // Бараа бүрийн warehouse_name-ээр group хийнэ. Эзэмшгүй (хоосон) барааг "" key-ээр харуулах боломжтой.
  const positiveLines = session.lines.filter(l => l.qty_pcs > 0);
  const warehouseCounts: Record<string, number> = {};
  for (const l of positiveLines) {
    const wh = (l.warehouse_name || "").trim();
    warehouseCounts[wh] = (warehouseCounts[wh] || 0) + 1;
  }
  // Тагтай агуулахуудыг эрэмбэлэн жагсаах. Хоосон (таггүй) бараа байвал жагсаалтын төгсгөлд тусдаа мөр.
  const warehouses = Object.keys(warehouseCounts).filter(Boolean).sort();
  const untaggedCount = warehouseCounts[""] || 0;
  const [cfg, setCfg] = useState({
    company: "buten_orgil" as "buten_orgil" | "orgil_khorum",
    document_note: "",
    related_account: COMPANY_DEFAULTS.buten_orgil.related_account,
    account: COMPANY_DEFAULTS.buten_orgil.account,
    warehouse_map: {} as Record<string, string>,
    single_location: "",
  });
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setErr(null);
    setLoading(true);
    try {
      const res = await api.post(`/receivings/${session.id}/export-erp-excel`, cfg, { responseType: "blob" });
      const cd = res.headers?.["content-disposition"] ?? "";
      let fname = `RECV${session.id}.xlsx`;
      const utf8 = cd.match(/filename\*=UTF-8''([^\s;]+)/i);
      if (utf8?.[1]) { try { fname = decodeURIComponent(utf8[1]); } catch {} }
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url; a.download = fname; a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e: any) {
      const blob = e?.response?.data;
      if (blob instanceof Blob) {
        try { const text = await blob.text(); const j = JSON.parse(text); setErr(j?.detail ?? text); }
        catch { setErr("Excel үүсгэхэд алдаа"); }
      } else setErr(e?.response?.data?.detail ?? "Алдаа");
    } finally { setLoading(false); }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[96vh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl bg-white pb-[max(0px,env(safe-area-inset-bottom))] shadow-2xl sm:rounded-apple sm:pb-0"
        onClick={e => e.stopPropagation()}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-gray-200 sm:hidden"/>
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-[#0071E3]/10 text-[#0071E3]">
              <FileDown size={18}/>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-gray-900">Нэгтгэсэн ERP Excel</h2>
              <p className="text-[11px] text-gray-500">#{session.id} · {session.date.replaceAll("-", "/")}</p>
            </div>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100" aria-label="Хаах">
            <X size={16}/>
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Company */}
          <div>
            <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-gray-500">Компани</label>
            <div className="grid grid-cols-2 gap-2">
              {(["buten_orgil", "orgil_khorum"] as const).map(c => {
                const active = cfg.company === c;
                return (
                  <button
                    key={c}
                    onClick={() => {
                      const d = COMPANY_DEFAULTS[c];
                      setCfg(prev => ({
                        ...prev,
                        company: c,
                        related_account: d.related_account,
                        account: d.account,
                        single_location: d.single_location,
                      }));
                    }}
                    className={`rounded-xl border-2 py-2.5 text-xs font-semibold transition ${
                      active
                        ? "border-[#0071E3] bg-[#0071E3] text-white shadow-sm"
                        : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                    }`}
                  >
                    {c === "buten_orgil" ? "Бүтэн-Оргил ХХК" : "Оргил-Хорум ХХК"}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-500">
              Гүйлгээний утга <span className="text-red-500">*</span>
            </label>
            <input
              value={cfg.document_note}
              onChange={e => setCfg({ ...cfg, document_note: e.target.value })}
              placeholder="Жишээ: 2026/04/24 тулгалт"
              className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
            />
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">Харьцсан данс</label>
              <input
                value={cfg.related_account}
                onChange={e => setCfg({ ...cfg, related_account: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
              />
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">Данс</label>
              <input
                value={cfg.account}
                onChange={e => setCfg({ ...cfg, account: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
              />
            </div>
          </div>

          {cfg.company === "orgil_khorum" ? (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">
                Байршил код <span className="text-red-500">*</span>
              </label>
              <input
                value={cfg.single_location}
                onChange={e => setCfg({ ...cfg, single_location: e.target.value })}
                className="w-full rounded-lg border border-gray-200 px-3 py-2.5 text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
              />
            </div>
          ) : (
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">
                Агуулах → Байршил код <span className="text-red-500">*</span>
              </label>
              <div className="space-y-1.5 rounded-lg bg-gray-50/70 p-2">
                {warehouses.map(wh => (
                  <div key={wh} className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-gray-700" title={wh}>
                      {wh} <span className="text-gray-400">· {warehouseCounts[wh]} бараа</span>
                    </span>
                    <input
                      value={cfg.warehouse_map[wh] ?? ""}
                      onChange={e => setCfg({ ...cfg, warehouse_map: { ...cfg.warehouse_map, [wh]: e.target.value } })}
                      placeholder="ERP код"
                      className="w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-right text-xs tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                    />
                  </div>
                ))}
                {/* Байршлын tag-гүй бараануудад зориулсан тусгай мөр */}
                {untaggedCount > 0 && (
                  <div className="flex items-center gap-2 rounded-md bg-amber-50 px-2 py-1 ring-1 ring-inset ring-amber-200/60">
                    <span className="flex-1 truncate text-xs font-medium text-amber-800">
                      ⚠ Таггүй <span className="font-normal text-amber-700/80">· {untaggedCount} бараа</span>
                    </span>
                    <input
                      value={cfg.warehouse_map[""] ?? ""}
                      onChange={e => setCfg({ ...cfg, warehouse_map: { ...cfg.warehouse_map, [""]: e.target.value } })}
                      placeholder="ERP код"
                      className="w-28 rounded-md border border-amber-300 bg-white px-2 py-1.5 text-right text-xs tabular-nums outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-300/40"
                    />
                  </div>
                )}
                {warehouses.length === 0 && untaggedCount === 0 && (
                  <span className="block py-2 text-center text-xs text-gray-400">
                    Бараа оруулсан үед л гарна
                  </span>
                )}
              </div>
            </div>
          )}

          {err && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 ring-1 ring-inset ring-red-200/60">
              {err}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-5 py-3">
          <button
            onClick={onClose}
            className="flex-1 rounded-apple border border-gray-200 bg-white py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:flex-none sm:px-4 sm:py-1.5"
          >
            Болих
          </button>
          <button
            onClick={submit}
            disabled={loading}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-apple bg-[#0071E3] py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#005BB5] disabled:opacity-50 sm:flex-none sm:px-4 sm:py-1.5"
          >
            {loading ? <RefreshCw size={13} className="animate-spin"/> : <FileDown size={13}/>}
            Excel татах
          </button>
        </div>
      </div>
    </div>
  );
}
