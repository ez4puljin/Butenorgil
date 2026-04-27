import { useEffect, useState, useRef } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ChevronLeft, Search, Plus, Trash2, Upload, Check, X, FileDown,
  RefreshCw, Image as ImageIcon, AlertCircle, Package, Camera,
  Calendar, User, Hash, CheckCircle2, Clock, Undo2, Eye, TrendingUp,
  ChevronRight, AlertTriangle,
} from "lucide-react";
import { api } from "../lib/api";
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
  note: string;
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

  const [confirmBrand, setConfirmBrand] = useState<BrandInfo | null>(null);
  const [supplierPcs, setSupplierPcs] = useState("");
  const [supplierAmount, setSupplierAmount] = useState("");
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [confirming, setConfirming] = useState(false);

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
      const res = await api.get(`/receivings/${session.id}/brands/${encodeURIComponent(brand)}/receipt`, {
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

  const updateLine = async (lineId: number, patch: { qty_pcs?: number; unit_price?: number }) => {
    if (!session) return;
    try {
      await api.patch(`/receivings/${session.id}/lines/${lineId}`, patch);
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
    const pcs = parseFloat(supplierPcs);
    const amount = parseFloat(supplierAmount);
    if (isNaN(pcs) || isNaN(amount)) { flash("Тоо/дүн оруулна уу", false); return; }
    if (!receiptFile) { flash("Баримтны зураг оруулна уу", false); return; }
    setConfirming(true);
    try {
      const fd = new FormData();
      fd.append("supplier_total_pcs", String(pcs));
      fd.append("supplier_total_amount", String(amount));
      fd.append("receipt", receiptFile);
      await api.post(`/receivings/${session.id}/brands/${encodeURIComponent(confirmBrand.brand)}/confirm`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      flash(`${confirmBrand.brand} — баримт тулгалаа`);
      setConfirmBrand(null);
      setSupplierPcs("");
      setSupplierAmount("");
      setReceiptFile(null);
      await load();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally { setConfirming(false); }
  };

  const unmatch = async (brand: string) => {
    if (!session) return;
    if (!confirm(`${brand} — тулгалтыг буцаах уу?`)) return;
    try {
      await api.post(`/receivings/${session.id}/brands/${encodeURIComponent(brand)}/unmatch`);
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

  if (!session) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-24 text-gray-400">
        {loading ? <RefreshCw size={24} className="animate-spin"/> : <Package size={28} className="text-gray-200"/>}
        <span className="text-sm">{loading ? "Ачаалж байна…" : "Мэдээлэл байхгүй"}</span>
      </div>
    );
  }

  const visibleLines = session.lines.filter(l => {
    if (filterBrand && l.brand !== filterBrand) return false;
    if (priceDiffOnly) {
      const diff = l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01;
      if (!diff) return false;
    }
    return true;
  });
  const visibleByBrand: Record<string, Line[]> = {};
  for (const l of visibleLines) {
    (visibleByBrand[l.brand || "—"] ??= []).push(l);
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

      {/* Header */}
      <div className="mb-4 rounded-apple bg-white p-3.5 shadow-sm ring-1 ring-gray-100 sm:p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <button
              onClick={() => navigate("/receivings")}
              className="shrink-0 rounded-lg p-1.5 text-gray-500 hover:bg-gray-100"
              aria-label="Буцах"
            >
              <ChevronLeft size={18}/>
            </button>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-base font-semibold tracking-tight text-gray-900 sm:text-lg">
                  <span className="tabular-nums">{session.date.replaceAll("-", "/")}</span>
                  <span className="ml-2 text-xs font-normal text-gray-400">#{session.id}</span>
                </h1>
                <StatusChip status={session.status} label={session.status_label}/>
              </div>
              {/* Stats — compact on mobile, expanded on desktop */}
              <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500 sm:text-xs">
                <span className="inline-flex items-center gap-1"><User size={11}/>{session.created_by_username}</span>
                <span className="inline-flex items-center gap-1 tabular-nums"><Hash size={11}/>{session.line_count} мөр</span>
                <span className="tabular-nums">{session.total_pcs.toFixed(0)} ш</span>
                <span className="font-semibold tabular-nums text-gray-800">
                  {session.total_amount.toLocaleString("mn-MN")}₮
                </span>
                {session.brands.length > 0 && (
                  <span className="tabular-nums">
                    {matchedBrandCount}/{session.brands.length} бренд тулгагдсан
                  </span>
                )}
              </div>
              {session.notes && (
                <p className="mt-1.5 text-[11px] italic text-gray-400 sm:text-xs">“{session.notes}”</p>
              )}
            </div>
          </div>
        </div>

        {/* Status actions */}
        {(session.status === "matching" || session.status === "price_review") && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
            {session.status === "matching" && (
              <button
                onClick={() => advanceTo("price_review")}
                disabled={!session.all_brands_matched}
                className={`inline-flex items-center gap-1.5 rounded-apple px-3.5 py-2 text-xs font-semibold transition-colors sm:text-sm ${
                  session.all_brands_matched
                    ? "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm"
                    : "bg-gray-100 text-gray-400 cursor-not-allowed"
                }`}
                title={session.all_brands_matched ? "" : "Эхлээд бүх брэндийн баримт тулгана уу"}
              >
                <TrendingUp size={14}/>
                Үнэ хянах руу
                <ChevronRight size={14}/>
              </button>
            )}
            {session.status === "price_review" && (
              <>
                <button
                  onClick={() => setShowERPModal(true)}
                  className="inline-flex items-center gap-1.5 rounded-apple bg-blue-50 px-3.5 py-2 text-xs font-semibold text-blue-700 ring-1 ring-inset ring-blue-200/60 hover:bg-blue-100 sm:text-sm"
                >
                  <FileDown size={14}/>
                  Нэгтгэсэн ERP Excel
                </button>
                <button
                  onClick={() => advanceTo("received")}
                  className="inline-flex items-center gap-1.5 rounded-apple bg-emerald-600 px-3.5 py-2 text-xs font-semibold text-white shadow-sm hover:bg-emerald-700 sm:text-sm"
                >
                  <CheckCircle2 size={14}/>
                  Орлого авсан
                  <ChevronRight size={14}/>
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Two-column on desktop: left = add-product, right = brand summary; stacks on mobile */}
      <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-5">
        {/* Add-product (matching only) */}
        {canEdit && (
          <div className="rounded-apple bg-white p-4 shadow-sm ring-1 ring-gray-100 lg:col-span-3">
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">Бараа нэмэх</h3>
              <span className="text-[11px] text-gray-400">Баркод / нэр / кодоор</span>
            </div>

            {/* Search + scan */}
            <div className="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 transition focus-within:border-[#0071E3] focus-within:ring-2 focus-within:ring-[#0071E3]/15">
              <Search size={16} className="shrink-0 text-gray-400"/>
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Бараа хайх…"
                className="flex-1 bg-transparent text-[16px] outline-none placeholder:text-gray-400 sm:text-sm"
                inputMode="search"
              />
              {searching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
              {search && !searching && (
                <button
                  onClick={() => { setSearch(""); setSearchResults([]); }}
                  className="rounded p-1 text-gray-400 hover:bg-gray-100"
                  aria-label="Цэвэрлэх"
                >
                  <X size={14}/>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowScanner(true)}
                title="Камераар баркод скан хийх"
                className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[#0071E3] px-2.5 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#005BB5]"
              >
                <Camera size={14}/>
                <span className="hidden sm:inline">Скан</span>
              </button>
            </div>
            {scanFlash && (
              <div className="mt-1.5 text-[11px] text-gray-500">{scanFlash}</div>
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

                {/* Brand override dropdown */}
                <div className="mt-3">
                  <label className="mb-1 block text-[11px] font-medium text-gray-500">
                    Бренд (тулгах)
                  </label>
                  <select
                    value={addBrand}
                    onChange={e => setAddBrand(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
                  >
                    <option value="">
                      {selected.brand || "(брэнд байхгүй)"} — анхдагч
                    </option>
                    {/* Уг session дотор аль хэдий нь байгаа brand-уудыг эхэнд харуулах */}
                    {(session?.brands ?? [])
                      .map(b => b.brand)
                      .filter(b => b && b !== selected.brand && b !== "Брэнд байхгүй")
                      .map(b => (
                        <option key={`s-${b}`} value={b}>
                          {b} — энэ session дээр
                        </option>
                      ))}
                    {/* Системийн бусад brand-ууд */}
                    {allBrands
                      .filter(b =>
                        b &&
                        b !== selected.brand &&
                        !(session?.brands ?? []).some(sb => sb.brand === b)
                      )
                      .map(b => (
                        <option key={`a-${b}`} value={b}>
                          {b}
                        </option>
                      ))}
                  </select>
                  {addBrand && addBrand !== (selected.brand || "") && (
                    <p className="mt-1 text-[11px] text-amber-600">
                      ⚠ <span className="font-medium">{selected.brand || "брэндгүй"}</span> бараа{" "}
                      <span className="font-medium">{addBrand}</span> дор тулгагдана
                    </p>
                  )}
                </div>

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

                <button
                  onClick={addLine}
                  className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-1.5 rounded-xl bg-[#0071E3] py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[#005BB5] active:scale-[0.99]"
                >
                  <Plus size={16}/> Нэмэх
                </button>
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

        {/* Brand summary — stretches to fill on desktop when canEdit=true, full width otherwise */}
        {session.brands.length > 0 && (
          <div className={`rounded-apple bg-white p-4 shadow-sm ring-1 ring-gray-100 ${canEdit ? "lg:col-span-2" : "lg:col-span-5"}`}>
            <div className="mb-2.5 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">Брэнд бүрийн тулгалт</h3>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">
                {matchedBrandCount}/{session.brands.length}
              </span>
            </div>

            <div className={`grid grid-cols-1 gap-2 ${canEdit ? "" : "sm:grid-cols-2 lg:grid-cols-3"}`}>
              {session.brands.map(b => (
                <div
                  key={b.brand}
                  className={`relative rounded-xl border p-3 transition ${
                    b.is_matched
                      ? "border-emerald-200 bg-emerald-50/40"
                      : "border-gray-200 bg-gray-50/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {b.is_matched ? (
                          <CheckCircle2 size={14} className="shrink-0 text-emerald-600"/>
                        ) : (
                          <Clock size={14} className="shrink-0 text-amber-500"/>
                        )}
                        <span className="truncate text-sm font-semibold text-gray-900">{b.brand}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500">
                        <span className="tabular-nums">{b.line_count} мөр</span>
                        <span className="tabular-nums">{b.total_pcs.toFixed(0)} ш</span>
                        <span className="font-medium tabular-nums text-gray-700">
                          {b.total_amount.toLocaleString("mn-MN")}₮
                        </span>
                      </div>
                    </div>
                    {b.has_price_diff && (
                      <span
                        title="Үнэ зөрүүтэй мөртэй"
                        className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-600 ring-1 ring-inset ring-red-200/60"
                      >
                        <AlertTriangle size={10}/> зөрүү
                      </span>
                    )}
                  </div>

                  {/* Matched meta */}
                  {b.is_matched && (
                    <div className="mt-2 rounded-lg bg-white/70 px-2 py-1 text-[10px] text-gray-500">
                      <div className="flex items-center justify-between gap-1">
                        <span>Нийлүүлэгч:</span>
                        <span className="tabular-nums text-gray-700">
                          {b.supplier_total_pcs.toFixed(0)}ш · {b.supplier_total_amount.toLocaleString("mn-MN")}₮
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Actions */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() => { setFilterBrand(b.brand); setPriceDiffOnly(false); }}
                      className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-700 shadow-sm ring-1 ring-inset ring-gray-200/70 hover:bg-gray-50"
                    >
                      <Eye size={11}/> Шүүж харах
                    </button>
                    {!b.is_matched && canEdit && (
                      <button
                        onClick={() => {
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
                        onClick={() => viewReceipt(b.brand)}
                        disabled={receiptLoading}
                        className="inline-flex items-center gap-1 rounded-lg bg-white px-2.5 py-1.5 text-[11px] font-medium text-blue-600 shadow-sm ring-1 ring-inset ring-blue-200/60 hover:bg-blue-50 disabled:opacity-50"
                      >
                        <ImageIcon size={11}/> Баримт
                      </button>
                    )}
                    {b.is_matched && canEdit && (role === "admin" || role === "manager" || role === "supervisor") && (
                      <button
                        onClick={() => unmatch(b.brand)}
                        className="inline-flex items-center gap-1 rounded-lg bg-white px-2 py-1.5 text-[11px] font-medium text-red-500 ring-1 ring-inset ring-red-200/50 hover:bg-red-50"
                        title="Тулгалтыг буцаах"
                      >
                        <Undo2 size={11}/>
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="mb-2 flex flex-wrap items-center gap-1.5 rounded-apple bg-white px-3 py-2 shadow-sm ring-1 ring-gray-100">
        <span className="mr-1 text-xs font-medium text-gray-500 tabular-nums">
          {visibleLines.length} мөр
        </span>
        <div className="relative">
          <select
            value={filterBrand}
            onChange={e => setFilterBrand(e.target.value)}
            className="appearance-none rounded-full border border-gray-200 bg-white py-1 pl-3 pr-7 text-xs outline-none transition hover:bg-gray-50 focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
          >
            <option value="">Бренд: бүгд</option>
            {session.brands.map(b => <option key={b.brand} value={b.brand}>{b.brand}</option>)}
          </select>
          <ChevronRight size={11} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rotate-90 text-gray-400"/>
        </div>
        {session.status === "price_review" && (
          <button
            onClick={() => setPriceDiffOnly(v => !v)}
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
              priceDiffOnly
                ? "bg-red-600 text-white shadow-sm"
                : "bg-red-50 text-red-600 ring-1 ring-inset ring-red-200/60 hover:bg-red-100"
            }`}
          >
            <AlertTriangle size={11}/> Үнэ зөрүүтэй
          </button>
        )}
        {(filterBrand || priceDiffOnly) && (
          <button
            onClick={() => { setFilterBrand(""); setPriceDiffOnly(false); }}
            className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-[11px] text-gray-600 hover:bg-gray-50"
          >
            <X size={11}/> Цэвэрлэх
          </button>
        )}
      </div>

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
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {lns.map(l => {
                          const priceDiff = l.last_purchase_price > 0 && Math.abs(l.unit_price - l.last_purchase_price) > 0.01;
                          return (
                            <tr key={l.id} className={priceDiff ? "bg-red-50/30" : "hover:bg-gray-50/40"}>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex items-center gap-1.5">
                                  <div className="text-sm font-medium text-gray-800 leading-snug">{l.name}</div>
                                  {l.override_brand && l.original_brand && l.override_brand !== l.original_brand && (
                                    <span
                                      title={`Анхдагч брэнд: ${l.original_brand}`}
                                      className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-50 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 ring-1 ring-inset ring-amber-200/60"
                                    >
                                      ↺ {l.original_brand}
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
                      return (
                        <div key={l.id} className={`px-3 py-3 ${priceDiff ? "bg-red-50/30" : ""}`}>
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
                              </div>
                              <div className="mt-0.5 text-[10px] text-gray-400">
                                <span className="font-mono">{l.item_code}</span>
                                <span className="ml-1.5 text-gray-300">· {l.pack_ratio}ш/хайрцаг</span>
                              </div>
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

  const ourPcs = p.brand.total_pcs;
  const ourAmt = p.brand.total_amount;
  const supplierPcsNum = parseFloat(p.supplierPcs);
  const supplierAmtNum = parseFloat(p.supplierAmount);
  const pcsDiff = !isNaN(supplierPcsNum) ? supplierPcsNum - ourPcs : null;
  const amtDiff = !isNaN(supplierAmtNum) ? supplierAmtNum - ourAmt : null;

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
          {/* Our totals summary */}
          <div className="rounded-xl bg-gradient-to-br from-blue-50/50 to-gray-50 p-3 ring-1 ring-inset ring-blue-100/60">
            <div className="text-[10px] font-medium uppercase tracking-wide text-gray-500">Та оруулсан</div>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="text-lg font-bold tabular-nums text-gray-900">{ourPcs.toFixed(0)} ш</span>
              <span className="text-sm font-semibold tabular-nums text-gray-700">
                {ourAmt.toLocaleString("mn-MN")}₮
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">Баримтны нийт ш</label>
              <input
                type="number"
                value={p.supplierPcs}
                onChange={e => p.setSupplierPcs(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-right text-[16px] font-semibold tabular-nums outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
              />
              {pcsDiff !== null && pcsDiff !== 0 && (
                <div className={`mt-1 text-right text-[10px] font-medium tabular-nums ${pcsDiff > 0 ? "text-amber-600" : "text-red-600"}`}>
                  зөрүү {pcsDiff > 0 ? "+" : ""}{pcsDiff.toFixed(0)} ш
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-gray-500">Баримтны нийт дүн (₮)</label>
              <input
                type="number"
                value={p.supplierAmount}
                onChange={e => p.setSupplierAmount(e.target.value)}
                inputMode="numeric"
                className="w-full rounded-xl border border-gray-200 px-3 py-2.5 text-right text-[16px] font-semibold tabular-nums outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
              />
              {amtDiff !== null && Math.abs(amtDiff) > 0.01 && (
                <div className={`mt-1 text-right text-[10px] font-medium tabular-nums ${amtDiff > 0 ? "text-amber-600" : "text-red-600"}`}>
                  зөрүү {amtDiff > 0 ? "+" : ""}{Math.round(amtDiff).toLocaleString("mn-MN")}₮
                </div>
              )}
            </div>
          </div>

          {/* Receipt upload / preview */}
          <div>
            <label className="mb-1 block text-[11px] font-medium text-gray-500">
              Баримт зураг <span className="text-red-500">*</span>
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
            disabled={p.submitting || !p.receiptFile}
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
  const warehouses = [...new Set(session.lines.filter(l => l.qty_pcs > 0).map(l => l.warehouse_name).filter(Boolean))].sort();
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
                    <span className="flex-1 truncate text-xs text-gray-700" title={wh}>{wh}</span>
                    <input
                      value={cfg.warehouse_map[wh] ?? ""}
                      onChange={e => setCfg({ ...cfg, warehouse_map: { ...cfg.warehouse_map, [wh]: e.target.value } })}
                      placeholder="ERP код"
                      className="w-28 rounded-md border border-gray-200 bg-white px-2 py-1.5 text-right text-xs tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/15"
                    />
                  </div>
                ))}
                {warehouses.length === 0 && (
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
