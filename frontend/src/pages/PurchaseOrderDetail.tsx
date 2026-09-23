import { useCallback, useEffect, useMemo, useRef, useState, Fragment, memo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronLeft, RefreshCw, CheckCircle2, Save, FileDown,
  Trash2, Plus, Search, X, Package, AlertCircle, CheckCheck,
  Truck, RotateCcw, ChevronDown, ChevronUp, Columns3, Lock, History,
} from "lucide-react";
import { api } from "../lib/api";
import { useLiveRefresh } from "../lib/liveEvents";
import { useAuthStore } from "../store/authStore";
import {
  usePurchaseOrderStore,
  STATUS_SEQUENCE,
  STATUS_LABEL,
  STATUS_COLOR,
} from "../store/purchaseOrderStore";
import PDFExportModal from "../components/PDFExportModal";
import ERPExcelModal from "../components/ERPExcelModal";
import OrderHistoryModal from "../components/OrderHistoryModal";

/* ── Багануудын харагдац ──────────────────────────────────────────────────
   Өмнө нь багана бүр захиалгын СТАТУСААР нуугддаг байсан: жишээ нь үнийн
   багана зөвхөн "Нягтлан шалгаж байна" үед л гарч ирдэг. Ингэснээр нэг
   мэдээллийг харахын тулд статус солигдохыг хүлээх шаардлагатай болдог байв.

   Одоо статус нь ЗӨВХӨН МЭДЭЭЛЛИЙН шинжтэй — бүх багана өгөгдмөлөөр
   харагдана, хэрэглэгч хүсвэл өөрөө нуухаар сонгоно.

   Анхаар: харагдац ≠ засварлах эрх. Аль баганыг өөрчилж болохыг ХЭВЭЭР
   статус + role хоёр шийднэ (canEdit, canEditLoaded, canEditReceived,
   canEditPrice) — багана харагдаж байгаа нь түүнийг өөрчилж болно гэсэн
   үг биш, зөвхөн харах боломжтой гэсэн үг. */
const COLUMN_GROUPS = [
  { key: "stock",      label: "Нөөц · Хайрцагны тоо",     span: 2 },
  { key: "unitWeight", label: "Нэгж жин · Хайрцаг/ш",     span: 2 },
  { key: "order",      label: "Захиалах",                 span: 1 },
  { key: "sales",      label: "Борлуулалтын дундаж",      span: 4 },
  { key: "estCost",    label: "Тооцоолсон өртөг",         span: 2 },
  { key: "loaded",     label: "Ачигдсан",                 span: 1 },
  { key: "received",   label: "Ирсэн · Зөрүү · Тайлбар",  span: 3 },
  { key: "price",      label: "Үнэ · Нийт дүн",           span: 3 },
  { key: "priceDiff",  label: "Үнэ зөрүү",                span: 1 },
  { key: "vehicle",    label: "Машин",                    span: 1 },
] as const;

// ColKey-г гараар бичихгүй — COLUMN_GROUPS-ээс гаргана. Ингэснээр шинэ
// багана нэмэхэд түлхүүрээ бүртгэхээ мартах боломжгүй.
type ColKey = (typeof COLUMN_GROUPS)[number]["key"];

const COLS_KEY = "po_detail_columns";

/* Захиалгад ОРООГҮЙ бараа — тусдаа, залхуу татдаг эх сурвалж.
   Үндсэн хариунд нэмэхгүй байх шалтгаан: (1) preparing-ээс бусад статуст
   backend тоо=0 мөрийг хаядаг; (2) saveLines нь order.lines-ыг бүхэлд нь
   буцааж илгээдэг тул үндсэн жагсаалтад нэмбэл хадгалалт бүр мянган тэг
   мөр бичих болно. */
type UnorderedItem = {
  product_id: number; line_id: number; item_code: string; name: string;
  /** override_brand-ыг харгалзсан ҮР ДҮНГИЙН бренд — UI бүлэглэлт үүгээр. */
  brand: string;
  /** Product.brand — `set_lines`-ийн статусын маск ҮҮГЭЭР сонгогддог.
      Зөвхөн нэгийг нь шалгавал override_brand-тай мөрд UI зөвшөөрч,
      backend чимээгүй хаяад {"ok": true} буцаана. */
  raw_brand: string;
  warehouse_name: string; price_tag: string; pack_ratio: number;
  unit_weight: number;
  stock_qty: number; stock_box: number; last_purchase_price: number;
};

function loadColPrefs(): Record<ColKey, boolean> {
  // Өгөгдмөл: БҮГД асаалттай. Хадгалсан сонголтоос зөвхөн мэдэгдэж буй
  // түлхүүрийг авна — ингэснээр дараа шинэ багана нэмэгдвэл хуучин
  // хадгалалт түүнийг нуухгүй.
  const all = Object.fromEntries(COLUMN_GROUPS.map((g) => [g.key, true])) as Record<ColKey, boolean>;
  try {
    const raw = localStorage.getItem(COLS_KEY);
    if (!raw) return all;
    const saved = JSON.parse(raw);
    for (const g of COLUMN_GROUPS) {
      if (typeof saved?.[g.key] === "boolean") all[g.key] = saved[g.key];
    }
  } catch { /* хадгалалт уншигдахгүй бол бүгдийг харуулна */ }
  return all;
}

/* ═══ Ороогүй бараа захиалах консол ═════════════════════════════════ */
const UNORD_PAGE     = 200;    // нэг хуудсанд татах мөр
const UNORD_MAX_ROWS = 2000;   // DOM-ын хатуу тааз — виртуалчлал байхгүй
const UNORD_CART_MAX = 500;    // нэг хадгалалтад илгээх дээд хэмжээ

/** Ороогүй барааны нэг мөр.
 *  `memo` — 2 000 мөр ачаалагдсан үед товчлуур бүрд бүх мөр дахин зурагдвал
 *  бичихэд мэдэгдэхүйц саатна. Эцэг дэх бүх боловсруулагч `useCallback([])`
 *  тул зөвхөн өөрийн `qty` өөрчлөгдсөн мөр дахин зурагдана. */
const UnordRow = memo(function UnordRow(props: {
  it: UnorderedItem; qty: number; editable: boolean; done: boolean; showBrand: boolean;
  onQty: (it: UnorderedItem, v: number) => void;
  onKey: (e: any, lineId: number) => void;
  setRef: (lineId: number, el: HTMLInputElement | null) => void;
  onBrand: (b: string) => void;
}) {
  const { it, qty, editable, done, showBrand, onQty, onKey, setRef, onBrand } = props;
  const amount = qty > 0 ? Math.round(qty * it.pack_ratio * it.last_purchase_price) : 0;
  const kg     = qty > 0 ? qty * it.pack_ratio * it.unit_weight : 0;
  return (
    <tr className={`h-9 border-b border-gray-100 ${qty > 0 ? "bg-amber-50/60" : "hover:bg-gray-50"}`}>
      <td className="whitespace-nowrap px-2 font-mono text-[11.5px] text-gray-500">{it.item_code}</td>
      <td className="max-w-0 px-2">
        <div className="truncate text-[13px] font-medium text-gray-900" title={it.name}>{it.name}</div>
      </td>
      {showBrand && (
        <td className="max-w-0 px-2">
          <button onClick={() => onBrand(it.brand)} title={`${it.brand} — зөвхөн энэ брендээр шүүх`}
            className="block max-w-full truncate text-[11.5px] text-gray-500 hover:text-amber-700 hover:underline">
            {it.brand}
          </button>
        </td>
      )}
      <td className="max-w-0 truncate px-2 text-[11.5px] text-gray-500">{it.warehouse_name || "—"}</td>
      <td className="max-w-0 truncate px-2 text-[11.5px] text-gray-400">{it.price_tag || "—"}</td>
      <td className="whitespace-nowrap px-2 text-right">
        <span className={`text-[12.5px] font-semibold tabular-nums ${it.stock_box === 0 ? "text-red-600" : "text-gray-700"}`}>{it.stock_box}х</span>
        <span className="ml-1 text-[10px] tabular-nums text-gray-400">{Math.round(it.stock_qty)}ш</span>
      </td>
      <td className="whitespace-nowrap px-2 text-right text-[11.5px] tabular-nums text-gray-400">{it.pack_ratio}</td>
      <td className="whitespace-nowrap px-2 text-right text-[12.5px] tabular-nums text-gray-600">
        {it.last_purchase_price > 0 ? Math.round(it.last_purchase_price).toLocaleString("mn-MN") : "—"}
      </td>
      <td className={`whitespace-nowrap px-2 text-right text-[12.5px] tabular-nums ${qty > 0 ? "font-semibold text-indigo-600" : "text-gray-300"}`}>
        {qty > 0 ? amount.toLocaleString("mn-MN") : "—"}
      </td>
      <td className={`whitespace-nowrap px-2 text-right text-[12px] tabular-nums ${qty > 0 ? "text-gray-600" : "text-gray-300"}`}>
        {qty > 0 ? kg.toFixed(1) : "—"}
      </td>
      <td className="whitespace-nowrap px-2 text-right">
        {done ? (
          <span className="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2 py-1 text-[11px] font-semibold text-emerald-700">
            <CheckCircle2 size={11}/> Нэмэгдсэн
          </span>
        ) : editable ? (
          <input
            ref={(el) => setRef(it.line_id, el)}
            type="number" min={0} step={1} inputMode="numeric" placeholder="0"
            value={qty === 0 ? "" : qty}
            onWheel={(e) => e.currentTarget.blur()}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => onKey(e, it.line_id)}
            onChange={(e) => { const v = parseFloat(e.target.value); onQty(it, isNaN(v) ? 0 : v); }}
            className="w-[92px] rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-right text-[13px] font-medium tabular-nums shadow-sm outline-none transition focus:border-amber-500 focus:ring-2 focus:ring-amber-300"
          />
        ) : (
          <span title="Энэ брендийн статуст захиалга нэмэх боломжгүй"
            className="inline-flex items-center gap-1 text-[11px] text-gray-400"><Lock size={10}/> боломжгүй</span>
        )}
      </td>
    </tr>
  );
});

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const brandFilter = searchParams.get("brand");
  const brandMode = !!brandFilter;
  // role = захиалгат нэр (жишээ 'hudaldagch'), baseRole = системийн эрхийн
  // түвшин ('manager'). Backend-ийн require_role нь baseRole-оор шийддэг.
  const { role, baseRole } = useAuthStore();
  // Эрхийн шалгалт бүр ҮР НӨЛӨӨТЭЙ түвшнээр — backend-ийн require_role нь
  // base_role-оор шийддэг. Түүхий `role` нь захиалгат нэр байж болно
  // (driver→warehouse_clerk, cashier→manager, hudaldagch→manager г.м.).
  const eff = baseRole || role || "";
  const store = usePurchaseOrderStore();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  // Real-time: өөр хэрэглэгч энэ захиалгыг шинэчлэхэд banner харуулна (auto-reload
  // хийхгүй — бичиж байгаа тоо алдагдахаас сэргийлж). Өөрийн өөрчлөлтийг үл тоомсорлоход
  // localActionAt-ийг ашиглана (loadOrder бүрт шинэчлэгдэнэ).
  const [liveUpdatePending, setLiveUpdatePending] = useState(false);
  const localActionAt = useRef<number>(0);
  const [showPDFModal, setShowPDFModal] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showERPModal, setShowERPModal] = useState(false);

  // Багануудын харагдац (өгөгдмөл нь бүгд асаалттай) — [[COLUMN_GROUPS]]
  // Захиалаагүй бараа: бренд→тоо (нэгтгэл) ба нээсэн брендийн жагсаалт
  const [unordCounts, setUnordCounts] = useState<Record<string, number>>({});
  const [unordTotal, setUnordTotal] = useState(0);
  // Ороогүй барааг ЭНД захиална: product_id → хайрцгийн тоо.
  // store.quantities руу ХЭЗЭЭ Ч бичихгүй — тэр нь үндсэн торын эзэмшил.
  const [unordQtys, setUnordQtys] = useState<Record<number, number>>({});
  const [unordSaving, setUnordSaving] = useState(false);

  // ── Ороогүй бараа захиалах консол (Ctrl+K) ──────────────────────────
  const [unordPanel,    setUnordPanel]    = useState(false);
  const [unordQ,        setUnordQ]        = useState("");                  // бичиж буй хайлт
  const [unordQDeb,     setUnordQDeb]     = useState("");                  // 350мс-ийн дараах утга
  const [unordBrand,    setUnordBrand]    = useState<string | null>(null); // null = БҮХ брендээс
  const [unordRailQ,    setUnordRailQ]    = useState("");                  // зүүн жагсаалтын шүүлт
  /* Зүүн жагсаалт (240px) ба сагс (340px) хоёулаа нээлттэй үед хүснэгтэд
     min-w-[1000px] багтахын тулд 1580px+ өргөн хэрэгтэй. 1366px зөөврийн
     дэлгэцэнд «Захиалах» багана дэлгэцээс гарч, хэрэглэгч тоо оруулахын
     тулд баруун тийш гүйлгэх шаардлагатай болно — тиймээс нарийн дэлгэцэнд
     анхдагчаар хумина (толгойн товчоор дурын үед нээж болно). */
  const [unordRailOpen, setUnordRailOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1280);
  const [unordCartOpen, setUnordCartOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 1600);
  const [unordZeroOnly, setUnordZeroOnly] = useState(false);
  const [unordRows,     setUnordRows]     = useState<UnorderedItem[]>([]);
  const [unordFound,    setUnordFound]    = useState(0);
  const [unordOffset,   setUnordOffset]   = useState(0);
  const [unordEnd,      setUnordEnd]      = useState(false);               // сүүлийн хуудас ирсэн
  const [unordFetching, setUnordFetching] = useState(false);
  const [unordDone,     setUnordDone]     = useState<Record<number, true>>({});
  const [unordCart,     setUnordCart]     = useState<Record<number, UnorderedItem>>({});
  const [unordCartOrder, setUnordCartOrder] = useState<number[]>([]);      // нэмсэн дараалал
  const [unordFillVal,  setUnordFillVal]  = useState(1);
  const [unordFillSnap, setUnordFillSnap] = useState<Record<number, number> | null>(null);
  const [unordMobilePane, setUnordMobilePane] = useState<"list" | "cart">("list");
  const [unordPendingFocus, setUnordPendingFocus] = useState<number | null>(null);

  /** line_id → нүд. Индексээр биш line_id-гаар түлхүүрлэнэ: жагсаалт эрэмбэлэгдэх
   *  үед React-ийн detach→attach нь өөр мөрийн сая бөглөсөн нүдийг null болгодог. */
  const unordInputs    = useRef<Record<number, HTMLInputElement | null>>({});
  const unordSearchRef = useRef<HTMLInputElement | null>(null);
  const unordBodyRef   = useRef<HTMLDivElement | null>(null);
  const unordReqId     = useRef(0);                                         // уралдааны хамгаалалт
  // "Бүгдийг захиалсан тоогоор" тэмдэглэгээний төлөв
  const [loadedAll, setLoadedAll] = useState(false);
  const [receivedAll, setReceivedAll] = useState(false);

  const [cols, setCols] = useState<Record<ColKey, boolean>>(loadColPrefs);
  const [showColMenu, setShowColMenu] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(COLS_KEY, JSON.stringify(cols)); } catch { /* алгасна */ }
  }, [cols]);
  // Escape-ээр хаана — хулганагүй хэрэглэгч гацахгүй.
  useEffect(() => {
    if (!showColMenu) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setShowColMenu(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showColMenu]);

  // Vehicle assignment
  const [vehicles, setVehicles] = useState<{ id: number; name: string; plate: string; is_active: boolean }[]>([]);
  const [brandVehicles, setBrandVehicles] = useState<Record<string, number | null>>({});
  const [vehicleSaving, setVehicleSaving] = useState(false);

  // Shipments (машинаар ачилт)
  type ShipmentSummary = { id: number; vehicle_id: number | null; vehicle_name: string | null; status: string; status_label: string; line_count: number; total_loaded_box: number; total_weight: number; brand_count: number; brands: string[] };
  type UnassignedLine = { po_line_id: number; product_id: number; item_code: string; name: string; brand: string; order_qty_box: number; assigned_qty_box: number; remaining_qty_box: number };
  const [shipments, setShipments] = useState<ShipmentSummary[]>([]);
  // Brand mode-д ч гэсэн бүх shipment-уудыг хадгална (dropdown-д хэрэглэхэд)
  const [allShipments, setAllShipments] = useState<ShipmentSummary[]>([]);
  // product_id → [{ shipment_id, shipment_line_id, vehicle_name, loaded_qty_box }]
  const [productShipmentMap, setProductShipmentMap] = useState<Record<number, { shipment_id: number; shipment_line_id: number; vehicle_name: string | null; loaded_qty_box: number }[]>>({});
  const [unassignedLines, setUnassignedLines] = useState<UnassignedLine[]>([]);
  const [shipmentsLoading, setShipmentsLoading] = useState(false);
  const [expandedShipment, setExpandedShipment] = useState<number | null>(null);
  type ShipmentDetail = { id: number; lines: { id: number; po_line_id: number; product_id: number; item_code: string; name: string; brand: string; loaded_qty_box: number; received_qty_box: number; computed_weight: number }[] };
  const [shipmentDetail, setShipmentDetail] = useState<ShipmentDetail | null>(null);

  const loadShipments = async () => {
    if (!id) return;
    setShipmentsLoading(true);
    try {
      const res = await api.get(`/purchase-orders/${id}/shipments`);
      const allShips = res.data.shipments as ShipmentSummary[];
      let shipments = allShips;
      let unassigned = res.data.unassigned_lines as UnassignedLine[];

      // Brand mode: зөвхөн тухайн брендтэй холбоотой shipment + unassigned lines
      // Гэхдээ allShipments-д бүх loading shipment-уудыг хадгална (dropdown-д хэрэглэнэ)
      if (brandMode && brandFilter) {
        shipments = allShips.filter((sh: any) =>
          Array.isArray(sh.brands) && sh.brands.includes(brandFilter)
        );
        unassigned = unassigned.filter((u: any) => u.brand === brandFilter);
      }

      setAllShipments(allShips);
      setShipments(shipments);
      setUnassignedLines(unassigned);

      // Build product_id → shipment[] map (parallel fetch all shipment details)
      const shipmentDetails = await Promise.all(
        shipments.map((sh) =>
          api.get(`/purchase-orders/${id}/shipments/${sh.id}`)
            .then((r) => ({ sh, lines: r.data.lines ?? [] }))
            .catch(() => ({ sh, lines: [] as any[] }))
        )
      );
      const map: Record<number, { shipment_id: number; shipment_line_id: number; vehicle_name: string | null; loaded_qty_box: number }[]> = {};
      for (const { sh, lines } of shipmentDetails) {
        for (const ln of lines) {
          if (!map[ln.product_id]) map[ln.product_id] = [];
          map[ln.product_id].push({
            shipment_id: sh.id,
            shipment_line_id: ln.id,
            vehicle_name: sh.vehicle_name,
            loaded_qty_box: ln.loaded_qty_box,
          });
        }
      }
      setProductShipmentMap(map);
    } catch { /* ignore */ }
    finally { setShipmentsLoading(false); }
  };

  const toggleShipmentDetail = async (shId: number) => {
    if (expandedShipment === shId) { setExpandedShipment(null); setShipmentDetail(null); return; }
    setExpandedShipment(shId);
    try {
      const res = await api.get(`/purchase-orders/${id}/shipments/${shId}`);
      const data = res.data;
      // Brand mode: тухайн брендийн lines-г л харуулна
      if (brandMode && brandFilter && Array.isArray(data.lines)) {
        data.lines = data.lines.filter((l: any) => l.brand === brandFilter);
      }
      setShipmentDetail(data);
    } catch { setExpandedShipment(null); }
  };

  const moveLineToUnassigned = async (shipmentLineId: number) => {
    if (!order) return;
    try {
      await api.post(`/purchase-orders/${order.id}/shipments/move-line`, { shipment_line_id: shipmentLineId, target_shipment_id: null });
      await loadShipments();
      if (expandedShipment) await toggleShipmentDetail(expandedShipment);
      flash("Хуваарилагдаагүй болсон");
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  const moveLineToShipment = async (shipmentLineId: number, targetShipmentId: number) => {
    if (!order) return;
    try {
      await api.post(`/purchase-orders/${order.id}/shipments/move-line`, { shipment_line_id: shipmentLineId, target_shipment_id: targetShipmentId });
      await loadShipments();
      if (expandedShipment) await toggleShipmentDetail(expandedShipment);
      flash("Шилжүүллээ");
    } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); }
  };

  // Qty buffers for new qty fields
  const [suppQtys, setSuppQtys] = useState<Record<number, number>>({});
  const [loadedQtys, setLoadedQtys] = useState<Record<number, number>>({});
  const [receivedQtys, setReceivedQtys] = useState<Record<number, number>>({});
  // Ачаа ирсэн үед задгай ширхэгийн тоо (жишээ: 4 хайрцаг + 2 ширхэг)
  const [receivedExtraPcs, setReceivedExtraPcs] = useState<Record<number, number>>({});
  const [priceInputs, setPriceInputs] = useState<Record<number, number>>({});
  const [remarkInputs, setRemarkInputs] = useState<Record<number, string>>({});

  const [showStatusDropdown, setShowStatusDropdown] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!showStatusDropdown) return;
    const close = (e: MouseEvent) => {
      // Dropdown дотор дарсан бол хаахгүй (forceStatus ажиллах боломж)
      if (statusDropdownRef.current?.contains(e.target as Node)) return;
      setShowStatusDropdown(false);
    };
    // setTimeout → event bubble дуусмагц listener нэмнэ
    const t = setTimeout(() => document.addEventListener("click", close), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", close); };
  }, [showStatusDropdown]);

  // Extra-line modal
  const [showExtraModal, setShowExtraModal] = useState(false);
  const [editingExtra, setEditingExtra] = useState<{ id: number; name: string; item_code: string; warehouse_name: string; unit_weight: number; pack_ratio: number; qty_box: number } | null>(null);
  const [extraForm, setExtraForm] = useState({ brand: "", name: "", item_code: "", warehouse_name: "", unit_weight: "", pack_ratio: "", qty_box: "" });
  const [extraSaving, setExtraSaving] = useState(false);

  const openAddExtra = (brand = "") => {
    setEditingExtra(null);
    setExtraForm({ name: "", item_code: "", warehouse_name: "", unit_weight: "", pack_ratio: "", qty_box: "", brand });
    setShowExtraModal(true);
  };

  const openEditExtra = (el: { id: number; brand: string; name: string; item_code: string; warehouse_name: string; unit_weight: number; pack_ratio: number; qty_box: number }) => {
    setEditingExtra(el);
    setExtraForm({
      brand: el.brand,
      name: el.name,
      item_code: el.item_code,
      warehouse_name: el.warehouse_name,
      unit_weight: el.unit_weight > 0 ? String(el.unit_weight) : "",
      pack_ratio: el.pack_ratio > 0 ? String(el.pack_ratio) : "",
      qty_box: el.qty_box > 0 ? String(el.qty_box) : "",
    });
    setShowExtraModal(true);
  };

  const saveExtraLine = async () => {
    if (!order || !extraForm.name.trim()) return;
    setExtraSaving(true);
    try {
      const body = {
        brand: extraForm.brand.trim(),
        name: extraForm.name.trim(),
        item_code: extraForm.item_code.trim(),
        warehouse_name: extraForm.warehouse_name.trim(),
        unit_weight: parseFloat(extraForm.unit_weight) || 0,
        pack_ratio: parseFloat(extraForm.pack_ratio) || 1,
        qty_box: parseFloat(extraForm.qty_box) || 0,
      };
      if (editingExtra) {
        await api.put(`/purchase-orders/${order.id}/extra-lines/${editingExtra.id}`, body);
      } else {
        await api.post(`/purchase-orders/${order.id}/extra-lines`, body);
      }
      setShowExtraModal(false);
      await loadOrder();
      flash("Хадгалагдлаа");
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setExtraSaving(false);
    }
  };

  const deleteExtraLine = async (extraId: number) => {
    if (!order) return;
    try {
      await api.delete(`/purchase-orders/${order.id}/extra-lines/${extraId}`);
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа", false);
    }
  };

  // Add-product modal
  const [showAddModal, setShowAddModal] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [addResults, setAddResults] = useState<{ id: number; item_code: string; name: string; brand: string; warehouse_name: string }[]>([]);
  const [addSearching, setAddSearching] = useState(false);

  // Cross-brand (admin-only special case)
  const [crossBrandTarget, setCrossBrandTarget] = useState<string | null>(null);
  const [crossBrandSearch, setCrossBrandSearch] = useState("");
  const [crossBrandResults, setCrossBrandResults] = useState<{ id: number; item_code: string; name: string; brand: string; pack_ratio: number }[]>([]);
  const [crossBrandSearching, setCrossBrandSearching] = useState(false);
  const [crossBrandQtys, setCrossBrandQtys] = useState<Record<number, number>>({});
  const [crossBrandSaving, setCrossBrandSaving] = useState(false);

  const openCrossBrand = (brand: string) => {
    setCrossBrandTarget(brand);
    setCrossBrandSearch("");
    setCrossBrandResults([]);
    setCrossBrandQtys({});
  };

  // Debounced search
  useEffect(() => {
    if (!crossBrandTarget) return;
    const term = crossBrandSearch.trim();
    if (term.length < 2) { setCrossBrandResults([]); return; }
    const t = setTimeout(async () => {
      setCrossBrandSearching(true);
      try {
        const r = await api.get("/products/search", { params: { q: term } });
        // Зорилтот бренд биш бараануудыг л үзүүлнэ (давхар нэмэх утгагүй)
        setCrossBrandResults((r.data as any[]).filter((p: any) => p.brand !== crossBrandTarget));
      } catch { setCrossBrandResults([]); }
      finally { setCrossBrandSearching(false); }
    }, 250);
    return () => clearTimeout(t);
  }, [crossBrandSearch, crossBrandTarget]);

  const saveCrossBrand = async () => {
    if (!order || !crossBrandTarget) return;
    const items = Object.entries(crossBrandQtys)
      .filter(([, v]) => v > 0)
      .map(([pid, v]) => ({ product_id: parseInt(pid), qty: v }));
    if (items.length === 0) { flash("Бараа сонгоод хайрцагны тоо оруулна уу", false); return; }
    setCrossBrandSaving(true);
    try {
      for (const it of items) {
        await api.post(`/purchase-orders/${order.id}/add-line`, {
          product_id: it.product_id,
          order_qty_box: it.qty,
          override_brand: crossBrandTarget,
        });
      }
      flash(`${items.length} бараа ${crossBrandTarget} брендэд нэмэгдлээ`);
      setCrossBrandTarget(null);
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа", false);
    } finally {
      setCrossBrandSaving(false);
    }
  };

  // Filters
  const [filterBrand, setFilterBrand] = useState("");
  const [filterWarehouse, setFilterWarehouse] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [onlyOrdered, setOnlyOrdered] = useState(false);
  const [onlyReorder, setOnlyReorder] = useState(false);

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3500);
  };

  const loadOrder = async () => {
    if (!id) return;
    localActionAt.current = Date.now();  // өөрийн reload — дараагийн 3с дотор ирэх echo event-ийг үл тоомсорлоно
    setLiveUpdatePending(false);
    setLoading(true);
    setLoadError(null);
    try {
      const res = brandMode
        ? await api.get(`/purchase-orders/${id}/brand-detail`, { params: { brand: brandFilter } })
        : await api.get(`/purchase-orders/${id}`);
      store.setCurrentOrder(res.data);
      store.initQuantities(res.data.lines);
      const bvMap: Record<string, number | null> = {};
      for (const bv of (res.data.brand_vehicles ?? [])) {
        bvMap[bv.brand] = bv.vehicle_id ?? null;
      }
      setBrandVehicles(bvMap);
      const sQtys: Record<number, number> = {};
      const lQtys: Record<number, number> = {};
      const rQtys: Record<number, number> = {};
      const pInputs: Record<number, number> = {};
      const rmks: Record<number, string> = {};
      const rExtraPcs: Record<number, number> = {};
      const orderStatus = res.data.status;
      const isLoadingStage = ["loading", "transit", "arrived", "accounting", "confirmed", "received"].includes(orderStatus)
        || ["loading", "transit", "arrived", "accounting", "confirmed", "received"].includes((res.data as any).brand_status ?? "");
      for (const l of res.data.lines) {
        sQtys[l.product_id] = l.supplier_qty_box ?? 0;
        // Ачигдаж байна stage-д loaded = 0 бол захиалсан тоогоор fill хийнэ (default suggestion)
        const loadedVal = l.loaded_qty_box ?? 0;
        lQtys[l.product_id] = (loadedVal === 0 && isLoadingStage && (l.order_qty_box ?? 0) > 0)
          ? l.order_qty_box
          : loadedVal;
        // received_qty_box хоосон бол loaded_qty_box-оор дүүргэнэ
        // Харин received_qty_extra_pcs-тэй бол хэрэглэгч санаатайгаар 0 хадгалсан гэж үзнэ
        const savedExtraPcs = (l as any).received_qty_extra_pcs ?? 0;
        rQtys[l.product_id] = (l.received_qty_box && l.received_qty_box > 0)
          ? l.received_qty_box
          : (savedExtraPcs > 0 ? 0 : (lQtys[l.product_id] ?? 0));
        // unit_price хоосон бол last_purchase_price-оор дүүргэнэ
        pInputs[l.product_id] = (l.unit_price && l.unit_price > 0)
          ? l.unit_price
          : (l.last_purchase_price ?? 0);
        rmks[l.product_id] = l.remark ?? "";
        rExtraPcs[l.product_id] = (l as any).received_qty_extra_pcs ?? 0;
      }
      setSuppQtys(sQtys);
      setLoadedQtys(lQtys);
      setReceivedQtys(rQtys);
      setReceivedExtraPcs(rExtraPcs);
      setPriceInputs(pInputs);
      setRemarkInputs(rmks);
    } catch (e: any) {
      setLoadError(e?.response?.data?.detail ?? "Захиалга ачаалахад алдаа гарлаа");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadOrder();
    return () => store.setCurrentOrder(null);
  }, [id]);

  // ── Real-time: өөр хэрэглэгч энэ захиалгыг өөрчлөхөд banner харуулна.
  //    Auto-reload хийхгүй — хэрэглэгчийн бичиж байгаа тоо хэмжээ алдагдахаас сэргийлнэ.
  //    Өөрийн хадгалалтын echo-г (loadOrder-аас хойш 3с) үл тоомсорлоно.
  useLiveRefresh(["purchase-orders"], (e) => {
    const oid = (e.data as any)?.order_id;
    if (oid != null && String(oid) !== String(id)) return;  // өөр захиалга
    if (Date.now() - localActionAt.current < 3000) return;    // өөрийн өөрчлөлт
    setLiveUpdatePending(true);
  });

  const order = store.currentOrder;

  // Shipments — "Машин" багана болон "Ачилтууд" картыг тэжээнэ. Өмнө нь
  // зөвхөн loading+ статуст татдаг байсан (багана нь тэр үед л харагддаг
  // байсан учир). Одоо багана бүх статуст харагдана тул ҮРГЭЛЖ татна —
  // эс тэгвээс багана хоосон харагдаад "машин хуваарилаагүй" мэт ойлгогдоно.
  // Ачилт байхгүй үед хоосон жагсаалт буцаадаг тул зардал бага.
  // loadShipments нь зөвхөн `id`-гээс хамаардаг тул захиалгын 22 MB хариуг
  // ХҮЛЭЭХ шаардлагагүй. Өмнө нь `order` ирсний дараа эхэлдэг байсан —
  // өөрөөр хэлбэл 2 хүсэлт цуврал явдаг байв. Одоо зэрэг эхэлнэ.
  useEffect(() => {
    if (id) loadShipments();
  }, [id]);
  // Статус солигдоход ачилтын мэдээллийг шинэчилнэ (анхны ачаалалтаас тусдаа).
  useEffect(() => {
    if (order?.status) loadShipments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.status]);

  useEffect(() => {
    if (eff === "admin" || eff === "manager") {
      api.get("/logistics/vehicles").then((res) =>
        setVehicles(res.data.filter((v: any) => v.is_active))
      ).catch(() => {});
    }
  }, [role]);

  useEffect(() => {
    if (addSearch.length < 2) { setAddResults([]); return; }
    const t = setTimeout(async () => {
      setAddSearching(true);
      try {
        const res = await api.get("/products/search", { params: { q: addSearch } });
        setAddResults(res.data);
      } catch { setAddResults([]); }
      finally { setAddSearching(false); }
    }, 300);
    return () => clearTimeout(t);
  }, [addSearch]);

  const addLine = async (productId: number) => {
    if (!order) return;
    try {
      await api.post(`/purchase-orders/${order.id}/add-line`, { product_id: productId, order_qty_box: 1 });
      flash("Бараа нэмэгдлээ");
      setShowAddModal(false);
      setAddSearch("");
      setAddResults([]);
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  };

  // Brand mode: use brand_status instead of order.status for UI decisions
  const effectiveStatus = (brandMode && order)
    ? ((order as any).brand_status ?? (order as any).brand_statuses?.[brandFilter!] ?? order.status)
    : order?.status ?? "preparing";

  // ── Сарын борлуулалтын статистик (preparing/reviewing-д харагдана) ──
  type SalesStats = {
    avg_12m: number;
    avg_3m: number;
    last_month: number;
    same_month_prev_year: number;
    data_months_12m: number;
  };
  const [salesStats, setSalesStats] = useState<Record<string, SalesStats>>({});
  // Сарын борлуулалтын файл аль хугацаанд оруулагдсан эсэх (—/0 ялгахад)
  const [salesMeta, setSalesMeta] = useState<{
    has_data_12m?: boolean; has_data_3m?: boolean;
    has_data_last_month?: boolean; has_data_prev_year?: boolean;
  }>({});
  useEffect(() => {
    if (!order) { setSalesStats({}); return; }
    // Өмнө нь зөвхөн preparing/reviewing статуст татдаг байсан — багана нь
    // тэр үед л харагддаг байсан учраас. Одоо багана үргэлж харагдана тул
    // СТАТУСААР биш, БАГАНА асаалттай эсэхээр шийднэ: нуусан бол дэмий
    // мянган барааны статистик татахгүй.
    if (!cols.sales) { setSalesStats({}); return; }
    const codes = Array.from(
      new Set((order.lines || []).map((l: any) => l.item_code).filter(Boolean))
    );
    if (codes.length === 0) { setSalesStats({}); return; }
    // Захиалгын order_date → anchor сар
    const od = String(order.order_date || "");
    const ym = od.slice(0, 7).split("-");
    if (ym.length !== 2) return;
    const anchor_year  = parseInt(ym[0], 10);
    const anchor_month = parseInt(ym[1], 10);
    if (!anchor_year || !anchor_month) return;
    // Том захиалга (бүх бренд) олон мянган бараатай байж болзошгүй тул
    // 1000-аар хувааж илгээгээд үр дүнг нэгтгэнэ (нэг асар том хүсэлт + 422-оос сэргийлнэ).
    let cancelled = false;
    (async () => {
      const CHUNK = 1000;
      const merged: Record<string, SalesStats> = {};
      let meta: any = {};
      // Багцуудыг ЗЭРЭГЦЭЭ татна. Өмнө нь дараалан await хийдэг байсан —
      // 22,283 бараатай захиалганд 23 удаагийн дараалсан хүсэлт болж
      // ачаалалтын хугацааг олон секундээр уртасгаж байв. Зэрэг явуулах
      // хязгаарыг 4 болгосон: сервер SQLite дээр ажилладаг тул 23 хүсэлтийг
      // нэг дор цохих нь бусад хэрэглэгчийг удаашруулна.
      const slices: string[][] = [];
      for (let i = 0; i < codes.length; i += CHUNK) {
        slices.push(codes.slice(i, i + CHUNK) as string[]);
      }
      const POOL = 4;
      let next = 0;
      const worker = async () => {
        while (!cancelled) {
          const idx = next++;
          if (idx >= slices.length) return;
          try {
            const r = await api.post("/product-monthly-sales/stats", {
              item_codes: slices[idx], anchor_year, anchor_month,
              prev_year_month: (order as any).stat_month || null,
            });
            const { __meta__, ...items } = (r.data ?? {}) as any;
            Object.assign(merged, items);
            if (__meta__) meta = __meta__;
          } catch { /* энэ багцыг алгасна */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(POOL, slices.length) }, worker));
      if (!cancelled) { setSalesStats(merged); setSalesMeta(meta); }
    })();
    return () => { cancelled = true; };
  }, [order?.id, cols.sales, (order as any)?.stat_month]);

  // Нэгтгэлийг захиалгатай зэрэг татна (нэг GROUP BY, мөр дамжуулахгүй — 0.1 сек)
  useEffect(() => {
    if (!id) { setUnordCounts({}); setUnordTotal(0); return; }
    let dead = false;
    api.get(`/purchase-orders/${id}/unordered`)
      .then((r) => {
        if (dead) return;
        const map: Record<string, number> = {};
        for (const b of (r.data?.brands ?? [])) map[b.brand] = b.count;
        setUnordCounts(map);
        setUnordTotal(r.data?.total ?? 0);
      })
      .catch(() => { if (!dead) { setUnordCounts({}); setUnordTotal(0); } });
    return () => { dead = true; };
  }, [id]);

  // Админ бүх статуст бүх талбарыг засварлана — backend-ийн set_lines-д
  // тусгай салаа нэмсэн (purchase_orders.py). Ингэснээр статус солигдоход
  // ажил гацахгүй.
  const isAdmin = eff === "admin";
  // Бусад role-д backend зөвхөн эдгээр статуст хадгалахыг зөвшөөрдөг —
  // UI нь серверт татгалзах засварыг санал болгох ёсгүй.
  const SAVABLE_STATUSES = ["preparing", "reviewing", "loading", "arrived", "accounting"];

  const canEdit = (() => {
    if (!order) return false;
    const st = effectiveStatus;
    if (isAdmin) return true;
    if (!SAVABLE_STATUSES.includes(st)) return false;
    if (eff === "warehouse_clerk")
      return st === "preparing" || st === "arrived";
    if (eff === "accountant")
      return st === "accounting";
    if (eff === "manager" || eff === "supervisor")
      return ["preparing", "reviewing", "loading", "accounting"].includes(st);
    if (eff === "admin")
      return true;   // SAVABLE_STATUSES-ээр дээр шүүгдсэн
    return false;
  })();

  const saveLines = async () => {
    if (!order) return;
    setSaving(true);
    try {
      // ЗӨВХӨН энэ хуудсан дээр өөрчилсөн мөр/талбарыг илгээнэ — `set_lines` илгээгээгүй
      // мөрийг хөндөхгүй. Өмнө нь БҮХ мөрийг хуудас нээх үеийн утгаар илгээдэг байсан тул
      // өөр хүний завсар оруулсан тоог 0-ээр дарж байв (2026-09-22, #110, 13 бренд).
      // order_qty_box-той хамт хуудас нээх үеийн утгыг (expected) илгээж сервер тулгана.
      const diff = (a: unknown, b: unknown) => Number(a ?? 0) !== Number(b ?? 0);
      const payload: Record<string, unknown>[] = [];
      for (const l of order.lines) {
        const pid = l.product_id;
        const row: Record<string, unknown> = { product_id: pid };
        const q = store.quantities[pid];
        if (q !== undefined && diff(q, l.order_qty_box)) { row.order_qty_box = q; row.expected_order_qty_box = Number(l.order_qty_box ?? 0); }
        if (suppQtys[pid] !== undefined && diff(suppQtys[pid], l.supplier_qty_box)) row.supplier_qty_box = suppQtys[pid];
        if (loadedQtys[pid] !== undefined && diff(loadedQtys[pid], l.loaded_qty_box)) row.loaded_qty_box = loadedQtys[pid];
        if (receivedQtys[pid] !== undefined && diff(receivedQtys[pid], l.received_qty_box)) row.received_qty_box = receivedQtys[pid];
        if (receivedExtraPcs[pid] !== undefined && diff(receivedExtraPcs[pid], l.received_qty_extra_pcs)) row.received_qty_extra_pcs = receivedExtraPcs[pid];
        if (priceInputs[pid] !== undefined && diff(priceInputs[pid], l.unit_price)) row.unit_price = priceInputs[pid];
        if (remarkInputs[pid] !== undefined && (remarkInputs[pid] ?? "") !== (l.remark ?? "")) row.remark = remarkInputs[pid];
        if (Object.keys(row).length > 1) payload.push(row);
      }
      if (payload.length === 0 && !(effectiveStatus === "loading" && Object.keys(brandVehicles).length > 0)) {
        flash("Өөрчлөлт алга — хадгалах зүйлгүй"); setSaving(false); return;
      }
      const res = payload.length ? await api.post(`/purchase-orders/${order.id}/set-lines`, payload) : { data: { conflicts: [] } };
      const conflicts: { product_name: string; brand: string; server_qty_box: number; your_qty_box: number }[] = res.data?.conflicts ?? [];
      if (effectiveStatus === "loading" && Object.keys(brandVehicles).length > 0) {
        const bvPayload = Object.entries(brandVehicles).map(([brand, vehicle_id]) => ({ brand, vehicle_id: vehicle_id ?? null }));
        await api.post(`/purchase-orders/${order.id}/brand-vehicles`, bvPayload);
      }
      if (conflicts.length) {
        flash(`${conflicts.length} мөрийг өөр хүн завсар нь өөрчилсөн тул хадгалсангүй — хуудас шинэчлэгдлээ`, false);
        alert(`Дараах ${conflicts.length} мөрийн тоог та хуудас нээснээс хойш ӨӨР ХҮН өөрчилсөн байна.\nТаны утга хадгалагдаагүй, серверийн утга хэвээр үлдэв:\n\n` +
          conflicts.slice(0, 30).map((c) => `• ${c.brand} — ${c.product_name}: сервер ${c.server_qty_box}, таных ${c.your_qty_box}`).join("\n") +
          (conflicts.length > 30 ? `\n… нийт ${conflicts.length}` : "") + "\n\nХуудас шинэчлэгдсэний дараа шаардлагатай бол дахин засна уу.");
      } else {
        flash("Хадгалагдлаа");
      }
      await loadOrder();
      // Тоо=0 болсон мөр "ороогүй" болж болзошгүй — тоолол хуучрахаас сэргийлнэ
      void refreshUnordCounts();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setSaving(false);
    }
  };

  const deleteLine = async (lineId: number, confirmMessage?: string) => {
    if (!order) return;
    if (confirmMessage && !confirm(confirmMessage)) return;
    try {
      await api.delete(`/purchase-orders/${order.id}/lines/${lineId}`);
      flash("Мөр устгагдлаа");
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа", false);
    }
  };

  /* "Захиалсан тоогоор бөглөх" тэмдэглэгээ (Ачигдсан / Ирсэн баганад).
     ХАМРАХ ХҮРЭЭ: одоо ШҮҮГДСЭН мөрүүд — өөрөөр хэлбэл дэлгэц дээр
     тухайн үед хамаарч буй бараанууд. Ингэснээр бренд/агуулах/хайлтаар
     нарийсгаад зөвхөн тэр хэсгийг нь бөглөх боломжтой, мөн 22 мянган
     мөрийг санамсаргүй бөглөхөөс сэргийлнэ.
     Тэмдэглэгээг АВБАЛ тэр мөрүүдийг 0 болгоно. */
  const orderedQtyOf = (l: any) => Number(store.quantities[l.product_id] ?? l.order_qty_box ?? 0);

  /* Тэмдэглэгээг АВАХАД тэглэхгүй, өмнөх утгыг БУЦААНА. Санамсаргүй дарж
     аваад хэдэн зуун мөрд гараар оруулсан тоо устах ёсгүй. */
  const loadedSnap = useRef<Record<number, number> | null>(null);
  const receivedSnap = useRef<{ box: Record<number, number>; pcs: Record<number, number> } | null>(null);

  const fillLoadedFromOrdered = (on: boolean) => {
    setLoadedAll(on);
    if (on) {
      const snap: Record<number, number> = {};
      setLoadedQtys((prev) => {
        const next = { ...prev };
        for (const l of filteredLines) {
          snap[l.product_id] = prev[l.product_id] ?? l.loaded_qty_box ?? 0;
          next[l.product_id] = orderedQtyOf(l);
        }
        return next;
      });
      loadedSnap.current = snap;
      flash(`${filteredLines.length.toLocaleString("mn-MN")} мөрийг захиалсан тоогоор бөглөв — Хадгалах дарна уу`);
    } else {
      const snap = loadedSnap.current;
      if (snap) setLoadedQtys((prev) => ({ ...prev, ...snap }));
      loadedSnap.current = null;
      flash("Өмнөх утгыг сэргээв");
    }
  };

  const fillReceivedFromOrdered = (on: boolean) => {
    setReceivedAll(on);
    if (on) {
      const box: Record<number, number> = {};
      const pcs: Record<number, number> = {};
      setReceivedQtys((prev) => {
        const next = { ...prev };
        for (const l of filteredLines) {
          box[l.product_id] = prev[l.product_id] ?? l.received_qty_box ?? 0;
          next[l.product_id] = orderedQtyOf(l);
        }
        return next;
      });
      // Хайрцаг нь захиалсан тоотой тэнцүү болсон тул задгай ширхгийг тэглэнэ —
      // эс тэгвээс давхар тоологдоно.
      setReceivedExtraPcs((prev) => {
        const next = { ...prev };
        for (const l of filteredLines) {
          pcs[l.product_id] = prev[l.product_id] ?? (l as any).received_qty_extra_pcs ?? 0;
          next[l.product_id] = 0;
        }
        return next;
      });
      receivedSnap.current = { box, pcs };
      flash(`${filteredLines.length.toLocaleString("mn-MN")} мөрийг захиалсан тоогоор бөглөв — Хадгалах дарна уу`);
    } else {
      const snap = receivedSnap.current;
      if (snap) {
        setReceivedQtys((prev) => ({ ...prev, ...snap.box }));
        setReceivedExtraPcs((prev) => ({ ...prev, ...snap.pcs }));
      }
      receivedSnap.current = null;
      flash("Өмнөх утгыг сэргээв");
    }
  };

  /* ── Статус нь БРЕНД тус бүрийнх ────────────────────────────────────
     Захиалга өөрөө статус "жолооддоггүй": PO.status нь брендүүдийн
     хамгийн бага статусаас автоматаар тооцоологддог (backend-ийн
     _sync_po_status_from_brands). Тиймээс захиалгын горимд бүх брендийг
     нэг дор шилжүүлэх товч байхгүй — бренд бүрийг тусад нь шилжүүлнэ. */
  const brandStatuses: Record<string, string> = ((order as any)?.brand_statuses) ?? {};

  /** Тухайн БРЭНД дээр ороогүй бараа захиалж болох уу?
   *  Backend-ийн `set_lines` нь order_qty_box-ыг зөвхөн админ, эсвэл
   *  БРЭНДИЙН статус preparing/reviewing/loading үед бичдэг. arrived/accounting
   *  үед чимээгүй хаядаг тул тэнд оруулах нүд харуулбал хэрэглэгчийг хуурна. */
  const canOrderUnordered = (b: string): boolean => {
    if (!order) return false;
    if (isAdmin) return true;
    if (!["manager", "supervisor", "warehouse_clerk"].includes(eff)) return false;
    const bst = brandStatuses[b] ?? order.status;
    if (eff === "warehouse_clerk") return bst === "preparing";
    return ["preparing", "reviewing", "loading"].includes(bst);
  };
  const [brandBusy, setBrandBusy] = useState<string | null>(null);
  const [brandMenu, setBrandMenu] = useState<string | null>(null);
  /** Дамжиж буй статусын хүсэлтүүд. state биш ref — нэг render дотор хоёр
   *  дарахад хоёулаа хуучин утга уншиж давхар хүсэлт явуулахаас сэргийлнэ. */
  const statusInFlight = useRef<Set<string>>(new Set());
  const brandMenuRef = useRef<HTMLSpanElement | null>(null);

  /* ═══ Статусын ХУРДАН ЗАМ ════════════════════════════════════════════
     Статус нь ЗӨВХӨН мэдээллийн шинжтэй тул түүнийг солиход бүтэн захиалгыг
     дахин татах шаардлагагүй. Хэмжсэн: PATCH нь 14-19 мс, гэтэл араас нь
     явдаг `loadOrder()` нь 779 мс (брендийн горимд 1,771 мс) иддэг байв.

     Дахин таталтыг хассан нь ХУРДНААС гадна нэг АЛДАА ч засна: `loadOrder`
     нь `store.initQuantities` болон зургаан буферыг дахин суулгадаг тул
     статус дарах бүрд хэрэглэгчийн хадгалаагүй тоо/үнэ/тайлбар ЧИМЭЭГҮЙ
     устдаг байсан.

     Сервер дельта биш БҮТЭН зураглал буцаадаг тул хэдэн ч удаа дараалан
     дарсан клиентийн төлөв хазайхгүй. */

  const LOADING_STAGES = ["loading", "transit", "arrived", "accounting", "confirmed", "received"];

  /** Тухайн захиалгын объектоос ҮР ДҮНГИЙН статусыг гаргана (brandMode-ыг харгалзана). */
  const effStatusOf = (o: any): string =>
    (brandMode && o)
      ? (o.brand_status ?? o.brand_statuses?.[brandFilter!] ?? o.status)
      : (o?.status ?? "preparing");

  /* Статус "ачилтын үе шат" руу ОРОХОД `loadOrder` нь Ачигдсан/Ирсэн нүдийг
     захиалсан тоогоор урьдчилан бөглөдөг (мөр ~535-549). Дахин таталтыг
     хассан тул тэр бөглөлтийг ЭНД давтана — эс тэгвэл ачилтын үе шатанд
     171 нүд хоосон гарч, өгөгдөл оруулах боломж алдагдана.
     ЗӨВХӨН одоо 0 байгаа нүдийг хөндөнө — хэрэглэгчийн бичсэн утга хэвээр. */
  const seedLoadingBuffers = (lines: any[]) => {
    /** Нэг мөрийн "Ачигдсан"-ы урьдчилсан утга — loadOrder-ийн дүрэмтэй ЯГ ижил. */
    const loadedSeed = (l: any): number => {
      const saved = l.loaded_qty_box ?? 0;
      if (saved !== 0) return saved;
      return (l.order_qty_box ?? 0) > 0 ? l.order_qty_box : 0;
    };
    // Хоёр updater ТУСДАА. setState-ийг өөр setState-ийн updater дотроос
    // дуудаж болохгүй — updater нь цэвэр функц байх ёстой.
    setLoadedQtys((prev) => {
      const next = { ...prev };
      for (const l of lines) {
        const pid = l.product_id;
        if ((next[pid] ?? 0) !== 0) continue;      // хэрэглэгчийн бичсэнийг хөндөхгүй
        if ((l.loaded_qty_box ?? 0) !== 0) continue;
        const v = loadedSeed(l);
        if (v > 0) next[pid] = v;
      }
      return next;
    });
    setReceivedQtys((prev) => {
      const next = { ...prev };
      for (const l of lines) {
        const pid = l.product_id;
        if ((next[pid] ?? 0) !== 0) continue;
        if ((l.received_qty_box ?? 0) > 0) continue;
        if (((l as any).received_qty_extra_pcs ?? 0) > 0) continue;  // санаатай 0
        const v = loadedSeed(l);
        if (v > 0) next[pid] = v;
      }
      return next;
    });
  };

  /* Брендийн статусын цэсийг ГАДУУР товшиход хаана.
     Өмнө нь бүтэн дэлгэцийн `fixed inset-0` давхарга ашигладаг байсан — тэр нь
     бусад БҮХ товчны эхний товшилтыг залгидаг. Цэс одоо байнга нээлттэй үлддэг
     болсон тул тэр нь ердийн байдал болж, олон брендийг дараалан солих
     ажиллагааг эвдэх байлаа. */
  useEffect(() => {
    if (!brandMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = brandMenuRef.current;
      if (el && !el.contains(e.target as Node)) setBrandMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [brandMenu]);

  /** PATCH-ийн хариугаар store-оо ЦЭГЛЭН засна. Сүлжээний нэмэлт хүсэлт БАЙХГҮЙ. */
  const applyStatusPatch = (d: any) => {
    const cur: any = store.currentOrder;
    if (!cur || !d) return;
    const prevEff = effStatusOf(cur);

    const patch: any = {};
    if (d.brand_statuses) patch.brand_statuses = d.brand_statuses;
    if (d.po_status) patch.status = d.po_status;

    // brandMode-д `effectiveStatus` нь эхлээд `brand_status`-ыг уншдаг тул
    // түүнийг ч заавал шинэчилнэ, эс тэгвэл дэлгэц дээрх тэмдэг хуучирна.
    if (brandMode && brandFilter) {
      const bst = (d.brand_statuses && d.brand_statuses[brandFilter])
        ?? (d.brand === brandFilter ? d.new_status : undefined);
      if (bst) {
        patch.brand_status = bst;
        const i = STATUS_SEQUENCE.indexOf(bst as any);
        const nxt = i >= 0 && i < STATUS_SEQUENCE.length - 1 ? STATUS_SEQUENCE[i + 1] : null;
        patch.brand_next_status = nxt;
        patch.brand_next_status_label = nxt ? (STATUS_LABEL[nxt] ?? nxt) : "";
      }
    }

    // Захиалгын түвшний дараагийн алхам (footer-ийн товч үүнийг уншина)
    if (d.po_status) {
      const i = STATUS_SEQUENCE.indexOf(d.po_status as any);
      const nxt = i >= 0 && i < STATUS_SEQUENCE.length - 1 ? STATUS_SEQUENCE[i + 1] : null;
      patch.next_status = nxt;
      patch.next_status_label = nxt ? (STATUS_LABEL[nxt] ?? nxt) : "";
    }

    // arrived → accounting үед сервер бөглөсөн үнийг мөрүүдэд тусгана.
    // Хэрэглэгчийн гараар бичсэн үнийг ХӨНДӨХГҮЙ.
    const ups: any[] = d.price_updates ?? [];
    if (ups.length && Array.isArray(cur.lines)) {
      const byId = new Map(ups.map((x: any) => [x.line_id, x.unit_price]));
      patch.lines = cur.lines.map((l: any) =>
        byId.has(l.id) ? { ...l, unit_price: byId.get(l.id) } : l);
      setPriceInputs((prev) => {
        const next = { ...prev };
        for (const x of ups) {
          const before = next[x.product_id];
          // Буфер хоосон эсвэл хуучин last_purchase_price-тай тэнцүү бол л дарна
          if (before == null || before === 0) next[x.product_id] = x.unit_price;
        }
        return next;
      });
    }

    store.patchCurrentOrder(patch);

    // Ачилтын үе шат руу ОРСОН эсэх — орсон бол урьдчилсан бөглөлтийг давтана
    const after = { ...cur, ...patch };
    const nextEff = effStatusOf(after);
    if (!LOADING_STAGES.includes(prevEff) && LOADING_STAGES.includes(nextEff)) {
      seedLoadingBuffers(after.lines ?? cur.lines ?? []);
    }
  };

  /* === Ороогүй бараа захиалах консол ==================================
     Яагаад модал вэ: 471 бренд байхад брендээр орох гарц нь буруу нэгж.
     Брендийн толгой нь `grouped`-оос үүсдэг тул захиалсан мөргүй бренд огт
     гардаггүй — өмнөх самбарт ~446 бренд хүрэх аргагүй байв. Хэрэглэгчийн
     бодол "энэ кодыг захиалъя" болохоос "энэ брендийг нээе" биш. */

  // "Нөөц 0" — дахин захиалах бодит нэр дэвшигчид. Зөвхөн АЧААЛАГДСАН
  // мөрөнд ажиллана (сервер рүү явахгүй) тул шошгодоо ч түүнийг хэлнэ.
  const unordVisible = useMemo(
    () => (unordZeroOnly ? unordRows.filter((r) => r.stock_box === 0) : unordRows),
    [unordRows, unordZeroOnly]
  );

  // Сагс = тоо оруулсан мөрүүд. Дарааллыг ТУСАД НЬ хадгална: Object.keys нь
  // тоон түлхүүрийг өсөхөөр эрэмбэлдэг тул шинэ бараа дунд нь орж ирдэг.
  const unordCartIds = useMemo(
    () => unordCartOrder.filter((pid) => (unordQtys[pid] ?? 0) > 0),
    [unordCartOrder, unordQtys]
  );
  const unordCartBoxes = useMemo(
    () => unordCartIds.reduce((s, pid) => s + (unordQtys[pid] ?? 0), 0),
    [unordCartIds, unordQtys]
  );
  const unordCartKg = useMemo(() => unordCartIds.reduce((s, pid) => {
    const c = unordCart[pid];
    return s + (unordQtys[pid] ?? 0) * (c?.pack_ratio ?? 1) * (c?.unit_weight ?? 0);
  }, 0), [unordCartIds, unordQtys, unordCart]);
  const unordCartMnt = useMemo(() => unordCartIds.reduce((s, pid) => {
    const c = unordCart[pid];
    return s + (unordQtys[pid] ?? 0) * (c?.pack_ratio ?? 1) * (c?.last_purchase_price ?? 0);
  }, 0), [unordCartIds, unordQtys, unordCart]);

  /** Мөрийн эрх: ҮР ДҮНГИЙН бренд БА ТҮҮХИЙ бренд ХОЁУЛАА зөвшөөрөгдсөн байх
   *  ёстой. `set_lines` нь статусын маскаа `Product.brand`-аар сонгодог хэрнээ
   *  `/unordered` нь `override_brand`-аар бүлэглэдэг — зөвхөн нэгийг шалгавал
   *  UI зөвшөөрөөд backend чимээгүй хаяж {"ok": true} буцаана. */
  const unordRowEditable = (it: UnorderedItem) =>
    canOrderUnordered(it.brand) && canOrderUnordered(it.raw_brand);

  /** Зүүн талын бренд жагсаалт. `count > 0` — хадгалсны дараа тоог локалаар
   *  хасдаг тул "0" гэсэн мөр үлдэх ёсгүй. 471 энгийн товч, виртуалчлал илүүц. */
  const unordRail = useMemo(() => {
    const rq = unordRailQ.trim().toLowerCase();
    return Object.entries(unordCounts)
      .filter(([b, c]) => c > 0 && (!rq || b.toLowerCase().includes(rq)))
      .map(([brand, count]) => ({ brand, count, ok: canOrderUnordered(brand) }))
      .sort((a, b) => b.count - a.count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unordCounts, unordRailQ, (order as any)?.brand_statuses, order?.status, eff, isAdmin]);

  /* Боловсруулагчид ХУУЧИРСАН утга уншихаас сэргийлж хамгийн сүүлийн төлөвийг
     ref-д хадгална. Ингэснээр useCallback-ийг хоосон хамааралтай болгож,
     UnordRow-ийн memo үнэхээр ажиллана (эс тэгвээс товчлуур бүрд 2 000 мөр
     дахин зурагдана). Мөн "5 гэж бичээд 7 болгоход 5 хадгалагдах" төрлийн
     stale-closure алдааг бүрмөсөн хаана. */
  const unordLatest = useRef({
    visible: [] as UnorderedItem[], rows: [] as UnorderedItem[],
    qtys: {} as Record<number, number>, cart: {} as Record<number, UnorderedItem>,
    cartIds: [] as number[], done: {} as Record<number, true>,
    rail: [] as { brand: string; count: number; ok: boolean }[],
    fillSnap: null as Record<number, number> | null,
    found: 0, end: false, fetching: false, offset: 0, fillVal: 1,
    brand: null as string | null, qDeb: "", panel: false, saving: false, zeroOnly: false,
    blocking: false,
    editable: ((_it: UnorderedItem) => false) as (it: UnorderedItem) => boolean,
  });
  const unordFns = useRef({
    open: (_b?: string | null) => {}, save: async () => {},
    fill: (_on: boolean) => {}, step: (_d: 1 | -1) => {},
  });

  const fetchUnordPage = useCallback(async (offset: number, reset: boolean) => {
    if (!id) return;
    const L = unordLatest.current;
    // Хавтгай горимд шүүлтгүй бол 22 мянган мөр татахгүй — 2+ тэмдэгт шаардана.
    // Бренд сонгосон бол 1 тэмдэгт ч болно (хэмжсэн 0.06с) — эс тэгвээс нэг
    // тэмдэгт бичихэд шүүлт чимээгүй хаягдаж, UI худлаа харуулна.
    if (L.brand === null && L.qDeb.length < 2) {
      if (reset) { setUnordRows([]); setUnordFound(0); setUnordOffset(0); setUnordEnd(true); }
      return;
    }
    if (!reset && (L.end || L.rows.length >= UNORD_MAX_ROWS)) return;
    const rid = ++unordReqId.current;
    setUnordFetching(true);
    try {
      const r = await api.get(`/purchase-orders/${id}/unordered`, {
        params: {
          ...(L.brand === null ? { flat: true } : { brand: L.brand }),
          q: L.qDeb || undefined,
          limit: UNORD_PAGE, offset,
        },
        timeout: 60000,
      });
      if (rid !== unordReqId.current) return;        // хуучирсан хариу — хаяна
      const items: UnorderedItem[] = r.data?.items ?? [];
      if (offset === 0) setUnordFound(r.data?.total ?? 0);   // total зөвхөн 1-р хуудсанд
      setUnordOffset(offset + items.length);
      // Төгсгөлийг `total`-оор БИШ, ИРСЭН ТООГООР шийднэ: хадгалсны дараа
      // серверийн олонлог богиносч `total` хуучирдаг тул "Дараагийн 200"
      // товч мөнхөд үлдэж, дарахад юу ч болохгүй байх эрсдэлтэй.
      setUnordEnd(items.length < UNORD_PAGE);
      setUnordRows((prev) => (reset ? items : [...prev, ...items]).slice(0, UNORD_MAX_ROWS));
      setUnordFillSnap(null);     // жагсаалт солигдвол бөглөлтийн буцаалт хүчингүй
    } catch {
      if (rid === unordReqId.current && reset) {
        setUnordRows([]); setUnordFound(0); setUnordOffset(0); setUnordEnd(true);
      }
    } finally {
      if (rid === unordReqId.current) setUnordFetching(false);
    }
  }, [id]);

  const loadMoreUnord = useCallback(() => {
    void fetchUnordPage(unordLatest.current.offset, false);
  }, [fetchUnordPage]);

  const unordSetRef = useCallback((lineId: number, el: HTMLInputElement | null) => {
    if (el) unordInputs.current[lineId] = el;
    else delete unordInputs.current[lineId];
  }, []);

  const unordBackToSearch = useCallback(() => {
    unordSearchRef.current?.focus();
    unordSearchRef.current?.select();
  }, []);

  /** `from` байрлалаас `dir` чиглэлд хамгийн ойрын БОДИТ нүдийг олж фокуслана.
   *  Түгжээтэй/нэмэгдсэн мөрөнд нүд байхгүй тул зүгээр алгасна. */
  const unordFocusRow = useCallback((from: number, dir: 1 | -1): boolean => {
    const vis = unordLatest.current.visible;
    for (let i = from; i >= 0 && i < vis.length; i += dir) {
      const el = unordInputs.current[vis[i].line_id];
      if (el) { el.focus(); el.select(); el.scrollIntoView({ block: "nearest" }); return true; }
    }
    return false;
  }, []);

  const setUnordQty = useCallback((it: UnorderedItem, v: number) => {
    const L = unordLatest.current;
    const isNew = !((L.qtys[it.product_id] ?? 0) > 0);
    if (v > 0 && isNew && L.cartIds.length >= UNORD_CART_MAX) {
      flash(`Сагсанд ${UNORD_CART_MAX} бараа хүрлээ — эхлээд хадгална уу`, false);
      return;
    }
    setUnordQtys((prev) => {
      const next = { ...prev };
      if (v > 0) next[it.product_id] = v; else delete next[it.product_id];
      return next;
    });
    setUnordCart((prev) => {
      if (v > 0) return { ...prev, [it.product_id]: it };
      const next = { ...prev }; delete next[it.product_id]; return next;
    });
    setUnordCartOrder((prev) => (v > 0
      ? (prev.includes(it.product_id) ? prev : [...prev, it.product_id])
      : prev.filter((x) => x !== it.product_id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectUnordBrand = useCallback((b: string | null) => {
    setUnordBrand(b);
    setUnordZeroOnly(false);
    setUnordFillSnap(null);
    unordBodyRef.current?.scrollTo({ top: 0 });
  }, []);

  const stepUnordBrand = useCallback((dir: 1 | -1) => {
    if (brandMode) return;                   // brandMode-д консол нэг брендэд түгжээтэй
    const L = unordLatest.current;
    const list: (string | null)[] = [null, ...L.rail.map((r) => r.brand)];
    const cur = list.findIndex((b) => b === L.brand);
    const nxt = list[Math.min(list.length - 1, Math.max(0, (cur < 0 ? 0 : cur) + dir))];
    selectUnordBrand(nxt ?? null);
  }, [brandMode, selectUnordBrand]);

  const onUnordQtyKey = useCallback((e: any, lineId: number) => {
    if (e.ctrlKey || e.metaKey) return;      // Ctrl+Enter/Ctrl+S — глобал сонсогч барина
    const L = unordLatest.current;
    const i = L.visible.findIndex((x) => x.line_id === lineId);
    if (i < 0) return;
    if (e.key === "Escape") {
      // ЗӨВХӨН энэ мөрийг цэвэрлэнэ. Консолыг ХЭЗЭЭ Ч хаахгүй — санамсаргүй
      // нэг Esc 200 мөрийн ажлыг устгах ёсгүй.
      e.preventDefault(); e.stopPropagation();
      setUnordQty(L.visible[i], 0);
      return;
    }
    const isEnter = e.key === "Enter" || e.key === "Return"
      || e.code === "Enter" || e.code === "NumpadEnter";
    const up   = e.key === "ArrowUp"   || e.code === "ArrowUp"   || (isEnter && e.shiftKey);
    const down = e.key === "ArrowDown" || e.code === "ArrowDown" || (isEnter && !e.shiftKey);
    if (!up && !down) return;
    e.preventDefault();   // ЗААВАЛ: number input сум дарахад утгаа өөрөө +1/-1 болгодог
    if (up) { if (!unordFocusRow(i - 1, -1)) unordBackToSearch(); return; }
    if (unordFocusRow(i + 1, 1)) return;
    // Сүүлийн мөр дээр байна — дараагийн хуудсыг татаад шинэ мөрөнд үсэрнэ
    if (!L.end && !L.fetching && !L.zeroOnly && L.rows.length < UNORD_MAX_ROWS) {
      setUnordPendingFocus(i + 1);
      loadMoreUnord();
      return;
    }
    unordBackToSearch();   // өөр мөр алга — код -> Enter -> тоо -> Enter гогцоо
  }, [setUnordQty, unordFocusRow, unordBackToSearch, loadMoreUnord]);

  /** Бөөнөөр бөглөх. Хамрах хүрээ: ЗӨВХӨН харагдаж буй мөрүүд. Тэмдэглэгээ биш
   *  тодорхой ТОВЧ — 2 608 мөрийг санамсаргүй бөглөх ёсгүй. Буцаахад ТЭГЛЭХГҮЙ,
   *  өмнөх утгыг СЭРГЭЭНЭ. */
  const bulkFillUnord = useCallback((on: boolean) => {
    const L = unordLatest.current;
    if (!on) {
      const snap = L.fillSnap;
      if (snap) {
        setUnordQtys((prev) => {
          const next = { ...prev };
          for (const [k, v] of Object.entries(snap)) { if (v > 0) next[+k] = v; else delete next[+k]; }
          return next;
        });
        setUnordCartOrder((prev) => prev.filter((pid) => !(pid in snap) || (snap[pid] ?? 0) > 0));
      }
      setUnordFillSnap(null);
      flash("Өмнөх утгыг сэргээв");
      return;
    }
    const v = Math.max(1, Math.round(L.fillVal) || 1);
    let targets = L.visible.filter((it) => L.editable(it) && !L.done[it.product_id]);
    if (!targets.length) { flash("Бөглөх мөр алга", false); return; }
    // Сагсны таазаас хэтрэхгүй — set_lines рүү хязгааргүй багц илгээх ёсгүй
    const tset = new Set(targets.map((x) => x.product_id));
    const room = UNORD_CART_MAX - L.cartIds.filter((pid) => !tset.has(pid)).length;
    if (targets.length > room) {
      targets = targets.slice(0, Math.max(0, room));
      if (!targets.length) { flash(`Сагс дүүрсэн (${UNORD_CART_MAX}) — эхлээд хадгална уу`, false); return; }
      flash(`Сагсны хязгаар ${UNORD_CART_MAX} — эхний ${targets.length} мөрийг бөглөв`, false);
    }
    const snap: Record<number, number> = {};
    for (const it of targets) snap[it.product_id] = L.qtys[it.product_id] ?? 0;
    setUnordFillSnap(snap);
    setUnordQtys((prev) => {
      const next = { ...prev };
      for (const it of targets) next[it.product_id] = v;
      return next;
    });
    setUnordCart((prev) => {
      const next = { ...prev };
      for (const it of targets) next[it.product_id] = it;
      return next;
    });
    setUnordCartOrder((prev) => {
      const seen = new Set(prev);
      return [...prev, ...targets.filter((it) => !seen.has(it.product_id)).map((it) => it.product_id)];
    });
    flash(`${targets.length.toLocaleString("mn-MN")} мөрд ${v} хайрцаг бөглөв`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshUnordCounts = useCallback(async () => {
    if (!id) return;
    try {
      const s = await api.get(`/purchase-orders/${id}/unordered`);
      const map: Record<string, number> = {};
      for (const b of (s.data?.brands ?? [])) map[b.brand] = b.count;
      setUnordCounts(map); setUnordTotal(s.data?.total ?? 0);
    } catch { /* тоолол шинэчлэгдэхгүй ч ажил үргэлжилнэ */ }
  }, [id]);

  /** Сагсыг захиалгад нэмнэ. ЗӨВХӨН бөглөсөн мөрийг ХЭСЭГЧИЛСЭН payload-оор
   *  илгээнэ — `set_lines` нь илгээгээгүй мөрийг хөндөхгүй. supplier/loaded/
   *  received/price/remark-ыг ХЭЗЭЭ Ч илгээхгүй: тэдгээрийг үндсэн тор эзэмшинэ. */
  const saveUnordCart = useCallback(async () => {
    const L = unordLatest.current;
    if (!id || L.saving || L.cartIds.length === 0) return;

    // Backend маскаас гадуурх утгыг ЧИМЭЭГҮЙ хаяад {"ok":true} буцаадаг тул
    // илгээхийн ӨМНӨ өөрсдөө шүүнэ.
    const okIds: number[] = [];
    const badBrands = new Set<string>();
    for (const pid of L.cartIds) {
      const c = L.cart[pid];
      if (c && L.editable(c)) okIds.push(pid); else badBrands.add(c?.brand ?? "?");
    }
    if (badBrands.size) {
      if (!confirm(`${L.cartIds.length - okIds.length} барааг брендийн статус зөвшөөрөхгүй тул АЛГАСНА:\n${[...badBrands].join(", ")}\n\nҮлдсэн ${okIds.length} барааг нэмэх үү?`)) return;
    } else if (!confirm(`${okIds.length} барааг захиалгад нэмэх үү?\n\nХадгалсны дараа үндсэн хүснэгт шинэчлэгдэнэ.`)) return;
    if (!okIds.length) return;

    const rows = okIds.map((pid) => ({ product_id: pid, order_qty_box: L.qtys[pid] }));
    setUnordSaving(true);
    try {
      await api.post(`/purchase-orders/${id}/set-lines`, rows);

      const okSet = new Set(okIds);
      // 1) Хадгалсныг жагсаалтад "Нэмэгдсэн" болгож ҮЛДЭЭНЭ (юу нэмснээ хардаг байх).
      //    Сагсыг БҮХЭЛД НЬ цэвэрлэнэ: түгжээтэй тул алгассан бараа сагсанд
      //    үлдвэл тоолуур хэзээ ч 0 болохгүй, хаах бүрд сануулга гарна.
      setUnordDone((prev) => {
        const n = { ...prev };
        for (const pid of okIds) n[pid] = true;
        return n;
      });
      setUnordQtys({});
      setUnordCart({});
      setUnordCartOrder([]);
      setUnordFillSnap(null);

      // 2) Брендийн тоог ЛОКАЛААР хасна — нэгтгэлийн GET нь шүүлтгүй COUNT(*)
      //    хийдэг тул 2.8 секунд иддэг, харин бид хасалтаа яг мэднэ.
      const perBrand: Record<string, number> = {};
      for (const pid of okIds) { const b = L.cart[pid]?.brand; if (b) perBrand[b] = (perBrand[b] ?? 0) + 1; }
      setUnordCounts((prev) => {
        const n = { ...prev };
        for (const [b, c] of Object.entries(perBrand)) n[b] = Math.max(0, (n[b] ?? 0) - c);
        return n;
      });
      setUnordTotal((tt) => Math.max(0, tt - okIds.length));

      // 3) Үндсэн хүснэгтийг ЗААВАЛ дахин уншина: шинэ бренд, PDF/Excel-ийн
      //    бренд жагсаалт, брендийн статус бүгд үүнээс хамаарна.
      await loadOrder();
      // 4) Консолын жагсаалтыг ЭХНИЙ хуудаснаас дахин татна. Хадгалсан мөр
      //    серверийн ороогүй олонлогоос ГАРДАГ тул хуучин `offset`-оор цааш
      //    үргэлжлүүлбэл яг тэр тооны барааг мөнхөд алгасана.
      await fetchUnordPage(0, true);
      const skipped = L.cartIds.length - okIds.length;
      flash(`${okIds.length.toLocaleString("mn-MN")} бараа захиалгад нэмэгдлээ`
        + (skipped > 0 ? ` (${skipped} алгассан)` : ""));
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Нэмэхэд алдаа гарлаа", false);
    } finally { setUnordSaving(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fetchUnordPage]);

  const openUnordPanel = useCallback((brand?: string | null) => {
    setShowColMenu(false);
    setBrandMenu(null);
    if (brandMode && brandFilter) setUnordBrand(brandFilter);
    else if (brand !== undefined) setUnordBrand(brand);
    // Үндсэн торын хайлтыг өвлүүлнэ — өмнөх чип ийм зан төлөвтэй байсан
    setUnordQ((q) => q || filterSearch || "");
    setUnordPanel(true);
  }, [brandMode, brandFilter, filterSearch]);

  // Сагс консолыг хаахад УСТАХГҮЙ (төлөв хэвээр) тул баталгаажуулалт хэрэггүй.
  const closeUnordPanel = useCallback(() => { setUnordPanel(false); }, []);

  /* Хамгийн сүүлийн төлөв/функцийг ref-д тавина. Хамааралгүй effect —
     commit бүрд ажиллана, тиймээс боловсруулагчид үргэлж шинэ утга уншина.
     Энэ effect БУСДААС ӨМНӨ зарлагдсан тул доорх effect-үүд шинэ утга уншина. */
  useEffect(() => {
    unordLatest.current = {
      visible: unordVisible, rows: unordRows, qtys: unordQtys, cart: unordCart,
      cartIds: unordCartIds, done: unordDone, rail: unordRail, fillSnap: unordFillSnap,
      found: unordFound, end: unordEnd, fetching: unordFetching, offset: unordOffset,
      fillVal: unordFillVal, brand: unordBrand, qDeb: unordQDeb, panel: unordPanel,
      saving: unordSaving, zeroOnly: unordZeroOnly,
      blocking: showAddModal || showExtraModal || showPDFModal || showERPModal || !!crossBrandTarget,
      editable: unordRowEditable,
    };
    unordFns.current = {
      open: openUnordPanel, save: saveUnordCart, fill: bulkFillUnord, step: stepUnordBrand,
    };
  });

  /* Консол нээлттэй үед хуудасны их биеийг ГҮЙЛГЭХГҮЙ болгоно.
     Эс тэгвээс жагсаалтын төгсгөлд хүрсэн дугуйны эргэлт ард байгаа
     хуудсыг гүйлгэж, консолыг хаахад хэрэглэгч огт өөр байрлалд үлддэг. */
  useEffect(() => {
    if (!unordPanel) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [unordPanel]);

  // 350мс debounce — товчлуур бүрд сервер рүү хүсэлт явуулж БОЛОХГҮЙ
  useEffect(() => {
    if (!unordPanel) return;
    const tm = setTimeout(() => setUnordQDeb(unordQ.trim()), 350);
    return () => clearTimeout(tm);
  }, [unordQ, unordPanel]);

  // Нээгдэх / бренд / хайлт солигдоход ЭХНИЙ хуудсыг дахин татна.
  // САГС хөндөгдөхгүй тул хуудасны хязгаар нь "хүрэхгүй бараа" болохгүй.
  useEffect(() => {
    if (!unordPanel) return;
    void fetchUnordPage(0, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unordPanel, unordBrand, unordQDeb]);

  // Дараагийн хуудас ирсний дараа фокусыг шинэ мөрөнд тавина
  useEffect(() => {
    if (unordPendingFocus == null) return;
    const i = unordPendingFocus;
    setUnordPendingFocus(null);
    requestAnimationFrame(() => { if (!unordFocusRow(i, 1)) unordBackToSearch(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unordRows, unordPendingFocus]);

  /* Глобал товчлуур. `e.code`-оор шалгана: кирилл гар идэвхтэй үед `e.key` нь
     "ө"/"ы"/"а" болдог тул `e.key === "k"` гэвэл манай хэрэглэгчдийн хувьд
     товчлуур ЧИМЭЭГҮЙ ажиллахаа болино. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = unordLatest.current;
      const mod = e.ctrlKey || e.metaKey;
      const tgt = e.target as HTMLElement | null;
      const typing = !!tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA"
        || tgt.tagName === "SELECT" || tgt.isContentEditable);
      if (mod && e.code === "KeyK") {
        if (!L.panel && L.blocking) return;    // өөр модал нээлттэй бол оролцохгүй
        e.preventDefault();
        if (L.panel) closeUnordPanel(); else unordFns.current.open();
        return;
      }
      if (e.code === "F2" && !typing && !L.panel && !L.blocking) {
        e.preventDefault(); unordFns.current.open(); return;
      }
      if (!L.panel) return;
      if (mod && (e.code === "Enter" || e.code === "NumpadEnter" || e.code === "KeyS")) {
        e.preventDefault(); void unordFns.current.save(); return;
      }
      if (e.altKey && e.code === "KeyA")      { e.preventDefault(); unordFns.current.fill(true); return; }
      if (e.altKey && e.code === "ArrowDown") { e.preventDefault(); unordFns.current.step(1);  return; }
      if (e.altKey && e.code === "ArrowUp")   { e.preventDefault(); unordFns.current.step(-1); return; }
      if (mod && e.code === "KeyF")           { e.preventDefault(); unordBackToSearch(); return; }
      // Esc: тоо оруулах нүд ба хайлтын талбар өөрсдөө барьж stopPropagation
      // хийсэн байх ёстой — энд ирсэн бол ХААХ гэсэн үг.
      if (e.key === "Escape") { e.preventDefault(); closeUnordPanel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeUnordPanel, unordBackToSearch]);


  const advanceBrand = async (brand: string) => {
    if (!order || statusInFlight.current.has(brand)) return;
    statusInFlight.current.add(brand);
    setBrandBusy(brand);
    try {
      localActionAt.current = Date.now();   // өөрийн өөрчлөлт — echo event-ийг үл тоомсорлоно
      const r = await api.patch(`/purchase-orders/${order.id}/brand-advance`, null, { params: { brand } });
      applyStatusPatch(r.data);             // дахин ТАТАХГҮЙ — store-оо цэглэн засна
      const n = r.data?.price_updated_count ?? 0;
      flash(`${brand} → ${r.data?.new_status_label ?? "шинэчлэгдлээ"}`
        + (n ? ` · ${n} мөрийн үнэ бөглөгдлөө` : ""));
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      statusInFlight.current.delete(brand);
      setBrandBusy((b) => (b === brand ? null : b));
    }
  };

  /* Цэсийг ХААХГҮЙ — хэрэглэгч дараалан хэд хэдэн статус сонгож болно
     (хүсэлт: "Status холбоотой нэмэлт цонх зэрэг нь бүгд нээлттэй байхаар"). */
  const forceBrandStatus = async (brand: string, status: string) => {
    if (!order || statusInFlight.current.has(brand)) return;
    statusInFlight.current.add(brand);
    setBrandBusy(brand);
    try {
      localActionAt.current = Date.now();
      const r = await api.patch(`/purchase-orders/${order.id}/force-status`, { status }, { params: { brand } });
      applyStatusPatch(r.data);             // дахин ТАТАХГҮЙ
      flash(`${brand} → ${STATUS_LABEL[status] ?? status}`);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      statusInFlight.current.delete(brand);
      setBrandBusy((b) => (b === brand ? null : b));
    }
  };

  // Тухайн брендийг дэвшүүлэх эрхтэй эсэх (backend-ийн advance_brand_status-тай ижил)
  const canAdvanceBrand = (st: string) => {
    if (!st) return false;
    if (STATUS_SEQUENCE.indexOf(st as any) >= STATUS_SEQUENCE.length - 1) return false;
    // Backend-ийн advance_brand_status-тай ЯГ ижил зөвшөөрөх жагсаалт.
    const allowed = ["manager", "supervisor", "admin"];
    if (["accounting", "confirmed"].includes(st)) allowed.push("accountant");
    return allowed.includes(eff);
  };

  /* Бүх брендийг нэг алхам дэвшүүлэх (зөвхөн админ).
     Захиалгын статусыг шууд өөрчлөхгүй — бренд бүрийг тусад нь дэвшүүлж,
     PO статус нь тэдгээрээс автоматаар тооцоологдоно. Хэрэгтэй шалтгаан:
     (1) 25 бренд бүрийг гараар дарах нь төвөгтэй; (2) урьд нь захиалгын
     түвшний товч хоцорсон брендүүдийг зэрэгцүүлдэг байсныг орлоно. */
  const advanceAllBrands = async () => {
    if (!order) return;
    const targets = Object.entries(brandStatuses)
      .filter(([, st]) => canAdvanceBrand(st))
      .map(([b]) => b);
    if (!targets.length) { flash("Дэвшүүлэх бренд алга", false); return; }
    if (!confirm(`${targets.length} брендийг дараагийн үе шат руу шилжүүлэх үү?

Бренд бүр өөрийн статусаасаа нэг алхам урагшилна.`)) return;
    setAdvancing(true);
    let ok = 0;
    const errs: string[] = [];
    for (const b of targets) {
      try {
        localActionAt.current = Date.now();
        const r = await api.patch(`/purchase-orders/${order.id}/brand-advance`, null, { params: { brand: b } });
        // Хариу бүр БҮТЭН зураглал агуулдаг тул давталтын төгсгөлд ч, дундуур ч
        // хэрэглэхэд адилхан зөв — дахин татах шаардлагагүй.
        applyStatusPatch(r.data);
        ok++;
      } catch (e: any) {
        errs.push(`${b}: ${e?.response?.data?.detail ?? "алдаа"}`);
      }
    }
    setAdvancing(false);
    flash(errs.length
      ? `${ok} бренд шилжлээ, ${errs.length} алдаатай — ${errs.slice(0, 2).join("; ")}`
      : `${ok} бренд шилжлээ`, !errs.length);
  };


  const advanceStatus = async () => {
    if (!order || advancing) return;
    setAdvancing(true);
    try {
      localActionAt.current = Date.now();
      const r = brandMode && brandFilter
        ? await api.patch(`/purchase-orders/${order.id}/brand-advance`, null, { params: { brand: brandFilter } })
        : await api.patch(`/purchase-orders/${order.id}/status`);
      applyStatusPatch(r.data);        // дахин ТАТАХГҮЙ (779 мс -> 0)
      const n = r.data?.price_updated_count ?? 0;
      flash((brandMode && brandFilter ? `${brandFilter} — Статус шинэчлэгдлээ` : "Статус шинэчлэгдлээ")
        + (n ? ` · ${n} мөрийн үнэ бөглөгдлөө` : ""));
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setAdvancing(false);
    }
  };

  /* Цэс НЭЭЛТТЭЙ үлдэнэ — хэрэглэгч дараалан хэд хэдэн статус сонгож болно. */
  const forceStatus = async (newStatus: string) => {
    if (!order) return;
    const key = brandMode && brandFilter ? brandFilter : "__po__";
    if (statusInFlight.current.has(key)) return;
    statusInFlight.current.add(key);
    try {
      localActionAt.current = Date.now();
      const params = brandMode && brandFilter ? { brand: brandFilter } : undefined;
      const r = await api.patch(`/purchase-orders/${order.id}/force-status`, { status: newStatus }, { params });
      applyStatusPatch(r.data);        // дахин ТАТАХГҮЙ
      flash(brandMode && brandFilter ? `${brandFilter} — Статус шинэчлэгдлээ` : "Статус шинэчлэгдлээ");
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      statusInFlight.current.delete(key);
    }
  };

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const deleteOrder = async () => {
    if (!order) return;
    try {
      await api.delete(`/purchase-orders/${order.id}`);
      navigate("/order");
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа", false);
      setShowDeleteConfirm(false);
    }
  };

  const revertStatus = async () => {
    if (!order) return;
    try {
      const r = await api.post(`/purchase-orders/${order.id}/revert`);
      applyStatusPatch(r.data);        // дахин ТАТАХГҮЙ
      flash("Статус буцлаа");
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  };

  const assignVehicle = async (vehicleId: number | null) => {
    if (!order) return;
    setVehicleSaving(true);
    try {
      const res = await api.patch(`/purchase-orders/${order.id}/vehicle`, { vehicle_id: vehicleId });
      store.setCurrentOrder({ ...order, vehicle_id: res.data.vehicle_id, vehicle_name: res.data.vehicle_name });
      flash(vehicleId ? "Машин оноогдлоо" : "Машин тайлагдлаа");
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setVehicleSaving(false);
    }
  };

  const canAdvance = () => {
    if (!order) return false;
    const st = effectiveStatus;
    if (st === "received") return false;
    if (eff === "warehouse_clerk") return false;
    if (eff === "accountant") return st === "accounting" || st === "confirmed";
    if (eff === "manager" || eff === "supervisor" || eff === "admin") return true;
    return false;
  };

  const advanceLabel = () => {
    const st = effectiveStatus;
    if (st === "preparing") return "Хянуулахаар илгээх";
    if (st === "reviewing") return "Захиалга илгээх";
    if (st === "arrived") return "Нягтлан руу илгээх";
    if (st === "accounting") return "Нягтлан Баталгаажуулах";
    if (st === "confirmed") return "Орлого авагдсан болгох";
    if (brandMode) {
      const nextLabel = (order as any)?.brand_next_status_label;
      return nextLabel ? `→ ${nextLabel}` : "Дэвшүүлэх";
    }
    const nextLabel = order?.next_status_label;
    return nextLabel ? `→ ${nextLabel}` : "Дэвшүүлэх";
  };

  // warehouse_clerk preparing үед бүх бараанд тоо оруулах боломжтой
  const isEnteringQty = eff === "warehouse_clerk" && effectiveStatus === "preparing";

  // qty шүүлт хэрэглэсэн суурь мөрүүд
  const baseLines = order
    ? order.lines.filter((l) => {
        // isEnteringQty горимд onlyOrdered check хийгээгүй бол бүгдийг харуулна
        // onlyOrdered check хийсэн бол зөвхөн тоо > 0 бараа харагдана
        if (!isEnteringQty || onlyOrdered) {
          const qty = store.quantities[l.product_id] ?? l.order_qty_box;
          if (qty <= 0) return false;
        }
        return true;
      })
    : [];

  // brands: сонгосон агуулахад байгаа брэндүүд
  const brands = [...new Set(
    baseLines
      .filter((l) => !filterWarehouse || l.warehouse_name === filterWarehouse)
      .map((l) => l.brand)
  )].sort();

  // warehouses: сонгосон брэндэд байгаа агуулахууд
  const warehouses = [...new Set(
    baseLines
      .filter((l) => !filterBrand || l.brand === filterBrand)
      .map((l) => l.warehouse_name)
  )].filter((w) => w && w !== "nan").sort();

  const searchTerm = filterSearch.trim().toLowerCase();
  const filteredLines = baseLines.filter((l) => {
    if (filterBrand && l.brand !== filterBrand) return false;
    if (filterWarehouse && l.warehouse_name !== filterWarehouse) return false;
    if (onlyReorder && !(l as any).needs_reorder) return false;
    if (searchTerm) {
      const hit = l.item_code.toLowerCase().includes(searchTerm) ||
                  l.name.toLowerCase().includes(searchTerm);
      if (!hit) return false;
    }
    return true;
  });

  // Reorder count (checkbox-ийн badge)
  const reorderCount = baseLines.filter((l) => (l as any).needs_reorder).length;

  // isEnteringQty горимд шүүлтгүй бол хязгаарлах (гацахгүй байхын тулд)
  const RENDER_LIMIT = 300;
  const needsFilter = isEnteringQty && !onlyOrdered && filteredLines.length > RENDER_LIMIT && !filterBrand && !filterWarehouse && !searchTerm;
  const renderLines = needsFilter ? [] : filteredLines;

  const grouped: Record<string, typeof filteredLines> = {};
  for (const l of renderLines) {
    if (!grouped[l.brand]) grouped[l.brand] = [];
    grouped[l.brand].push(l);
  }

  const totalBoxes = order
    ? order.lines.reduce((s, l) => s + (store.quantities[l.product_id] ?? l.order_qty_box), 0)
      + (order.extra_lines ?? []).reduce((s, el) => s + el.qty_box, 0)
    : 0;
  const totalWeight = order
    ? order.lines.reduce((s, l) => {
        const qBox = store.quantities[l.product_id] ?? l.order_qty_box;
        return s + qBox * l.pack_ratio * l.unit_weight;
      }, 0)
      + (order.extra_lines ?? []).reduce((s, el) => s + el.computed_weight, 0)
    : 0;
  const totalAmount = order
    ? order.lines.reduce((s, l) => {
        const received = receivedQtys[l.product_id] ?? l.received_qty_box ?? 0;
        const extraPcs = receivedExtraPcs[l.product_id] ?? l.received_qty_extra_pcs ?? 0;
        const packRatio = l.pack_ratio || 1;
        const price = priceInputs[l.product_id] ?? l.unit_price ?? 0;
        const totalPcs = received * packRatio + extraPcs;
        return s + price * totalPcs;
      }, 0)
    : 0;

  const currentIdx = STATUS_SEQUENCE.indexOf(effectiveStatus as any);

  // ── ЗАСВАРЛАХ эрх: статус + role (харагдацаас тусдаа) ───────────────
  // Багана харагдаж байгаа нь түүнийг өөрчилж болно гэсэн үг биш.
  // Админд эдгээр "үе шатны хориг" хамаарахгүй — бүх талбар засварлагдана.
  const stageArrived  = !isAdmin && ["arrived", "accounting", "confirmed", "received"].includes(effectiveStatus);
  const stagePlanning = isAdmin || ["preparing", "reviewing"].includes(effectiveStatus);
  const canEditLoaded = isAdmin || (effectiveStatus === "loading"
    && (eff === "manager" || eff === "supervisor"));
  const canEditReceivedStage = isAdmin || (effectiveStatus === "arrived"
    && eff === "warehouse_clerk");
  const canEditPriceStage = isAdmin || (effectiveStatus === "accounting"
    && ["accountant", "manager", "supervisor"].includes(eff));
  // Мөр устгах: админд бүх статуст (backend ч зөвшөөрнө), бусдад ачилтын үед.
  const showRowActions = isAdmin || effectiveStatus === "loading";

  // Тухайн үе шатанд ЗААВАЛ бөглөх багана — хэрэглэгч нуусан ч харагдана.
  // Эс тэгвээс "Ачигдсан"-г нуучихаад ачилтын тоогоо оруулах газаргүй болно.
  const forcedCols: Partial<Record<ColKey, boolean>> = {
    order:    canEdit && !stageArrived,
    loaded:   canEditLoaded,
    received: canEditReceivedStage,
    price:    canEditPriceStage,
  };

  // ── Багана ХАРАГДАЦ: хэрэглэгчийн сонголт (статусаар нуугдахаа больсон) ──
  const showStockCols      = cols.stock;
  const showSalesStatsCols = cols.sales;
  const showUnitWeightCols = cols.unitWeight;
  const showVehicleCol     = cols.vehicle;
  const showEstCostCols    = cols.estCost;
  const showOrderCol       = cols.order    || !!forcedCols.order;
  const showLoadedCol      = cols.loaded   || !!forcedCols.loaded;
  const showReceivedCols   = cols.received || !!forcedCols.received;
  const showPriceCols      = cols.price    || !!forcedCols.price;
  // Үнэ зөрүү нь үнийн блокийн дотор зурагддаг тул түүнээс хамаарна —
  // эс тэгвээс colCount тоолж байхад th нь зурагдахгүй үлдэнэ.
  const showPriceDiff      = showPriceCols && cols.priceDiff;

  const colCount = (() => {
    // Үргэлж: Агуулах, Код, Нэр, Жин (4)
    let n = 4;
    if (showStockCols)      n += 2;  // Нөөц, Хайрцагны тоо
    if (showUnitWeightCols) n += 2;  // Нэгж жин, Хайрцаг/ш
    if (showOrderCol)       n += 1;  // Захиалах
    if (showSalesStatsCols) n += 4;  // 12с, 3с, сүүлийн сар, өмнөх он
    if (showEstCostCols)    n += 2;  // Нэгж үнэ, Тооцоолсон дүн
    if (showLoadedCol)      n += 1;  // Ачигдсан (нэгтгэсэн)
    if (showReceivedCols)   n += 3;  // Ирсэн, Зөрүү, Тайлбар
    if (showPriceCols)      n += showPriceDiff ? 4 : 3;
    if (showVehicleCol)     n += 1;  // Машин
    if (showRowActions)     n += 1;  // мөр устгах товчны багана
    return n;
  })();

  // Бодитоор зурагдаж буй байдал (сонголт + албадлага + хамаарал).
  const colVisible: Record<ColKey, boolean> = {
    stock: showStockCols, unitWeight: showUnitWeightCols, order: showOrderCol,
    sales: showSalesStatsCols, estCost: showEstCostCols, loaded: showLoadedCol,
    received: showReceivedCols, price: showPriceCols, priceDiff: showPriceDiff,
    vehicle: showVehicleCol,
  };
  // "Үнэ зөрүү" нь үнийн блокийн дотор байдаг тул үнэ нуугдвал энэ ч нуугдана —
  // тэмдэглэгээ бодит байдлыг харуулахын тулд түүнийг ч тооцно.
  const hiddenColCount = COLUMN_GROUPS.filter((g) => !colVisible[g.key]).length;

  // ── Loading skeleton ──
  // Өмнө нь дэлгэцийн голд ганц эргэдэг тэмдэг байсан — 22 мянган мөртэй
  // захиалганд хэдэн секунд юу ч харагдахгүй, хэр удахыг мэдэхгүй байдалд
  // ордог байв. Одоо хуудасны БОДИТ бүтцийг саарал хайрцгаар зурна:
  // хэрэглэгч юу ирэхийг шууд ойлгож, ачаалалт богино мэт мэдрэгдэнэ.
  if (loading && !order) {
    return (
      <div className="animate-pulse">
        {/* Толгой */}
        <div className="rounded-apple bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="h-7 w-7 rounded-lg bg-gray-200" />
            <div className="h-6 w-40 rounded bg-gray-200" />
            <div className="h-5 w-28 rounded-full bg-gray-100" />
            <div className="ml-auto flex gap-2">
              {[0, 1, 2].map((i) => <div key={i} className="h-9 w-24 rounded-lg bg-gray-100" />)}
            </div>
          </div>
          {/* Үе шатны зурвас */}
          <div className="mt-5 flex items-center gap-2 overflow-hidden">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="flex flex-1 items-center gap-2">
                <div className="h-7 w-7 shrink-0 rounded-full bg-gray-200" />
                {i < 8 && <div className="h-0.5 flex-1 rounded bg-gray-100" />}
              </div>
            ))}
          </div>
        </div>

        {/* Хэрэгслийн мөр + хүснэгт */}
        <div className="mt-3 overflow-hidden rounded-apple bg-white shadow-sm">
          <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50/60 px-4 py-3">
            <div className="h-8 w-36 rounded-lg bg-gray-200" />
            <div className="h-8 w-32 rounded-lg bg-gray-100" />
            <div className="h-8 w-44 rounded-lg bg-gray-100" />
            <div className="ml-auto h-7 w-24 rounded-md bg-gray-100" />
          </div>
          {Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-b border-gray-50 px-4 py-3">
              <div className="h-3 w-20 rounded bg-gray-100" />
              <div className="h-3 w-16 rounded bg-gray-100" />
              <div className="h-3 flex-1 rounded bg-gray-200" style={{ maxWidth: `${28 + ((i * 7) % 26)}%` }} />
              <div className="h-3 w-14 rounded bg-gray-100" />
              <div className="h-7 w-16 rounded-lg bg-gray-100" />
              <div className="h-3 w-12 rounded bg-gray-100" />
            </div>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-center gap-2 text-xs text-gray-400">
          <RefreshCw size={13} className="animate-spin text-[#0071E3]" />
          Захиалгын мэдээлэл уншиж байна…
        </div>
      </div>
    );
  }

  if (loadError || !order) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-24">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-red-50">
          <AlertCircle size={24} className="text-red-500" />
        </div>
        <p className="text-sm font-medium text-gray-700">{loadError ?? "Захиалга олдсонгүй"}</p>
        <button
          onClick={() => navigate("/order")}
          className="inline-flex items-center gap-1.5 rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          <ChevronLeft size={15} /> Жагсаалт руу буцах
        </button>
      </div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="overflow-x-hidden">

      {/* ── Fixed toast ── */}
      <AnimatePresence>
        {msg && (
          <motion.div
            initial={{ opacity: 0, y: -12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className={`fixed left-3 right-3 top-3 z-[70] flex items-center gap-2.5 rounded-xl px-4 py-3 shadow-lg text-sm font-medium sm:left-auto sm:right-5 sm:top-5 sm:max-w-sm ${
              msg.ok
                ? "bg-emerald-600 text-white"
                : "bg-red-600 text-white"
            }`}
          >
            {msg.ok ? <CheckCheck size={15} className="shrink-0"/> : <AlertCircle size={15} className="shrink-0"/>}
            <span className="min-w-0 break-words">{msg.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Real-time update banner (өөр хэрэглэгч өөрчилсөн) ── */}
      <AnimatePresence>
        {liveUpdatePending && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            className="mb-3 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800"
          >
            <AlertCircle size={16} className="shrink-0 text-amber-600" />
            <span className="min-w-0 flex-1">Өөр хэрэглэгч энэ захиалгыг шинэчиллээ. Хамгийн сүүлийн мэдээллийг харъя.</span>
            <button
              onClick={loadOrder}
              className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700"
            >
              <RefreshCw size={12} className="mr-1 inline" />Дахин ачаалах
            </button>
            <button
              onClick={() => setLiveUpdatePending(false)}
              className="shrink-0 rounded-lg p-1 text-amber-500 hover:bg-amber-100"
              title="Хаах"
            >
              <X size={14} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Header card ── */}
      <div className="rounded-2xl bg-white px-4 py-3.5 shadow-sm ring-1 ring-gray-100 sm:px-5 sm:py-4">
        {/* Top row: back + title + status */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <button
            onClick={() => navigate(brandMode ? `/order/${id}/dashboard` : "/order")}
            className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-700 transition-colors"
          >
            <ChevronLeft size={15} />
            {brandMode ? "Dashboard" : "Буцах"}
          </button>
          <div className="h-4 w-px bg-gray-200" />
          <h1 className="text-lg font-bold tracking-tight text-gray-900 sm:text-xl">
            {order.order_date.replaceAll("-", "/")}
          </h1>
          <span className="text-xs text-gray-400 sm:text-sm">#{order.id}</span>
          {brandMode && brandFilter && (
            <>
              <div className="h-4 w-px bg-gray-200" />
              <span className="rounded-full bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-700 ring-1 ring-inset ring-blue-100">
                {brandFilter}
              </span>
            </>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ring-black/5 ${
              STATUS_COLOR[effectiveStatus] ?? "bg-gray-100 text-gray-600"
            }`}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60"/>
            {brandMode
              ? STATUS_LABEL[effectiveStatus as keyof typeof STATUS_LABEL] ?? effectiveStatus
              : order.status_label}
          </span>

          {/* Байршил — Нөөц баганы эх сурвалж. ҮРГЭЛЖ харагдана (багана нуусан
              ч захиалга аль байршлынх нь мэдэгдэх ёстой), харин ӨӨРЧЛӨХ нь
              зөвхөн төлөвлөх үе шатанд — дунд замд солих нь Нөөц баганы утгыг
              бүхэлд нь өөрчилнө. */}
          {(
            (stagePlanning && canEdit && !brandMode) ? (
              <select
                value={((order as any).location === "showroom") ? "showroom" : "warehouse"}
                onChange={async (e) => {
                  try {
                    await api.put(`/purchase-orders/${order.id}/location`, { location: e.target.value });
                    await loadOrder();
                  } catch (err: any) { flash(err?.response?.data?.detail ?? "Алдаа гарлаа", false); }
                }}
                title="Захиалгын байршил — Нөөцийн эх сурвалж"
                className="rounded-full border border-violet-200 bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 outline-none focus:ring-2 focus:ring-violet-200"
              >
                <option value="warehouse">📦 Агуулах</option>
                <option value="showroom">🏪 Заал</option>
              </select>
            ) : (
              <span className="rounded-full bg-violet-50 px-2.5 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-inset ring-violet-100">
                {((order as any).location === "showroom") ? "🏪 Заал" : "📦 Агуулах"}
              </span>
            )
          )}

          {/* Статистикийн сар — харьцуулах сар. Үргэлж харагдана, өөрчлөх нь
              зөвхөн төлөвлөх үе шатанд. */}
          {(
            (stagePlanning && canEdit && !brandMode) ? (
              <select
                value={(order as any).stat_month || ""}
                onChange={async (e) => {
                  try {
                    await api.put(`/purchase-orders/${order.id}/stat-month`, { stat_month: e.target.value ? Number(e.target.value) : null });
                    await loadOrder();
                  } catch (err: any) { flash(err?.response?.data?.detail ?? "Алдаа гарлаа", false); }
                }}
                title="Өмнөх он харьцуулах сар"
                className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 outline-none focus:ring-2 focus:ring-amber-200"
              >
                <option value="">📊 Сар: автомат</option>
                {Array.from({ length: 12 }, (_, i) => i + 1).map((mo) => (
                  <option key={mo} value={mo}>📊 {mo}-р сар</option>
                ))}
              </select>
            ) : ((order as any).stat_month ? (
              <span className="rounded-full bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-100">📊 {(order as any).stat_month}-р сар</span>
            ) : null)
          )}
        </div>

        {/* Meta + actions row */}
        <div className="mt-3 flex flex-col gap-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          <p className="text-[11px] text-gray-400 sm:text-xs">
            <span className="font-medium text-gray-600">{order.created_by_username}</span>
            {" · "}
            <span className="hidden sm:inline">{new Date(order.created_at ?? "").toLocaleString("mn-MN")}{" · "}</span>
            <span className="font-medium text-gray-600">{order.lines.length} нэр төрөл</span>
          </p>

          {/* Action buttons */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            {canEdit && (
              <button
                onClick={saveLines}
                disabled={saving}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 active:bg-gray-100 disabled:opacity-50 transition-colors"
              >
                {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
                Хадгалах
              </button>
            )}
            {/* Экспортын товчнууд статусаас ҮЛ ХАМААРАН харагдана. Серверийн
                талд ч эдгээр зам статус шалгадаггүй — зөвхөн role шалгадаг
                (export-pdf: нэвтэрсэн хүн, export-excel: нягтлан/хянагч/админ,
                export-erp-excel: + менежер). Тиймээс аль ч үе шатанд татаж
                болно. */}
            <button
              onClick={() => setShowPDFModal(true)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors"
            >
              <FileDown size={13} />
              PDF татах
            </button>
            {["admin", "supervisor", "manager"].includes(eff) && (
              <button
                onClick={() => setShowHistory(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors"
                title="Захиалгын өөрчлөлтийн түүх"
              >
                <History size={13} />
                Түүх
              </button>
            )}
            {(eff === "accountant" || eff === "admin") && effectiveStatus === "accounting" && (
              <button
                onClick={revertStatus}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-medium text-amber-700 shadow-sm hover:bg-amber-100 active:bg-amber-200 transition-colors"
              >
                <RotateCcw size={13} />
                Ачаа ирсэн рүү буцаах
              </button>
            )}
            {/* Excel / ERP импорт — статусаас үл хамааран, зөвхөн эрхээр.
                Backend-ийн require_role-той ижил жагсаалт: эрхгүй хүнд товч
                харагдаад 403 авах нь утгагүй. */}
            {/* export-excel: accountant / supervisor / admin (менежер ОРОХГҮЙ) */}
            {["accountant", "supervisor", "admin"].includes(eff) && (
              <button
                onClick={async () => {
                  try {
                    const res = await api.get(`/purchase-orders/${order.id}/export-excel`, { responseType: "blob" });
                    const url = URL.createObjectURL(new Blob([res.data]));
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `po_${order.id}_${order.order_date}.xlsx`;
                    a.click();
                    URL.revokeObjectURL(url);
                  } catch {
                    flash("Excel татахад алдаа гарлаа", false);
                  }
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-xs font-medium text-emerald-700 shadow-sm hover:bg-emerald-100 active:bg-emerald-200 transition-colors"
              >
                <FileDown size={13} />
                Excel татах
              </button>
            )}
            {/* export-erp-excel: admin / manager / accountant / supervisor */}
            {["accountant", "supervisor", "manager", "admin"].includes(eff) && (
              <button
                onClick={() => setShowERPModal(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 shadow-sm hover:bg-blue-100 active:bg-blue-200 transition-colors"
              >
                <FileDown size={13} />
                ERP Импорт
              </button>
            )}
            {/* Захиалгын түвшний "Статус өөрчлөх" нь БҮХ брендийг өөрчилдөг
                тул зөвхөн brand горимд үлдээв. Захиалгын горимд бренд бүрийн
                толгой дээрх статусын товчийг ашиглана. */}
            {eff === "admin" && brandMode && (
              <div className="relative">
                <button
                  onClick={() => setShowStatusDropdown(v => !v)}
                  className="inline-flex h-9 items-center gap-1 rounded-lg border border-purple-200 bg-purple-50 px-3 text-xs font-medium text-purple-700 shadow-sm hover:bg-purple-100 active:bg-purple-200 transition-colors"
                >
                  Статус өөрчлөх
                  <ChevronDown size={12} />
                </button>
                {showStatusDropdown && (
                  <div ref={statusDropdownRef} className="absolute right-0 top-full mt-1 z-50 w-52 rounded-lg border border-gray-200 bg-white shadow-lg overflow-hidden">
                    {STATUS_SEQUENCE.map((st) => (
                      <button
                        key={st}
                        onClick={() => forceStatus(st)}
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors ${effectiveStatus === st ? "font-semibold text-[#0071E3] bg-blue-50" : "text-gray-700"}`}
                      >
                        {STATUS_LABEL[st as keyof typeof STATUS_LABEL]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {eff === "admin" && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-600 shadow-sm hover:bg-red-100 active:bg-red-200 transition-colors"
              >
                <Trash2 size={13} />
                Устгах
              </button>
            )}
            {/* Захиалгын горимд бүх брендийг нэг дор шилжүүлэхгүй — бренд
                бүрийн толгой дээр өөрийнх нь товч байна. Админд л багц
                үйлдэл: бренд бүрийг тусад нь дэвшүүлнэ (PO статус биш). */}
            {!brandMode && eff === "admin" && Object.keys(brandStatuses).length > 0 && (
              <button
                onClick={advanceAllBrands}
                disabled={advancing}
                title="Бренд бүрийг өөрийн статусаас нь нэг алхам урагшлуулна"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-indigo-200 bg-indigo-50 px-3 text-xs font-medium text-indigo-700 shadow-sm hover:bg-indigo-100 disabled:opacity-50 transition-colors"
              >
                {advancing ? <RefreshCw size={13} className="animate-spin"/> : <CheckCheck size={13}/>}
                Бүх бренд дэвшүүлэх
              </button>
            )}
            {brandMode && canAdvance() && (
              <button
                onClick={() => advanceStatus()}
                disabled={advancing}
                className="order-first inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#0071E3] px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-[#0064c8] active:bg-[#004aad] disabled:opacity-50 transition-colors sm:order-none sm:w-auto sm:py-1.5 sm:text-xs"
              >
                {advancing && <RefreshCw size={13} className="animate-spin" />}
                {advanceLabel()}
              </button>
            )}
          </div>
        </div>

        {/* Notes */}
        {order.notes && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0 text-amber-500" />
            <span><span className="font-semibold">Тэмдэглэл: </span>{order.notes}</span>
          </div>
        )}

        {/* Vehicle assignment хуучин dropdown устгагдсан — одоо Shipment системээр машин хуваарилна */}
      </div>

      {/* ── Status timeline ── */}
      <div className="mt-3 overflow-x-auto rounded-2xl bg-white px-5 py-4 shadow-sm ring-1 ring-gray-100">
        <div className="flex min-w-max items-center gap-0">
          {STATUS_SEQUENCE.map((s, i) => {
            const done = i < currentIdx;
            const current = i === currentIdx;
            const future = i > currentIdx;
            return (
              <div key={s} className="flex items-center">
                <div className="flex flex-col items-center gap-1.5 px-2">
                  <div className="relative flex items-center justify-center">
                    {current && (
                      <span className="absolute inline-flex h-8 w-8 animate-ping rounded-full bg-[#0071E3] opacity-20" />
                    )}
                    <div
                      className={`relative flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-all ${
                        done
                          ? "bg-emerald-500 text-white shadow-sm shadow-emerald-200"
                          : current
                          ? "bg-[#0071E3] text-white shadow-md shadow-blue-200"
                          : "bg-gray-100 text-gray-400"
                      }`}
                    >
                      {done ? <CheckCircle2 size={15} /> : current ? <span>{i + 1}</span> : <span className="text-gray-300">{i + 1}</span>}
                    </div>
                  </div>
                  <span
                    className={`max-w-[72px] text-center text-[9.5px] font-medium leading-tight whitespace-nowrap ${
                      done ? "text-emerald-600" : current ? "text-[#0071E3]" : "text-gray-400"
                    }`}
                  >
                    {STATUS_LABEL[s]}
                  </span>
                </div>
                {i < STATUS_SEQUENCE.length - 1 && (
                  <div className="mb-5 flex-shrink-0">
                    <div className={`h-0.5 w-8 rounded-full transition-all ${i < currentIdx ? "bg-emerald-400" : "bg-gray-150 bg-gray-200"}`} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Ачилтын самбар ──
          Ачилт БАЙВАЛ аль ч статуст харагдана (статус нь мэдээллийн шинжтэй).
          Ачилт байхгүй үед зөвхөн ачилтын үе шатанд харуулна — эс тэгвээс
          захиалга бэлдэж байхад хоосон самбар дэмий зай эзэлнэ. */}
      {order && (shipments.length > 0
        || ["loading", "transit", "arrived", "accounting", "confirmed", "received"].includes(effectiveStatus)) && (
        <div className="mt-3 space-y-3">
          {/* Shipment list */}
          <div className="rounded-2xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
            <div className="flex items-center justify-between border-b border-gray-100 bg-gray-50/60 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-gray-700">Ачилтууд</span>
                <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold text-blue-600">{shipments.length}</span>
              </div>
              {effectiveStatus === "loading" && shipments.length === 0 && (
                <span className="text-[10px] text-gray-400 italic">Dashboard-аас машин нэмнэ үү</span>
              )}
            </div>

            {shipments.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-400">
                {effectiveStatus === "loading" ? "Dashboard-аас машин нэмнэ үү" : "Ачилт байхгүй"}
              </div>
            ) : (
              <div className="divide-y divide-gray-50">
                {shipments.map((sh) => {
                  const isExpanded = expandedShipment === sh.id;
                  const canEdit = sh.status === "loading" && (eff === "admin" || eff === "supervisor" || eff === "manager");
                  const otherLoadingShipments = allShipments.filter(s => s.id !== sh.id && s.status === "loading");
                  return (
                  <div key={sh.id}>
                    {/* ── Shipment header (click to expand) ── */}
                    <div
                      className={`px-3 py-3 cursor-pointer transition-colors sm:px-4 ${isExpanded ? "bg-blue-50/40" : "hover:bg-gray-50/40"}`}
                      onClick={() => toggleShipmentDetail(sh.id)}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-50 text-blue-600 text-lg shrink-0">
                            {"\u{1F69A}"}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              {/* Machine selector (loading) or name display */}
                              {canEdit ? (
                                <select
                                  value={sh.vehicle_id ?? ""}
                                  onClick={(e) => e.stopPropagation()}
                                  onChange={async (e) => {
                                    e.stopPropagation();
                                    const vid = e.target.value ? parseInt(e.target.value) : null;
                                    try {
                                      await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}`, { vehicle_id: vid });
                                      await loadShipments();
                                    } catch (err: any) { flash(err?.response?.data?.detail ?? "Алдаа", false); }
                                  }}
                                  className="text-sm font-semibold text-gray-800 border border-gray-200 rounded-lg px-2 py-1 bg-white cursor-pointer"
                                >
                                  <option value="">Машин сонгох...</option>
                                  {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.plate})</option>)}
                                </select>
                              ) : (
                                <span className="text-sm font-semibold text-gray-800">
                                  {sh.vehicle_name || "Машингүй ачилт"}
                                </span>
                              )}
                              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                sh.status === "loading" ? "bg-amber-50 text-amber-600" :
                                sh.status === "transit" ? "bg-blue-50 text-blue-600" :
                                sh.status === "arrived" ? "bg-emerald-50 text-emerald-600" :
                                sh.status === "received" ? "bg-green-50 text-green-700" :
                                "bg-gray-100 text-gray-600"
                              }`}>
                                {sh.status_label}
                              </span>
                            </div>
                            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-gray-400">
                              <span>{sh.brand_count} брэнд</span>
                              <span>{sh.total_loaded_box} хайрцаг</span>
                              <span>{sh.total_weight.toLocaleString()} кг</span>
                            </div>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-end gap-1.5 sm:gap-2" onClick={(e) => e.stopPropagation()}>
                          {/* Advance buttons */}
                          {sh.status === "loading" && sh.line_count > 0 && (eff === "admin" || eff === "supervisor" || eff === "manager") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Замд гарлаа"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 active:bg-blue-700 transition-colors">Замд гаргах</button>
                          )}
                          {sh.status === "transit" && (eff === "admin" || eff === "supervisor" || eff === "warehouse_clerk") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Ачаа ирсэн"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 active:bg-emerald-700 transition-colors">Ирсэн</button>
                          )}
                          {sh.status === "arrived" && (eff === "admin" || eff === "supervisor" || eff === "warehouse_clerk") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Нягтлан руу шилжлээ"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-600 active:bg-violet-700 transition-colors">Нягтлан руу</button>
                          )}
                          {(sh.status === "accounting" || sh.status === "confirmed") && (eff === "admin" || eff === "accountant") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Статус шилжлээ"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-700 active:bg-green-800 transition-colors">{sh.status === "accounting" ? "Баталгаажуулах" : "Орлого авах"}</button>
                          )}
                          {sh.status === "loading" && (eff === "admin" || eff === "supervisor") && (
                            <button onClick={async () => { if (!confirm("Энэ ачилтыг устгах уу?")) return; try { await api.delete(`/purchase-orders/${order.id}/shipments/${sh.id}`); await loadShipments(); flash("Устгагдлаа"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg border border-red-200 px-2 py-1.5 text-xs text-red-500 hover:bg-red-50 transition-colors"><Trash2 size={12} /></button>
                          )}
                          {/* Expand arrow */}
                          {isExpanded ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
                        </div>
                      </div>

                      {/* Brands chips */}
                      {!isExpanded && sh.brands.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2 ml-12">
                          {sh.brands.map((b) => (
                            <span key={b} className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-600">{b}</span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* ── Expanded: shipment line details ── */}
                    {isExpanded && shipmentDetail?.id === sh.id && (
                      <div className="border-t border-gray-100 bg-gray-50/30">
                        {shipmentDetail.lines.length === 0 ? (
                          <div className="p-4 text-center text-xs text-gray-400">Бараа хуваарилагдаагүй</div>
                        ) : (
                          <div className="divide-y divide-gray-100">
                            {/* Group by brand */}
                            {(() => {
                              const byBrand: Record<string, typeof shipmentDetail.lines> = {};
                              for (const l of shipmentDetail.lines) {
                                if (!byBrand[l.brand]) byBrand[l.brand] = [];
                                byBrand[l.brand].push(l);
                              }
                              return Object.entries(byBrand).sort(([a], [b]) => a.localeCompare(b)).map(([brand, items]) => (
                                <div key={brand}>
                                  <div className="px-4 py-2 bg-gray-50 border-b border-gray-100">
                                    <span className="text-xs font-bold text-gray-600">{brand}</span>
                                    <span className="ml-2 text-[10px] text-gray-400">{items.length} бараа, {items.reduce((s, i) => s + i.loaded_qty_box, 0)} хайрцаг</span>
                                  </div>
                                  {items.map((line) => (
                                    <div key={line.id} className="flex items-center gap-2 px-4 py-2 text-xs hover:bg-white/60">
                                      <span className="w-16 shrink-0 font-mono text-gray-400">{line.item_code}</span>
                                      <span className="flex-1 min-w-0 truncate text-gray-700">{line.name}</span>
                                      <span className="shrink-0 font-semibold text-gray-800 w-16 text-right">{line.loaded_qty_box} хр</span>
                                      <span className="shrink-0 text-gray-400 w-16 text-right">{line.computed_weight.toFixed(1)} кг</span>
                                      {/* Move controls (loading only) */}
                                      {canEdit && (
                                        <div className="flex items-center gap-1 shrink-0 ml-2">
                                          <button
                                            onClick={() => moveLineToUnassigned(line.id)}
                                            title="Буцаах"
                                            className="rounded px-1.5 py-0.5 text-[10px] text-red-500 border border-red-200 hover:bg-red-50"
                                          >
                                            <X size={10} />
                                          </button>
                                          {otherLoadingShipments.length > 0 && (
                                            <select
                                              defaultValue=""
                                              onChange={(e) => {
                                                const targetId = parseInt(e.target.value);
                                                if (targetId) moveLineToShipment(line.id, targetId);
                                                e.target.value = "";
                                              }}
                                              className="rounded border border-gray-200 px-1 py-0.5 text-[10px] text-gray-600 bg-white cursor-pointer"
                                            >
                                              <option value="">Шилжүүлэх...</option>
                                              {otherLoadingShipments.map((s) => (
                                                <option key={s.id} value={s.id}>{s.vehicle_name || "Машингүй"}</option>
                                              ))}
                                            </select>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  ))}
                                </div>
                              ));
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Unassigned items — only in loading status */}
          {effectiveStatus === "loading" && unassignedLines.length > 0 && shipments.length > 0 && (
            <div className="rounded-2xl bg-white shadow-sm ring-1 ring-gray-100 overflow-hidden">
              <div className="border-b border-gray-100 bg-amber-50/50 px-4 py-3">
                <span className="text-sm font-bold text-amber-700">Хуваарилагдаагүй бараанууд</span>
                <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-600">{unassignedLines.length}</span>
              </div>
              <div className="divide-y divide-gray-50 max-h-[400px] overflow-y-auto">
                {(() => {
                  // Group by brand
                  const byBrand: Record<string, UnassignedLine[]> = {};
                  for (const ul of unassignedLines) {
                    if (!byBrand[ul.brand]) byBrand[ul.brand] = [];
                    byBrand[ul.brand].push(ul);
                  }
                  const loadingShipments = allShipments.filter(s => s.status === "loading");
                  return Object.entries(byBrand).sort(([a], [b]) => a.localeCompare(b)).map(([brand, items]) => (
                    <div key={brand} className="px-4 py-2.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-semibold text-gray-700">{brand}</span>
                          <span className="text-[10px] text-gray-400">{items.length} бараа, {items.reduce((s, i) => s + i.remaining_qty_box, 0)} хайрцаг</span>
                        </div>
                        {loadingShipments.length > 0 && (
                          <select
                            defaultValue=""
                            onChange={async (e) => {
                              const shipId = parseInt(e.target.value);
                              if (!shipId) return;
                              try {
                                await api.post(`/purchase-orders/${order.id}/shipments/${shipId}/assign-brand`, { brand });
                                await loadShipments();
                                flash(`${brand} → ачилтад нэмэгдлээ`);
                              } catch (err: any) { flash(err?.response?.data?.detail ?? "Алдаа", false); }
                              e.target.value = "";
                            }}
                            className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-medium text-blue-700 cursor-pointer"
                          >
                            <option value="">Ачилтад нэмэх...</option>
                            {loadingShipments.map((s) => (
                              <option key={s.id} value={s.id}>{s.vehicle_name || `Ачилт #${s.id}`}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    </div>
                  ));
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Product table ── */}
      <div className={`mt-3 rounded-2xl bg-white shadow-sm ring-1 ring-gray-100 ${showColMenu ? "" : "overflow-hidden"}`}>

        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-gray-100 bg-gray-50/60 px-3 py-2.5 sm:gap-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 shadow-sm">
            <select
              value={filterBrand}
              onChange={(e) => {
                setFilterBrand(e.target.value);
                // брэнд солигдоход одоогийн агуулах тохирохгүй бол цэвэрлэнэ
                if (filterWarehouse) {
                  const newWarehouses = [...new Set(
                    baseLines
                      .filter((l) => !e.target.value || l.brand === e.target.value)
                      .map((l) => l.warehouse_name)
                  )].filter((w) => w && w !== "nan");
                  if (!newWarehouses.includes(filterWarehouse)) setFilterWarehouse("");
                }
              }}
              className="bg-transparent text-xs text-gray-700 outline-none cursor-pointer"
            >
              <option value="">Бренд: бүгд</option>
              {brands.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 shadow-sm">
            <select
              value={filterWarehouse}
              onChange={(e) => {
                setFilterWarehouse(e.target.value);
                // агуулах солигдоход одоогийн брэнд тохирохгүй бол цэвэрлэнэ
                if (filterBrand) {
                  const newBrands = [...new Set(
                    baseLines
                      .filter((l) => !e.target.value || l.warehouse_name === e.target.value)
                      .map((l) => l.brand)
                  )];
                  if (!newBrands.includes(filterBrand)) setFilterBrand("");
                }
              }}
              className="bg-transparent text-xs text-gray-700 outline-none cursor-pointer"
            >
              <option value="">Агуулах: бүгд</option>
              {warehouses.map((w) => <option key={w} value={w}>{w}</option>)}
            </select>
          </div>

          {/* Text search */}
          <div className="flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 shadow-sm">
            <Search size={12} className="shrink-0 text-gray-400" />
            <input
              type="text"
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Код / нэр хайх..."
              className="w-32 bg-transparent text-xs text-gray-700 outline-none placeholder:text-gray-400 sm:w-44"
            />
            {filterSearch && (
              <button onClick={() => setFilterSearch("")} className="text-gray-300 hover:text-gray-500">
                <X size={11} />
              </button>
            )}
          </div>

          {/* Зөвхөн захиалсан toggle */}
          {isEnteringQty && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 shadow-sm hover:bg-blue-50 transition-colors">
              <input
                type="checkbox"
                checked={onlyOrdered}
                onChange={(e) => setOnlyOrdered(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-gray-300 text-[#0071E3] accent-[#0071E3]"
              />
              <span className="text-xs font-medium text-gray-600">Зөвхөн захиалсан</span>
            </label>
          )}

          {/* Захиалах ёстой бараа (min-stock rule-д тохирсон, хүрэлцээгүй) */}
          {reorderCount > 0 && (
            <label className="flex items-center gap-1.5 cursor-pointer select-none rounded-lg border border-red-200 bg-red-50/60 px-2.5 py-1.5 shadow-sm hover:bg-red-100 transition-colors">
              <input
                type="checkbox"
                checked={onlyReorder}
                onChange={(e) => setOnlyReorder(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-red-300 text-red-600 accent-red-600"
              />
              <span className="text-xs font-medium text-red-700">Захиалах ёстой бараа</span>
              <span className="rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white tabular-nums">
                {reorderCount}
              </span>
            </label>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-500">
              {filteredLines.length} бараа
            </span>
            {/* Ороогүй бараа захиалах — консолыг нээх ГОЛ цэг.
                Өмнө нь энэ нь дарагддаггүй тэмдэг байсан бөгөөд "брендийн
                толгой дээрх тэмдгийг ол" гэж заадаг байв. Гэтэл захиалсан
                мөргүй бренд нь толгой ҮҮСГЭДЭГГҮЙ тул 471 брендийн дийлэнх
                нь хүрэх аргагүй байлаа. */}
            {(brandMode ? (unordCounts[brandFilter!] ?? 0) : unordTotal) > 0 && (
              <button
                onClick={() => openUnordPanel(brandMode ? brandFilter : undefined)}
                title="Захиалгад ороогүй барааг код/нэрээр хайж, тоо оруулаад нэг дор нэмнэ (Ctrl+K)"
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200 transition-colors hover:bg-amber-100"
              >
                <Plus size={13} />
                Ороогүй бараа захиалах
                <span className="rounded-full bg-amber-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                  {(brandMode ? (unordCounts[brandFilter!] ?? 0) : unordTotal).toLocaleString("mn-MN")}
                </span>
                {unordCartIds.length > 0 && (
                  <span className="rounded-full bg-emerald-600 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                    {unordCartIds.length} сагсанд
                  </span>
                )}
                <kbd className="hidden rounded border border-amber-300 px-1 text-[9px] font-medium text-amber-600 lg:inline">Ctrl K</kbd>
              </button>
            )}

            {/* Багана сонгох — өгөгдмөлөөр бүгд асаалттай */}
            <div className="relative">
              <button
                onClick={() => setShowColMenu((v) => !v)}
                aria-expanded={showColMenu}
                aria-haspopup="true"
                className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-600 shadow-sm transition-colors hover:bg-gray-50"
                title="Харагдах багануудыг сонгох"
              >
                <Columns3 size={13} />
                Багана
                {hiddenColCount > 0 && (
                  <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-700 tabular-nums">
                    {hiddenColCount}
                  </span>
                )}
                <ChevronDown size={11} className={showColMenu ? "rotate-180 transition-transform" : "transition-transform"} />
              </button>
              {showColMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowColMenu(false)} />
                  <div className="absolute right-0 z-20 mt-1 w-60 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg">
                    <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
                      <span className="text-xs font-semibold text-gray-700">Харагдах багана</span>
                      <button
                        onClick={() => setCols(Object.fromEntries(COLUMN_GROUPS.map((g) => [g.key, true])) as Record<ColKey, boolean>)}
                        className="text-[11px] font-medium text-[#0071E3] hover:underline"
                      >
                        Бүгдийг
                      </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto py-1">
                      {COLUMN_GROUPS.map((g) => {
                        // Энэ үе шатанд бөглөх шаардлагатай багана — нуухыг хориглоно.
                        const forced = !!forcedCols[g.key];
                        // "Үнэ зөрүү" нь үнийн блокийн дотор зурагддаг тул
                        // үнэ унтарсан үед сонгох нь утгагүй.
                        const blocked = g.key === "priceDiff" && !showPriceCols;
                        return (
                          <label
                            key={g.key}
                            className={`flex select-none items-center gap-2 px-3 py-1.5 ${forced ? "cursor-default bg-amber-50/40" : blocked ? "cursor-default opacity-50" : "cursor-pointer hover:bg-gray-50"}`}
                            title={forced ? "Энэ үе шатанд бөглөх шаардлагатай тул нуух боломжгүй"
                                 : blocked ? "«Үнэ · Нийт дүн» асаалттай үед л харагдана" : undefined}
                          >
                            <input
                              type="checkbox"
                              checked={colVisible[g.key]}
                              disabled={forced || blocked}
                              onChange={(e) => setCols((p) => ({ ...p, [g.key]: e.target.checked }))}
                              className="h-3.5 w-3.5 rounded border-gray-300 accent-[#0071E3] disabled:opacity-60"
                            />
                            <span className={`flex-1 text-xs ${forced ? "text-gray-500" : "text-gray-700"}`}>{g.label}</span>
                            {forced
                              ? <span className="text-[9px] font-semibold text-amber-600">заавал</span>
                              : <span className="text-[10px] text-gray-300 tabular-nums">{g.span}</span>}
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </>
              )}
            </div>

            {(effectiveStatus === "preparing" || effectiveStatus === "loading") &&
              (eff === "manager" || eff === "admin" || eff === "supervisor") && (
              <button
                onClick={() => { setShowAddModal(true); setAddSearch(""); setAddResults([]); }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#0064c8] transition-colors"
              >
                <Plus size={13} />
                Бараа нэмэх
              </button>
            )}
            <button
              onClick={loadOrder}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs text-gray-500 shadow-sm hover:bg-gray-50 transition-colors"
              title="Шинэчлэх"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
          </div>
        </div>

        {/* Table content */}
        {order.lines.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-gray-100">
              <Package size={20} className="text-gray-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-600">Бараа байхгүй байна</p>
              <p className="mt-1 text-xs text-gray-400">Админ → "Барааны жагсаалт шинэчлэх" дарж master-аас бараа оруулна уу.</p>
            </div>
          </div>
        ) : needsFilter ? (
          <div className="flex flex-col items-center gap-3 py-16">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-amber-50">
              <Search size={20} className="text-amber-400" />
            </div>
            <div className="text-center">
              <p className="text-sm font-semibold text-gray-700">{filteredLines.length} бараа байна</p>
              <p className="mt-1 text-xs text-gray-400">Бренд эсвэл агуулах сонгох, эсвэл код/нэрээр хайна уу</p>
            </div>
          </div>
        ) : filteredLines.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-14">
            <Search size={18} className="text-gray-300" />
            <p className="text-sm text-gray-400">Захиалсан бараа байхгүй байна.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50/40 text-left">
                  <th className="hidden px-4 py-2.5 text-xs font-semibold text-gray-500 md:table-cell">Агуулах</th>
                  <th className="hidden px-4 py-2.5 text-xs font-semibold text-gray-500 md:table-cell">Код</th>
                  <th className="px-2 py-2.5 text-xs font-semibold text-gray-500 md:px-4">Нэр</th>
                  {showStockCols && (
                    <>
                      <th className="px-2 py-2.5 text-right text-xs font-semibold text-gray-500 md:px-4">
                        Нөөц <span className="font-normal text-gray-400">· {((order as any).location === "showroom") ? "Заал" : "Агуулах"}</span>
                      </th>
                      <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Хайрцагны тоо</th>
                    </>
                  )}
                  {showUnitWeightCols && (
                    <>
                      <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Нэгж жин</th>
                      <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Хайрцаг/ш</th>
                    </>
                  )}
                  {showOrderCol && (
                    <th className="w-20 px-2 py-2.5 text-right text-xs font-semibold text-gray-500 md:w-28 md:px-4">
                      {stageArrived ? "Захиалсан" : "Захиалах"}
                    </th>
                  )}
                  {showSalesStatsCols && (
                    <>
                      <th className="hidden px-3 py-2.5 text-right text-xs font-semibold text-blue-600 md:table-cell" title="Сүүлийн 12 сарын дундаж борлуулалт">12с дунд.</th>
                      <th className="hidden px-3 py-2.5 text-right text-xs font-semibold text-blue-700 md:table-cell" title="Сүүлийн 3 сарын дундаж борлуулалт">3с дунд.</th>
                      <th className="hidden px-3 py-2.5 text-right text-xs font-semibold text-emerald-600 md:table-cell" title="Сүүлийн сарын борлуулалт">Сүүлийн сар</th>
                      <th className="hidden px-3 py-2.5 text-right text-xs font-semibold text-amber-600 md:table-cell" title="Өмнөх оны сонгосон сарын борлуулалт">Өмнөх оны {(order as any).stat_month ? `${(order as any).stat_month}-р сар` : "энэ сард"}</th>
                    </>
                  )}
                  {showEstCostCols && (
                    <>
                      <th className="hidden w-28 px-4 py-2.5 text-right text-xs font-semibold text-indigo-500 md:table-cell">Нэгж үнэ</th>
                      <th className="hidden w-32 px-4 py-2.5 text-right text-xs font-semibold text-indigo-600 md:table-cell">Тооцоолсон дүн</th>
                    </>
                  )}
                  {/* Ачигдсан: өмнө нь loading/transit/arrived гурван статуст
                      тус тусдаа гурван багана байсныг НЭГ болгов — гурвуулаа
                      ижил өгөгдөл (loaded_qty_box) харуулдаг байсан. */}
                  {showLoadedCol && (
                    <th className="w-20 px-2 py-2.5 text-right text-xs font-semibold text-orange-500 md:w-28 md:px-4">
                      <div className="flex items-center justify-end gap-1.5">
                        {canEditLoaded && (
                          <input
                            type="checkbox"
                            checked={loadedAll}
                            onChange={(e) => fillLoadedFromOrdered(e.target.checked)}
                            title="Харагдаж буй бүх мөрийг захиалсан тоогоор бөглөх"
                            className="h-3.5 w-3.5 cursor-pointer rounded border-orange-300 accent-orange-500"
                          />
                        )}
                        Ачигдсан
                      </div>
                    </th>
                  )}
                  {showReceivedCols && (
                    <>
                      <th className="w-40 px-2 py-2.5 text-right text-xs font-semibold text-teal-600 md:px-4">
                        <div className="flex items-center justify-end gap-1.5">
                          {canEditReceivedStage && (
                            <input
                              type="checkbox"
                              checked={receivedAll}
                              onChange={(e) => fillReceivedFromOrdered(e.target.checked)}
                              title="Харагдаж буй бүх мөрийг захиалсан тоогоор бөглөх"
                              className="h-3.5 w-3.5 cursor-pointer rounded border-teal-300 accent-teal-600"
                            />
                          )}
                          Ирсэн (х × ш)
                        </div>
                      </th>
                      <th className="hidden w-24 px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Зөрүү</th>
                      <th className="hidden px-4 py-2.5 text-left text-xs font-semibold text-gray-500 md:table-cell">Тайлбар</th>
                    </>
                  )}
                  {showPriceCols && (
                    <>
                      <th className="hidden w-28 px-4 py-2.5 text-right text-xs font-semibold text-teal-600 md:table-cell">Нийт ширхэг</th>
                      <th className="w-24 px-2 py-2.5 text-right text-xs font-semibold text-purple-600 md:w-32 md:px-4">Нэгж үнэ</th>
                      <th className="hidden w-32 px-4 py-2.5 text-right text-xs font-semibold text-purple-700 md:table-cell">Нийт дүн</th>
                      {showPriceDiff && (
                        <th className="hidden w-28 px-4 py-2.5 text-right text-xs font-semibold text-orange-500 md:table-cell">Үнэ зөрүү</th>
                      )}
                    </>
                  )}
                  {showVehicleCol && (
                    <th className="hidden px-4 py-2.5 text-xs font-semibold text-sky-600 md:table-cell">Машин</th>
                  )}
                  <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Жин (кг)</th>
                  {/* Мөр устгах товчны багана — хамгийн сүүлд */}
                  {showRowActions && <th className="w-8 px-2 py-2.5" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {Object.entries(grouped).map(([brand, lines]) => {
                  const brandExtraLines = (order.extra_lines ?? []).filter(el => el.brand === brand);
                  const brandTotalBoxes = lines.reduce((s, l) => s + (store.quantities[l.product_id] ?? l.order_qty_box ?? 0), 0)
                    + brandExtraLines.reduce((s, el) => s + el.qty_box, 0);
                  const brandTotalWeight = lines.reduce((s, l) => {
                    const qty = store.quantities[l.product_id] ?? l.order_qty_box ?? 0;
                    return s + qty * (l.pack_ratio ?? 1) * (l.unit_weight ?? 0);
                  }, 0) + brandExtraLines.reduce((s, el) => s + el.computed_weight, 0);
                  return (
                  <Fragment key={brand}>
                    {/* Brand group header */}
                    <tr className="bg-slate-50">
                      <td colSpan={colCount} className="px-2 py-2 md:px-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <div className="h-3 w-0.5 rounded-full bg-[#0071E3]" />
                          <span className="text-xs font-bold uppercase tracking-wider text-slate-600">{brand}</span>
                          <span className="rounded-md bg-slate-200/70 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                            {lines.length} бараа
                          </span>
                          {/* Брендийн СТАТУС — захиалга биш, бренд бүр өөрийн
                              статустай явна. Статусын мөр нь захиалга өгсөн
                              брендэд л үүсдэг тул байхгүй бол харуулахгүй. */}
                          {/* Захиалгатай бренд бүрд удирдлага гарна. Статусын
                              мөр байхгүй бол сервер эхний үйлдэл дээр өөрөө
                              үүсгэнэ — өмнө нь ийм бренд мөнхөд гацдаг байв. */}
                          {!brandMode && (brandStatuses[brand] || brandTotalBoxes > 0) && (() => {
                            const bst = brandStatuses[brand] ?? order.status;
                            return (
                            <span className="flex items-center gap-1">
                              <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_COLOR[bst] ?? "bg-gray-100 text-gray-600"}`}>
                                {STATUS_LABEL[bst] ?? bst}
                              </span>
                              {canAdvanceBrand(bst) && (
                                <button
                                  onClick={() => advanceBrand(brand)}
                                  disabled={brandBusy === brand}
                                  title={`${brand} — дараагийн үе шат руу шилжүүлэх`}
                                  className="inline-flex items-center gap-0.5 rounded-md bg-[#0071E3] px-1.5 py-0.5 text-[10px] font-semibold text-white hover:bg-[#0064c8] disabled:opacity-50"
                                >
                                  {brandBusy === brand
                                    ? <RefreshCw size={9} className="animate-spin" />
                                    : <>→ {STATUS_LABEL[STATUS_SEQUENCE[STATUS_SEQUENCE.indexOf(bst as any) + 1]] ?? "Дэвшүүлэх"}</>}
                                </button>
                              )}
                              {eff === "admin" && (
                                <span className="relative" ref={brandMenu === brand ? brandMenuRef : null}>
                                  <button
                                    onClick={() => setBrandMenu(brandMenu === brand ? null : brand)}
                                    title={`${brand} — статус албадан өөрчлөх`}
                                    className="rounded-md border border-purple-200 bg-purple-50 px-1 py-0.5 text-[10px] font-semibold text-purple-700 hover:bg-purple-100"
                                  >
                                    <ChevronDown size={10} />
                                  </button>
                                  {brandMenu === brand && (
                                    <span className="absolute left-0 z-20 mt-1 block w-48 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
                                      {STATUS_SEQUENCE.map((s) => (
                                        <button
                                          key={s}
                                          onClick={() => forceBrandStatus(brand, s)}
                                          disabled={brandBusy === brand}
                                          className={`block w-full px-3 py-1.5 text-left text-[11px] hover:bg-gray-50 disabled:opacity-50 ${
                                            bst === s ? "bg-blue-50 font-semibold text-[#0071E3]" : "text-gray-700"
                                          }`}
                                        >
                                          {STATUS_LABEL[s]}
                                        </button>
                                      ))}
                                    </span>
                                  )}
                                </span>
                              )}
                            </span>
                            );
                          })()}
                          {/* Захиалгад ороогүй бараа — консолыг ЭНЭ брендээр шүүж нээнэ */}
                          {(unordCounts[brand] ?? 0) > 0 && (
                            <button
                              onClick={() => openUnordPanel(brand)}
                              className="flex items-center gap-1 rounded-md bg-amber-50 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-200 transition-colors hover:bg-amber-100"
                              title={`${brand} — ороогүй ${unordCounts[brand]} барааг захиалах`}
                            >
                              <Plus size={10}/>
                              {unordCounts[brand].toLocaleString("mn-MN")} захиалаагүй
                            </button>
                          )}
                          {brandTotalBoxes > 0 && (
                            <>
                              <span className="rounded-md bg-blue-50 px-1.5 py-0.5 text-[10px] font-semibold text-blue-600">
                                {brandTotalBoxes.toFixed(0)} хайрцаг
                              </span>
                              <span className="hidden rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 sm:inline-block">
                                {brandTotalWeight.toFixed(1)} кг
                              </span>
                            </>
                          )}
                          {effectiveStatus === "loading" && (eff === "manager" || eff === "admin" || eff === "supervisor") && (
                            <button
                              onClick={() => openAddExtra(brand)}
                              className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-amber-600 hover:bg-amber-50 transition-colors"
                            >
                              <Plus size={10} /> Нэмэлт мөр
                            </button>
                          )}
                          {eff === "admin" && (effectiveStatus === "preparing" || effectiveStatus === "loading") && (
                            <button
                              onClick={() => openCrossBrand(brand)}
                              className={`${effectiveStatus === "loading" && (eff === "admin") ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-md border border-violet-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-violet-600 hover:bg-violet-50 transition-colors`}
                              title="Бусад брендээс нэг удаагийн бараа нэмэх (зөвхөн админ)"
                            >
                              <Plus size={10} /> Бусад брендээс
                            </button>
                          )}
                          {effectiveStatus === "loading" && (
                            <select
                              value={brandVehicles[brand] ?? ""}
                              onChange={async (e) => {
                                const vid = e.target.value ? parseInt(e.target.value) : null;
                                setBrandVehicles((prev) => ({ ...prev, [brand]: vid }));
                                if (vid && order) {
                                  try {
                                    const targetShip = allShipments.find((s) => s.vehicle_id === vid && s.status === "loading");
                                    if (!targetShip) {
                                      flash("Тухайн машин Dashboard-д нэмэгдээгүй байна", false);
                                      return;
                                    }
                                    // 1) Одоо өөр shipment-д байгаа brand-ийн бүх line-уудыг target руу шилжүүлэх
                                    const brandProductIds = new Set(lines.map((ln) => ln.product_id));
                                    const movePromises: Promise<any>[] = [];
                                    for (const pid of brandProductIds) {
                                      const current = productShipmentMap[pid] ?? [];
                                      for (const s of current) {
                                        if (s.shipment_id !== targetShip.id) {
                                          movePromises.push(
                                            api.post(`/purchase-orders/${order.id}/shipments/move-line`, {
                                              shipment_line_id: s.shipment_line_id,
                                              target_shipment_id: targetShip.id,
                                            })
                                          );
                                        }
                                      }
                                    }
                                    if (movePromises.length > 0) {
                                      await Promise.all(movePromises);
                                    }
                                    // 2) Хуваарилагдаагүй барааг assign хийх
                                    await api.post(`/purchase-orders/${order.id}/shipments/${targetShip.id}/assign-brand`, { brand });
                                    await loadShipments();
                                    flash(`${brand} → ${targetShip.vehicle_name} рүү шилжлээ`);
                                  } catch (err: any) {
                                    flash(err?.response?.data?.detail ?? "Алдаа", false);
                                  }
                                }
                              }}
                              className="ml-1 rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700 outline-none shadow-sm focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                            >
                              <option value="">🚛 Машин сонгох (бүх бараа)</option>
                              {allShipments
                                .filter((s) => s.status === "loading" && s.vehicle_id)
                                .map((s) => (
                                  <option key={s.id} value={s.vehicle_id!}>
                                    {s.vehicle_name}
                                  </option>
                                ))}
                            </select>
                          )}
                          {effectiveStatus !== "loading" && (() => {
                            const bvInfo = order.brand_vehicles?.find((b) => b.brand === brand);
                            return bvInfo?.vehicle_name ? (
                              <span className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-600">
                                <Truck size={11} />
                                {bvInfo.vehicle_name}
                              </span>
                            ) : null;
                          })()}
                        </div>
                      </td>
                    </tr>

                    {/* Product rows */}
                    {lines.map((l) => {
                      const qBox = store.quantities[l.product_id] ?? l.order_qty_box;
                      const rowWeight = qBox * l.pack_ratio * l.unit_weight;
                      const hasQty = qBox > 0;
                      return (
                        <tr
                          key={l.product_id}
                          className={`group transition-colors ${
                            hasQty ? "bg-blue-50/40 hover:bg-blue-50/70" : "hover:bg-gray-50"
                          }`}
                        >
                          <td className="hidden px-4 py-2.5 md:table-cell">
                            {l.warehouse_name && l.warehouse_name !== "nan" ? (
                              <span className="whitespace-nowrap text-[11px] text-gray-400">
                                {l.warehouse_name}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="hidden px-4 py-2.5 md:table-cell">
                            <span className="font-mono text-[11px] text-gray-400">{l.item_code}</span>
                          </td>
                          <td className="min-w-[140px] px-2 py-2 md:min-w-[180px] md:px-4 md:py-2.5">
                            <div className="flex items-start gap-1.5">
                              <span className="block whitespace-normal break-words text-xs font-medium text-gray-800">{l.name}</span>
                              {(l as any).override_brand && (l as any).original_brand && (
                                <span
                                  title={`Оригинал бренд: ${(l as any).original_brand} (онцгой тохиолдол)`}
                                  className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[9px] font-semibold text-violet-700 whitespace-nowrap"
                                >
                                  ← {(l as any).original_brand}
                                </span>
                              )}
                              {(l as any).needs_reorder && (() => {
                                const box = (l as any).stock_box ?? 0;
                                const extra = (l as any).stock_extra_pcs ?? 0;
                                const min = (l as any).min_stock_box ?? 0;
                                const breakdown = `${box} хайрцаг${extra > 0 ? `, ${extra}ш` : ""}`;
                                return (
                                  <span
                                    title={`Үлдэгдэл ${(l.stock_qty ?? 0).toFixed(0)}ш (${breakdown}) < Min ${min} хайрцаг → захиалах ёстой`}
                                    className="shrink-0 rounded-full border border-red-200 bg-red-50 px-1.5 py-0.5 text-[9px] font-semibold text-red-600 whitespace-nowrap"
                                  >
                                    Захиалах · {box}/{min}
                                  </span>
                                );
                              })()}
                            </div>
                          </td>
                          {showStockCols && (() => {
                            const box = (l as any).stock_box ?? 0;
                            const extra = (l as any).stock_extra_pcs ?? 0;
                            const pcs = l.stock_qty ?? 0;
                            return (
                            <>
                              <td className="px-2 py-2 text-right text-xs tabular-nums text-gray-500 md:px-4 md:py-2.5">
                                <div className="font-medium text-gray-700">{pcs.toFixed(0)}ш</div>
                                {box > 0 && (
                                  <div className="text-[10px] text-gray-400">
                                    {box}х{extra > 0 ? `, ${extra}ш` : ""}
                                  </div>
                                )}
                              </td>
                              <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.pack_ratio}</td>
                            </>
                            );
                          })()}
                          {showUnitWeightCols && (
                            <>
                              <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.unit_weight.toFixed(3)}</td>
                              <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.pack_ratio}</td>
                            </>
                          )}
                          {showOrderCol && (
                            <td className="px-2 py-2 text-right md:px-4">
                              {/* Ачаа ирснээс хойш захиалсан тоо гацна — багана
                                  харагдана ч зөвхөн уншина. */}
                              {canEdit && !stageArrived ? (
                                <input
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={qBox === 0 ? "" : qBox}
                                  placeholder="0"
                                  onWheel={(e) => e.currentTarget.blur()}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    store.setQuantity(l.product_id, isNaN(v) ? 0 : v);
                                  }}
                                  className="w-16 rounded-lg border border-gray-200 bg-white px-2 py-2 text-right text-base font-medium tabular-nums outline-none shadow-sm transition focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 md:w-20 md:py-1.5 md:text-xs"
                                />
                              ) : (
                                <span className={`text-xs font-semibold tabular-nums ${hasQty ? "text-[#0071E3]" : "text-gray-300"}`}>
                                  {qBox.toFixed(0)}
                                </span>
                              )}
                            </td>
                          )}

                          {/* Sales stats (preparing/reviewing): 12с дунд / 3с дунд / Сүүлийн сар / Өмнөх он */}
                          {showSalesStatsCols && (() => {
                            const ss = salesStats[l.item_code];
                            const pack = (l.pack_ratio && l.pack_ratio > 0) ? l.pack_ratio : 1;
                            // Хайрцаг руу хөрвүүлж харуулна: үндсэн нь хайрцаг (Nх Mш),
                            // доор жижгээр нийт борлуулалтын ширхэг.
                            // Тоо байхгүй үед: файл орсон бол "0" (борлуулалтгүй),
                            // эс бол "—" (борлуулалтын файл оруулаагүй) гэж ялгана.
                            const fmtBox = (n: number | undefined, imported: boolean | undefined) => {
                              if (n && n > 0) {
                                const total = Math.round(n);
                                const boxes = Math.floor(total / pack);
                                const extra = total - boxes * pack;
                                if (boxes <= 0) return <div className="font-medium">{total}ш</div>;
                                return (
                                  <>
                                    <div className="font-medium">{boxes}х{extra > 0 ? ` ${extra}ш` : ""}</div>
                                    <div className="text-[10px] font-normal text-gray-400">{total.toLocaleString("mn-MN")}ш</div>
                                  </>
                                );
                              }
                              if (imported) return <span className="font-medium text-gray-400" title="Файл орсон — энэ бараа борлуулалтгүй">0</span>;
                              return <span className="text-gray-300" title="Энэ хугацааны борлуулалтын файл оруулаагүй">—</span>;
                            };
                            return (
                              <>
                                <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-blue-700 md:table-cell"
                                    title={ss && ss.data_months_12m < 12 ? `${ss.data_months_12m} сард дата орсон` : undefined}>
                                  {fmtBox(ss?.avg_12m, salesMeta.has_data_12m)}
                                </td>
                                <td className="hidden px-3 py-2.5 text-right text-xs font-semibold tabular-nums text-blue-800 md:table-cell">{fmtBox(ss?.avg_3m, salesMeta.has_data_3m)}</td>
                                <td className="hidden px-3 py-2.5 text-right text-xs font-semibold tabular-nums text-emerald-700 md:table-cell">{fmtBox(ss?.last_month, salesMeta.has_data_last_month)}</td>
                                <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-amber-700 md:table-cell">{fmtBox(ss?.same_month_prev_year, salesMeta.has_data_prev_year)}</td>
                              </>
                            );
                          })()}

                          {/* Estimated cost (preparing/sending) */}
                          {showEstCostCols && (() => {
                            const lpp = l.last_purchase_price ?? 0;
                            const estCost = lpp * qBox;
                            return (
                              <>
                                <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-indigo-500 md:table-cell">
                                  {lpp > 0 ? lpp.toLocaleString() : <span className="text-gray-300">—</span>}
                                </td>
                                <td className="hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums text-indigo-600 md:table-cell">
                                  {lpp > 0 && qBox > 0 ? estCost.toLocaleString() : <span className="text-gray-300">—</span>}
                                </td>
                              </>
                            );
                          })()}

                          {/* Ачигдсан — нэг багана. Ачилтын үе шатанд эрх бүхий
                              хэрэглэгч засна, бусад үед зөвхөн уншина. */}
                          {showLoadedCol && (
                            <td className="px-2 py-2 text-right md:px-4">
                              {canEditLoaded ? (
                                <input
                                  type="number" min={0} step={1}
                                  value={loadedQtys[l.product_id] === 0 ? "" : (loadedQtys[l.product_id] ?? "")}
                                  placeholder="0"
                                  onWheel={(e) => e.currentTarget.blur()}
                                  onChange={(e) => {
                                    const v = parseFloat(e.target.value);
                                    setLoadedQtys((prev) => ({ ...prev, [l.product_id]: isNaN(v) ? 0 : v }));
                                  }}
                                  className="w-16 rounded-lg border border-orange-200 bg-orange-50/50 px-2 py-2 text-right text-base font-medium tabular-nums outline-none shadow-sm transition focus:border-orange-400 focus:ring-2 focus:ring-orange-200 md:w-20 md:py-1.5 md:text-xs"
                                />
                              ) : (
                                <span className="text-xs font-semibold tabular-nums text-orange-600">
                                  {(l.loaded_qty_box ?? 0) > 0
                                    ? (l.loaded_qty_box ?? 0).toFixed(0)
                                    : <span className="font-normal text-gray-300">—</span>}
                                </span>
                              )}
                            </td>
                          )}

                          {/* Arrived+: loaded / received / diff */}
                          {showReceivedCols && (() => {
                            const loaded = l.loaded_qty_box ?? 0;
                            const received = receivedQtys[l.product_id] ?? l.received_qty_box ?? 0;
                            const extraPcs = receivedExtraPcs[l.product_id] ?? l.received_qty_extra_pcs ?? 0;
                            const packRatio = l.pack_ratio || 1;
                            // Diff-ийг ширхэгийн нарийвчлалтайгаар бодно
                            const loadedPcs = loaded * packRatio;
                            const receivedPcs = received * packRatio + extraPcs;
                            const diffPcs = loadedPcs - receivedPcs;
                            const canEditReceived = canEditReceivedStage;
                            return (
                              <>
                                {/* "Ачигдсан" энд байсныг дээрх нэгтгэсэн багана
                                    руу зөөв — давхардахгүйн тулд. */}
                                <td className="px-2 py-2 text-right md:px-4">
                                  {canEditReceived ? (
                                    <div className="flex items-center justify-end gap-1">
                                      <input
                                        type="number" min={0} step={1}
                                        value={receivedQtys[l.product_id] === 0 ? "" : (receivedQtys[l.product_id] ?? "")}
                                        placeholder="0"
                                        onWheel={(e) => e.currentTarget.blur()}
                                        onChange={(e) => {
                                          const v = parseFloat(e.target.value);
                                          setReceivedQtys((prev) => ({ ...prev, [l.product_id]: isNaN(v) ? 0 : v }));
                                        }}
                                        title="Хайрцаг"
                                        className="w-14 rounded-lg border border-teal-200 bg-teal-50/50 px-1.5 py-2 text-right text-base font-medium tabular-nums outline-none shadow-sm transition focus:border-teal-400 focus:ring-2 focus:ring-teal-200 md:w-16 md:py-1.5 md:text-xs"
                                      />
                                      <span className="text-[10px] text-gray-400">х</span>
                                      <input
                                        type="number" min={0} step={1}
                                        value={receivedExtraPcs[l.product_id] ? receivedExtraPcs[l.product_id] : ""}
                                        placeholder="0"
                                        onWheel={(e) => e.currentTarget.blur()}
                                        onChange={(e) => {
                                          const v = parseFloat(e.target.value);
                                          setReceivedExtraPcs((prev) => ({ ...prev, [l.product_id]: isNaN(v) ? 0 : v }));
                                        }}
                                        title="Задгай ширхэг"
                                        className="w-12 rounded-lg border border-amber-200 bg-amber-50/50 px-1.5 py-2 text-right text-base font-medium tabular-nums outline-none shadow-sm transition focus:border-amber-400 focus:ring-2 focus:ring-amber-200 md:w-14 md:py-1.5 md:text-xs"
                                      />
                                      <span className="text-[10px] text-gray-400">ш</span>
                                    </div>
                                  ) : (
                                    <span className="text-xs font-medium tabular-nums text-teal-700">
                                      {received.toFixed(0)}
                                      {extraPcs > 0 && <span className="ml-1 text-amber-600">+ {extraPcs.toFixed(0)}ш</span>}
                                    </span>
                                  )}
                                </td>
                                <td className="hidden px-4 py-2.5 text-right md:table-cell">
                                  {Math.abs(diffPcs) > 0.01 ? (
                                    <span className="inline-flex flex-col items-end text-xs font-bold tabular-nums text-red-500">
                                      <span>{diffPcs > 0 ? "+" : ""}{diffPcs.toFixed(0)}ш</span>
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-300">—</span>
                                  )}
                                </td>
                                <td className="hidden px-4 py-2 md:table-cell">
                                  <div className="flex items-center gap-1.5">
                                    {Math.abs(diffPcs) > 0.01 ? (
                                      canEditReceived ? (
                                        <input
                                          type="text"
                                          placeholder="Тайлбар бичих..."
                                          value={remarkInputs[l.product_id] ?? ""}
                                          onChange={(e) => setRemarkInputs((prev) => ({ ...prev, [l.product_id]: e.target.value }))}
                                          className="w-full min-w-[140px] rounded-lg border border-orange-200 bg-orange-50/50 px-2 py-1.5 text-xs outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-200"
                                        />
                                      ) : (
                                        <span className="text-xs italic text-gray-400">{l.remark || "—"}</span>
                                      )
                                    ) : (
                                      <span className="flex-1 text-xs text-gray-200">—</span>
                                    )}
                                    {canEditReceived && (
                                      <button
                                        onClick={() => deleteLine(l.line_id, `"${l.name}" барааг устгахдаа итгэлтэй байна уу?`)}
                                        className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                                        title="Ирээгүй барааг устгах"
                                      >
                                        <Trash2 size={13} />
                                      </button>
                                    )}
                                  </div>
                                </td>
                              </>
                            );
                          })()}

                          {/* Price cols — accounting/confirmed/received */}
                          {showPriceCols && (() => {
                            const received = receivedQtys[l.product_id] ?? l.received_qty_box ?? 0;
                            const extraPcs = receivedExtraPcs[l.product_id] ?? l.received_qty_extra_pcs ?? 0;
                            const packRatio = l.pack_ratio || 1;
                            const price = priceInputs[l.product_id] ?? l.unit_price ?? 0;
                            // Нийт ширхэг = хайрцаг × pack_ratio + задгай ширхэг
                            const totalPcs = received * packRatio + extraPcs;
                            // Нийт дүн = нэгж үнэ (ширхэг) × нийт ширхэг
                            const lineTotal = price * totalPcs;
                            const canEditPrice = canEditPriceStage;
                            // Хуучин үнэ = сүүлийн Орлого тайлангийн нэгж үнэ (last_purchase_price)
                            const savedPrice = l.last_purchase_price ?? 0;
                            const currentPrice = priceInputs[l.product_id] ?? l.unit_price ?? 0;
                            const priceChanged = savedPrice > 0 && Math.abs(currentPrice - savedPrice) > 0.01 && currentPrice > 0;
                            const priceIncreased = currentPrice > savedPrice;
                            const wasEmpty = savedPrice === 0 && currentPrice > 0;
                            return (
                              <>
                                {/* Нийт ирсэн ширхэг */}
                                <td className="hidden px-4 py-2.5 text-right md:table-cell">
                                  {totalPcs > 0 ? (
                                    <span className="text-xs font-semibold tabular-nums text-teal-700">
                                      {totalPcs.toLocaleString("mn-MN")} ш
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-300">—</span>
                                  )}
                                </td>
                                <td className="px-2 py-2 text-right md:px-4">
                                  {canEditPrice ? (
                                    <div className="flex flex-col items-end gap-0.5">
                                      <input
                                        type="number" min={0} step={1}
                                        value={priceInputs[l.product_id] === 0 ? "" : (priceInputs[l.product_id] ?? "")}
                                        placeholder="0"
                                        onWheel={(e) => e.currentTarget.blur()}
                                        onChange={(e) => {
                                          const v = parseFloat(e.target.value);
                                          setPriceInputs((prev) => ({ ...prev, [l.product_id]: isNaN(v) ? 0 : v }));
                                        }}
                                        className={`w-24 rounded-lg border px-2 py-2 text-right text-base font-medium tabular-nums outline-none shadow-sm transition focus:ring-2 md:w-28 md:py-1.5 md:text-xs ${
                                          priceChanged
                                            ? wasEmpty
                                              ? "border-emerald-300 bg-emerald-50 text-emerald-700 focus:border-emerald-400 focus:ring-emerald-200"
                                              : priceIncreased
                                                ? "border-red-300 bg-red-50 text-red-700 focus:border-red-400 focus:ring-red-200"
                                                : "border-blue-300 bg-blue-50 text-blue-700 focus:border-blue-400 focus:ring-blue-200"
                                            : "border-purple-200 bg-purple-50/50 focus:border-purple-400 focus:ring-purple-200"
                                        }`}
                                      />
                                      <div className="text-[10px] tabular-nums text-gray-400">
                                        Хуучин: {savedPrice > 0 ? savedPrice.toLocaleString("mn-MN") : "—"}
                                      </div>
                                    </div>
                                  ) : (
                                    <span className="text-xs tabular-nums text-gray-700">
                                      {price > 0 ? price.toLocaleString("mn-MN") : <span className="text-gray-300">—</span>}
                                    </span>
                                  )}
                                </td>
                                <td className="hidden px-4 py-2.5 text-right md:table-cell">
                                  {lineTotal > 0 ? (
                                    <span className="text-xs font-semibold tabular-nums text-purple-700">
                                      {lineTotal.toLocaleString("mn-MN")}
                                    </span>
                                  ) : (
                                    <span className="text-xs text-gray-300">—</span>
                                  )}
                                </td>
                                {showPriceDiff && (() => {
                                  const lpp = l.last_purchase_price ?? 0;
                                  const diff = (price > 0 && lpp > 0) ? price - lpp : null;
                                  const hasPriceDiff = diff !== null && Math.abs(diff) > 0.01;
                                  return (
                                    <td className={`hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums md:table-cell ${
                                      !hasPriceDiff ? "text-gray-300" : diff! > 0 ? "text-red-600" : "text-blue-600"
                                    }`}>
                                      {hasPriceDiff
                                        ? `${diff! > 0 ? "+" : ""}${diff!.toLocaleString("mn-MN")}`
                                        : "—"}
                                    </td>
                                  );
                                })()}
                              </>
                            );
                          })()}
                          {/* Машин — тухайн бараа ямар машинд ачигдсан (clickable dropdown) */}
                          {showVehicleCol && (
                          <td className="hidden px-4 py-2.5 md:table-cell">
                            {(() => {
                              const ships = productShipmentMap[l.product_id] ?? [];
                              const otherLoadingShipments = allShipments.filter(
                                (s) => s.status === "loading" && s.vehicle_id
                              );
                              const canChange = effectiveStatus === "loading" && otherLoadingShipments.length > 0;

                              if (ships.length === 0) {
                                return <span className="text-[10px] text-gray-300">—</span>;
                              }

                              // Олон машинд хуваагдсан бол chip л харуулна
                              if (ships.length > 1) {
                                return (
                                  <div className="flex flex-wrap gap-1">
                                    {ships.map((s, i) => (
                                      <span key={i} className="inline-flex items-center gap-1 rounded-lg bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                        <Truck size={10} />
                                        {s.vehicle_name ?? "Машин"} ({s.loaded_qty_box.toFixed(0)})
                                      </span>
                                    ))}
                                  </div>
                                );
                              }

                              // Ганц машинд байгаа — шилжүүлэх dropdown (loading stage дээр)
                              const current = ships[0];
                              if (!canChange) {
                                return (
                                  <span className="inline-flex items-center gap-1 rounded-lg bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
                                    <Truck size={10} /> {current.vehicle_name ?? "Машин"}
                                  </span>
                                );
                              }
                              return (
                                <select
                                  value={current.shipment_id}
                                  onChange={async (e) => {
                                    const targetId = parseInt(e.target.value);
                                    if (!targetId || targetId === current.shipment_id) return;
                                    await moveLineToShipment(current.shipment_line_id, targetId);
                                  }}
                                  className="rounded-lg border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-medium text-sky-700 outline-none cursor-pointer hover:bg-sky-100"
                                >
                                  {otherLoadingShipments.map((s) => (
                                    <option key={s.id} value={s.id}>
                                      🚛 {s.vehicle_name ?? `Ачилт #${s.id}`}
                                    </option>
                                  ))}
                                </select>
                              );
                            })()}
                          </td>
                          )}
                          {/* Жин (кг) — хамгийн сүүлийн багана */}
                          <td className="hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums text-gray-700 md:table-cell">
                            {rowWeight > 0 ? rowWeight.toFixed(2) : <span className="text-gray-300">—</span>}
                          </td>
                          {/* Мөр устгах — ачилтын үе шатанд (өөрчлөх үйлдэл) */}
                          {showRowActions && (
                            <td className="px-2 py-2 text-center">
                              {/* Эрхийн шалгалт: өмнө нь энэ товч ямар ч role-д
                                  харагддаг байсан (нэмэлт мөрийнхөөс ялгаатай). */}
                              {(isAdmin || eff === "manager" || eff === "supervisor") && (
                              <button
                                onClick={() => deleteLine(l.line_id)}
                                className="rounded-lg p-1.5 text-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                                title="Мөр устгах"
                              >
                                <Trash2 size={13} />
                              </button>
                              )}
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {/* Extra lines for this brand */}
                    {brandExtraLines.map((el) => (
                      <tr key={`extra-${el.id}`} className="bg-amber-50/40 group">
                        <td className="hidden px-4 py-2 text-xs text-gray-400 italic md:table-cell">{el.warehouse_name || "—"}</td>
                        <td className="hidden px-4 py-2 text-xs text-gray-400 tabular-nums md:table-cell">{el.item_code || "—"}</td>
                        <td className="px-2 py-2 md:px-4" colSpan={showStockCols ? 2 : 1}>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-600">НЭМЭЛТ</span>
                            <span className="text-xs font-medium text-gray-700 break-words">{el.name}</span>
                          </div>
                        </td>
                        {showStockCols && <td className="hidden md:table-cell"/>}
                        {showUnitWeightCols && (
                          <>
                            <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-400 md:table-cell">{el.unit_weight.toFixed(3)}</td>
                            <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-400 md:table-cell">{el.pack_ratio}</td>
                          </>
                        )}
                        {/* Дараалал нь ЗААВАЛ thead-тэй ижил байх ёстой — өмнө нь
                            loading нь estCost-оос өмнө байсан ч хоёул зэрэг
                            асдаггүй тул анзаарагдаагүй. Одоо бүгд зэрэг асна. */}
                        {showOrderCol && (
                          <td className="px-2 py-2 text-right md:px-4">
                            <span className="text-xs font-semibold tabular-nums text-amber-700">{el.qty_box.toFixed(0)}</span>
                          </td>
                        )}
                        {showSalesStatsCols && (
                          <>
                            <td className="hidden md:table-cell"/>
                            <td className="hidden md:table-cell"/>
                            <td className="hidden md:table-cell"/>
                            <td className="hidden md:table-cell"/>
                          </>
                        )}
                        {showEstCostCols && <><td className="hidden md:table-cell"/><td className="hidden md:table-cell"/></>}
                        {/* "Ачигдсан"-ы th ба өгөгдлийн td нь бүх өргөнд зурагддаг
                            тул энэ орлуулагч ч мөн адил байх ёстой — hidden болговол
                            утсан дээр НЭМЭЛТ мөр нэг нүдээр богино болно. */}
                        {showLoadedCol && <td className="px-2 py-2 md:px-4"/>}
                        {showReceivedCols && <><td className="px-2 py-2 md:px-4"/><td className="hidden md:table-cell"/><td className="hidden md:table-cell"/></>}
                        {showPriceCols && <><td className="hidden md:table-cell"/><td className="px-2 py-2 md:px-4"/><td className="hidden md:table-cell"/>{showPriceDiff && <td className="hidden md:table-cell"/>}</>}
                        {showVehicleCol && <td className="hidden md:table-cell"/>}
                        <td className="hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums text-amber-600 md:table-cell">{el.computed_weight.toFixed(2)}</td>
                        {showRowActions && (
                          <td className="px-2 py-2 text-right">
                            {(eff === "manager" || eff === "admin" || eff === "supervisor") && (
                              <div className="flex items-center justify-end gap-1 opacity-60 transition-opacity md:opacity-0 md:group-hover:opacity-100">
                                <button onClick={() => openEditExtra(el)} className="rounded p-1 text-amber-400 hover:bg-amber-100 hover:text-amber-600" title="Засах">
                                  <RefreshCw size={12} />
                                </button>
                                <button onClick={() => deleteExtraLine(el.id)} className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Устгах">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Footer totals */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-100 bg-gray-50/60 px-5 py-3">
          <span className="text-xs text-gray-400">Нийт захиалга</span>
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-center">
              <div className="text-base font-bold tabular-nums text-gray-900">{totalBoxes.toFixed(0)}</div>
              <div className="text-[10px] text-gray-400">хайрцаг</div>
            </div>
            <div className="h-8 w-px bg-gray-200" />
            <div className="text-center">
              <div className="text-base font-bold tabular-nums text-gray-900">{totalWeight.toFixed(1)}</div>
              <div className="text-[10px] text-gray-400">кг</div>
            </div>
            {showEstCostCols && order?.total_estimated_cost > 0 && (
              <>
                <div className="h-8 w-px bg-gray-200" />
                <div className="text-center">
                  <div className="text-base font-bold tabular-nums text-indigo-600">{order.total_estimated_cost.toLocaleString("mn-MN")}</div>
                  <div className="text-[10px] text-gray-400">тооцоолсон дүн ₮</div>
                </div>
              </>
            )}
            {showPriceCols && totalAmount > 0 && (
              <>
                <div className="h-8 w-px bg-gray-200" />
                <div className="text-center">
                  <div className="text-base font-bold tabular-nums text-purple-700">{totalAmount.toLocaleString("mn-MN")}</div>
                  <div className="text-[10px] text-gray-400">нийт дүн ₮</div>
                </div>
              </>
            )}
            {showPriceDiff && (order as any)?.price_diff_count > 0 && (
              <>
                <div className="h-8 w-px bg-gray-200" />
                <div className="text-center">
                  <span className="rounded-full bg-orange-100 px-2.5 py-1 text-xs font-semibold text-orange-700">
                    {(order as any).price_diff_count} бараа дээр үнэ зөрсөн
                  </span>
                </div>
              </>
            )}
            {canEdit && (
              <>
                <div className="h-8 w-px bg-gray-200" />
                <button
                  onClick={saveLines}
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-[#0071E3] px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-[#0064c8] disabled:opacity-50 transition-colors"
                >
                  {saving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
                  Хадгалах
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {/* ── Modals ── */}
      {showHistory && order && (
        <OrderHistoryModal orderId={order.id} orderLabel={`${order.order_date} #${order.id}`}
          initialBrand={brandMode && brandFilter ? brandFilter : undefined} onClose={() => setShowHistory(false)} />
      )}
      {showPDFModal && (
        <PDFExportModal
          orderId={order.id}
          orderDate={order.order_date.replaceAll("-", "/")}
          brands={[...new Set(order.lines.filter(l => (l.order_qty_box ?? 0) > 0).map(l => l.brand))].filter(Boolean).sort()}
          onClose={() => setShowPDFModal(false)}
          brandFilter={brandFilter ?? undefined}
        />
      )}

      {showERPModal && (
        <ERPExcelModal
          order={order}
          onClose={() => setShowERPModal(false)}
          brandFilter={brandFilter ?? undefined}
        />
      )}


      {/* Extra Line Modal */}
      <AnimatePresence>
        {showExtraModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowExtraModal(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"
            >
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-base font-semibold text-gray-900">
                  {editingExtra ? "Нэмэлт мөр засах" : "Нэмэлт мөр нэмэх"}
                </h3>
                <button onClick={() => setShowExtraModal(false)} className="rounded-full p-1 hover:bg-gray-100">
                  <X size={16} />
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Брэнд</label>
                  <input
                    type="text"
                    value={extraForm.brand}
                    onChange={(e) => setExtraForm((f) => ({ ...f, brand: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                    placeholder="жишээ: NAN"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600">Нэр <span className="text-red-500">*</span></label>
                  <input
                    type="text"
                    value={extraForm.name}
                    onChange={(e) => setExtraForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                    placeholder="Барааны нэр"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Код</label>
                    <input
                      type="text"
                      value={extraForm.item_code}
                      onChange={(e) => setExtraForm((f) => ({ ...f, item_code: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      placeholder="жишээ: 999001"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Агуулах</label>
                    <input
                      type="text"
                      value={extraForm.warehouse_name}
                      onChange={(e) => setExtraForm((f) => ({ ...f, warehouse_name: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      placeholder="жишээ: Архи ус"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Нэгж жин (кг)</label>
                    <input
                      type="number" min={0} step={0.001}
                      value={extraForm.unit_weight}
                      onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => setExtraForm((f) => ({ ...f, unit_weight: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      placeholder="0.000"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Хайрцаг/ш</label>
                    <input
                      type="number" min={1} step={1}
                      value={extraForm.pack_ratio}
                      onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => setExtraForm((f) => ({ ...f, pack_ratio: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      placeholder="1"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-600">Хайрцгийн тоо</label>
                    <input
                      type="number" min={0} step={1}
                      value={extraForm.qty_box}
                      onWheel={(e) => e.currentTarget.blur()}
                      onChange={(e) => setExtraForm((f) => ({ ...f, qty_box: e.target.value }))}
                      className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                      placeholder="0"
                    />
                  </div>
                </div>
                {/* Preview computed weight */}
                {extraForm.unit_weight && extraForm.pack_ratio && extraForm.qty_box && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                    Нийт жин: <span className="font-bold">
                      {((parseFloat(extraForm.qty_box) || 0) * (parseFloat(extraForm.pack_ratio) || 1) * (parseFloat(extraForm.unit_weight) || 0)).toFixed(2)} кг
                    </span>
                  </div>
                )}
              </div>
              <div className="mt-5 flex justify-end gap-2">
                <button
                  onClick={() => setShowExtraModal(false)}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Болих
                </button>
                <button
                  onClick={saveExtraLine}
                  disabled={extraSaving || !extraForm.name.trim()}
                  className="inline-flex items-center gap-2 rounded-lg bg-amber-500 px-5 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
                >
                  {extraSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
                  Хадгалах
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Confirm Modal */}
      <AnimatePresence>
        {showDeleteConfirm && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowDeleteConfirm(false); }}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl"
            >
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
                <Trash2 size={22} className="text-red-600" />
              </div>
              <h3 className="mb-1 text-base font-semibold text-gray-900">Захиалга устгах уу?</h3>
              <p className="mb-6 text-sm text-gray-500">
                Захиалга #{order?.id} болон түүний бүх мэдээлэл устах болно. Энэ үйлдлийг буцааж болохгүй.
              </p>
              <div className="flex gap-3">
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="flex-1 rounded-xl border border-gray-200 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                >
                  Болих
                </button>
                <button
                  onClick={deleteOrder}
                  className="flex-1 rounded-xl bg-red-500 py-2 text-sm font-semibold text-white hover:bg-red-600 transition-colors"
                >
                  Устгах
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Add Product Modal */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
            onClick={(e) => { if (e.target === e.currentTarget) setShowAddModal(false); }}
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              transition={{ duration: 0.18 }}
              className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl ring-1 ring-black/5"
            >
              {/* Modal header */}
              <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
                <div className="flex items-center gap-2.5">
                  <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#0071E3]/10">
                    <Plus size={14} className="text-[#0071E3]" />
                  </div>
                  <h2 className="text-sm font-semibold text-gray-900">Бараа нэмэх</h2>
                </div>
                <button
                  onClick={() => setShowAddModal(false)}
                  className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>

              {/* Search input */}
              <div className="px-4 pt-4">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    autoFocus
                    type="text"
                    placeholder="Нэр эсвэл код хайх..."
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-[#0071E3] focus:bg-white focus:ring-2 focus:ring-[#0071E3]/15"
                  />
                  {addSearch && (
                    <button
                      onClick={() => setAddSearch("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </div>

              {/* Results */}
              <div className="max-h-72 overflow-y-auto px-2 py-2">
                {addSearching && (
                  <div className="flex items-center justify-center gap-2 py-10 text-xs text-gray-400">
                    <RefreshCw size={13} className="animate-spin" />
                    Хайж байна...
                  </div>
                )}
                {!addSearching && addSearch.length >= 2 && addResults.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-10">
                    <Search size={18} className="text-gray-300" />
                    <p className="text-xs text-gray-400">Бараа олдсонгүй</p>
                  </div>
                )}
                {!addSearching && addSearch.length < 2 && (
                  <p className="py-8 text-center text-xs text-gray-400">2+ тэмдэгт оруулна уу</p>
                )}
                {!addSearching && addResults.map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-xl px-3 py-2.5 hover:bg-gray-50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold text-gray-900">{p.name}</p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-400">
                        <span className="font-mono">{p.item_code}</span>
                        <span className="text-gray-300">·</span>
                        <span>{p.brand}</span>
                        {p.warehouse_name && (
                          <>
                            <span className="text-gray-300">·</span>
                            <span className="rounded bg-blue-50 px-1 py-0.5 text-[10px] font-medium text-blue-500">{p.warehouse_name}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => addLine(p.id)}
                      className="ml-3 flex-shrink-0 rounded-lg bg-[#0071E3] px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#0064c8] transition-colors"
                    >
                      Нэмэх
                    </button>
                  </div>
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Cross-brand (admin) modal */}
      {crossBrandTarget && eff === "admin" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
             onClick={() => setCrossBrandTarget(null)}>
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between border-b border-gray-100 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  Бусад брендээс бараа нэмэх
                </h2>
                <p className="mt-0.5 text-xs text-gray-500">
                  Зорилтот бренд: <span className="font-semibold text-violet-700">{crossBrandTarget}</span>
                </p>
                <p className="mt-0.5 text-[11px] text-gray-400">
                  Онцгой тохиолдолд (жишээ нь нөгөө брендээс хямд авсан) өөр брендийн бараагаар энэ захиалгад нэмэх.
                </p>
              </div>
              <button onClick={() => setCrossBrandTarget(null)} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
                <X size={16}/>
              </button>
            </div>

            {/* Search */}
            <div className="border-b border-gray-100 bg-gray-50/60 px-6 py-3">
              <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-sm focus-within:border-[#0071E3] focus-within:ring-1 focus-within:ring-[#0071E3]/20">
                <Search size={14} className="text-gray-400"/>
                <input
                  autoFocus
                  value={crossBrandSearch}
                  onChange={e => setCrossBrandSearch(e.target.value)}
                  placeholder="Нэр эсвэл код хайх..."
                  className="flex-1 bg-transparent text-sm outline-none"
                />
                {crossBrandSearching && <RefreshCw size={14} className="animate-spin text-gray-400"/>}
              </div>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-y-auto px-4 py-2">
              {crossBrandSearch.trim().length < 2 ? (
                <div className="flex flex-col items-center gap-2 py-12 text-gray-400">
                  <Search size={22} className="text-gray-200"/>
                  <span className="text-sm">Нэр/код бичиж хайна уу</span>
                </div>
              ) : crossBrandResults.length === 0 && !crossBrandSearching ? (
                <div className="py-8 text-center text-sm text-gray-400">Бараа олдсонгүй</div>
              ) : (
                <div className="divide-y divide-gray-50">
                  {crossBrandResults.map(p => (
                    <div key={p.id} className="flex items-center gap-3 px-2 py-2.5 hover:bg-gray-50">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs font-medium text-gray-800">{p.name}</div>
                        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-gray-400">
                          <span className="font-mono">{p.item_code}</span>
                          <span>· Оригинал: <span className="font-medium text-gray-600">{p.brand}</span></span>
                          <span>· {p.pack_ratio}ш/хайрцаг</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          type="number" min={0} step={1}
                          value={crossBrandQtys[p.id] ? crossBrandQtys[p.id] : ""}
                          placeholder="0"
                          onWheel={e => e.currentTarget.blur()}
                          onChange={e => {
                            const v = parseFloat(e.target.value);
                            setCrossBrandQtys(prev => ({ ...prev, [p.id]: isNaN(v) ? 0 : v }));
                          }}
                          className="w-20 rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-right text-sm tabular-nums outline-none focus:border-[#0071E3] focus:ring-1 focus:ring-[#0071E3]/20"
                        />
                        <span className="text-[10px] text-gray-400">хайрцаг</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-3">
              <button
                onClick={() => setCrossBrandTarget(null)}
                className="rounded-lg border border-gray-200 bg-white px-4 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Болих
              </button>
              <button
                onClick={saveCrossBrand}
                disabled={crossBrandSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
              >
                {crossBrandSaving ? <RefreshCw size={14} className="animate-spin"/> : <Save size={14}/>}
                {crossBrandTarget}-д нэмэх
              </button>
            </div>
          </div>
        </div>
      )}


      {/* ══ Ороогүй бараа захиалах — глобал хайлтын консол (Ctrl+K) ══════
          1920x1080 @100%: overlay p-4 -> 1888px, панель max-w-[1840px].
          Босоо: толгой 56 + хайлт 60 + бие + хөл 60. Мөр h-9=36px тул
          нэг дэлгэцэнд ~19 мөр багтана (өмнөх 288px самбарт ~8 мөр байсан).
          z-[60]: Shell-ийн хөвөгч товч ба бусад модал z-50 тул тэдгээрээс
          дээгүүр, харин мэдэгдэл (z-[70]) доогуур байх ёстой. */}
      <AnimatePresence>
      {unordPanel && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-0 sm:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) closeUnordPanel(); }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 10 }} animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 10 }} transition={{ duration: 0.18 }}
            className="flex h-[100dvh] w-full max-w-[1840px] flex-col overflow-hidden bg-white shadow-2xl ring-1 ring-black/5 sm:h-[calc(100dvh-32px)] sm:rounded-2xl"
          >

            {/* ── Толгой ─────────────────────────────────────────────── */}
            <div className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-100 px-4 sm:px-5">
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-amber-50 text-amber-600">
                <Package size={16} />
              </span>
              <h2 className="shrink-0 text-base font-semibold text-gray-900">Ороогүй бараа захиалах</h2>
              <span className="shrink-0 rounded-md bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700 ring-1 ring-inset ring-amber-200 tabular-nums">
                {unordTotal.toLocaleString("mn-MN")} бараа
              </span>
              <span className="hidden text-[11px] text-gray-400 xl:inline">
                Код/нэрээр хайж, тоо оруулаад нэг дор нэмнэ
              </span>
              {!brandMode && (
                <button onClick={() => setUnordRailOpen((v) => !v)} title="Брендийн жагсаалтыг нуух/харуулах"
                  className="ml-auto hidden rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 lg:inline-flex lg:items-center lg:gap-1.5">
                  {unordRailOpen ? <ChevronLeft size={12}/> : <ChevronDown size={12}/>} Бренд
                </button>
              )}
              <button onClick={() => setUnordCartOpen((v) => !v)} title="Сагсыг нуух/харуулах"
                className={`hidden rounded-lg border px-2.5 py-1.5 text-[11px] font-medium hover:bg-gray-50 lg:inline-flex lg:items-center lg:gap-1.5 ${brandMode ? "ml-auto " : ""}${unordCartOpen ? "border-gray-200 bg-white text-gray-600" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                Сагс ({unordCartIds.length})
              </button>
              <button onClick={() => void refreshUnordCounts()} title="Тоололыг сервер дээрээс шинэчлэх"
                className="hidden rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 lg:inline-flex lg:items-center lg:gap-1.5">
                <RefreshCw size={12} /> Шинэчлэх
              </button>
              <button onClick={() => setUnordMobilePane((pn) => (pn === "list" ? "cart" : "list"))}
                className="ml-auto rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-[11px] font-semibold text-amber-700 lg:hidden">
                {unordMobilePane === "list" ? `Сагс (${unordCartIds.length})` : "Жагсаалт"}
              </button>
              <button onClick={closeUnordPanel} title="Хаах (Esc)"
                className="shrink-0 rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600">
                <X size={16} />
              </button>
            </div>

            {/* ── Хайлтын зурвас ─────────────────────────────────────── */}
            <div className="flex min-h-[60px] shrink-0 flex-wrap items-center gap-2.5 border-b border-gray-100 bg-gray-50/60 px-4 py-2 sm:px-5">
              <div className="flex h-10 min-w-[240px] flex-1 items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 shadow-sm transition focus-within:border-amber-400 focus-within:ring-2 focus-within:ring-amber-200">
                <Search size={15} className="shrink-0 text-gray-400" />
                <input
                  ref={unordSearchRef} autoFocus value={unordQ}
                  onChange={(e) => setUnordQ(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === "Return" || e.code === "Enter"
                      || e.code === "NumpadEnter" || e.key === "ArrowDown" || e.code === "ArrowDown") {
                      e.preventDefault(); unordFocusRow(0, 1);
                    }
                    else if (e.key === "Escape" && unordQ) { e.preventDefault(); e.stopPropagation(); setUnordQ(""); }
                  }}
                  placeholder="Код эсвэл нэрээр хайх…   (ж: 101007 эсвэл дарс)"
                  className="min-w-0 flex-1 bg-transparent text-sm text-gray-800 outline-none placeholder:text-gray-400"
                />
                {unordFetching && <RefreshCw size={14} className="shrink-0 animate-spin text-gray-400" />}
                {unordQ && (
                  <button onClick={() => setUnordQ("")} aria-label="Цэвэрлэх" className="shrink-0 text-gray-300 hover:text-gray-500">
                    <X size={13} />
                  </button>
                )}
              </div>

              {unordBrand !== null && !brandMode && (
                <button onClick={() => selectUnordBrand(null)} title="Бүх брендээс хайхад буцна"
                  className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-amber-600">
                  {unordBrand} <X size={11} />
                </button>
              )}

              <label className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 rounded-lg border border-amber-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-amber-800 shadow-sm hover:bg-amber-50"
                title="Ачаалагдсан мөрөөс нөөц 0-тэйг нь шүүнэ (сервер рүү явахгүй)">
                <input type="checkbox" checked={unordZeroOnly} onChange={(e) => setUnordZeroOnly(e.target.checked)}
                  className="h-3.5 w-3.5 cursor-pointer rounded border-amber-300 accent-amber-600" />
                Нөөц 0 <span className="text-[10px] font-normal text-amber-600">(ачаалснаас)</span>
              </label>

              <div className="hidden shrink-0 items-center gap-1.5 text-[12px] text-gray-600 lg:flex">
                <span>Бөглөх</span>
                <input type="number" min={1} step={1} value={unordFillVal} inputMode="numeric"
                  onWheel={(e) => e.currentTarget.blur()}
                  onChange={(e) => setUnordFillVal(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-14 rounded-lg border border-amber-200 bg-white px-2 py-1.5 text-right text-[13px] tabular-nums outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200" />
                <button onClick={() => bulkFillUnord(true)} disabled={!unordVisible.length}
                  title="Alt+A — харагдаж буй мөрүүдийг заасан тоогоор бөглөнө"
                  className="rounded-lg border border-amber-300 bg-white px-2.5 py-1.5 font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-40">
                  Харагдах {unordVisible.length.toLocaleString("mn-MN")} мөрд
                </button>
                {unordFillSnap && (
                  <button onClick={() => bulkFillUnord(false)}
                    className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 font-semibold text-gray-500 hover:bg-gray-50">
                    Буцаах
                  </button>
                )}
              </div>

              <span className="ml-auto hidden shrink-0 whitespace-nowrap text-[11px] tabular-nums text-gray-500 xl:inline">
                {unordBrand === null && unordQDeb.length < 2
                  ? "2+ тэмдэгт оруулна уу"
                  : `${unordFound < 0 ? "?" : unordFound.toLocaleString("mn-MN")} олдлоо · ${unordVisible.length.toLocaleString("mn-MN")} харагдаж байна`}
              </span>
            </div>

            {/* ── Бие ────────────────────────────────────────────────── */}
            <div className="flex min-h-0 flex-1">

              {/* ЗҮҮН: бүх бренд (471) */}
              {!brandMode && unordRailOpen && (
                <div className={`w-[240px] shrink-0 flex-col border-r border-gray-100 bg-gray-50/40 ${unordMobilePane === "cart" ? "hidden lg:flex" : "hidden lg:flex"}`}>
                  <div className="flex h-[38px] shrink-0 items-center gap-1.5 border-b border-gray-100 px-3">
                    <Search size={12} className="shrink-0 text-gray-400" />
                    <input value={unordRailQ} onChange={(e) => setUnordRailQ(e.target.value)} placeholder="Бренд шүүх"
                      className="w-full bg-transparent text-[12px] outline-none placeholder:text-gray-400" />
                    {unordRailQ && (
                      <button onClick={() => setUnordRailQ("")} className="text-gray-300 hover:text-gray-500"><X size={11} /></button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <button onClick={() => selectUnordBrand(null)}
                      className={`flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] font-semibold transition-colors ${
                        unordBrand === null ? "bg-amber-500 text-white" : "text-amber-800 hover:bg-amber-100"}`}>
                      <Search size={11} className="shrink-0" /> Бүх брендээс хайх
                    </button>
                    {unordRail.map((b) => (
                      <button key={b.brand} onClick={() => selectUnordBrand(b.brand)}
                        title={b.ok ? b.brand : `${b.brand} — энэ статуст захиалга нэмэх боломжгүй`}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] transition-colors ${
                          unordBrand === b.brand ? "bg-amber-500 text-white"
                            : `hover:bg-amber-100 ${b.ok ? "text-gray-700" : "text-gray-400 opacity-60"}`}`}>
                        {!b.ok && <Lock size={10} className="shrink-0" />}
                        <span className="min-w-0 flex-1 truncate">{b.brand}</span>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums ${
                          unordBrand === b.brand ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700"}`}>
                          {b.count.toLocaleString("mn-MN")}
                        </span>
                      </button>
                    ))}
                    {unordRail.length === 0 && (
                      <p className="px-3 py-6 text-center text-[11px] text-gray-400">Тохирох бренд алга</p>
                    )}
                  </div>
                </div>
              )}

              {/* ГОЛ: үр дүн */}
              <div ref={unordBodyRef}
                   className={`min-w-0 flex-1 overflow-auto ${unordMobilePane === "cart" ? "hidden lg:block" : ""}`}>
                {unordBrand === null && unordQDeb.length < 2 ? (
                  <div className="flex flex-col items-center gap-2 py-24 text-gray-400">
                    <Search size={22} className="text-gray-200" />
                    <p className="text-sm">Зүүн талаас бренд сонгох, эсвэл 2+ тэмдэгт бичиж хайна уу</p>
                    <p className="text-[11px]">Хайлт бүх {unordRail.length.toLocaleString("mn-MN")} брендээр нэг дор явна</p>
                  </div>
                ) : unordVisible.length === 0 && !unordFetching ? (
                  <div className="flex flex-col items-center gap-2 py-24 text-gray-400">
                    <Search size={18} className="text-gray-300" />
                    <p className="text-sm">{unordZeroOnly ? "Ачаалагдсанаас нөөц 0 бараа олдсонгүй" : "Тохирох бараа олдсонгүй"}</p>
                  </div>
                ) : (
                  <table className="w-full min-w-[1000px] table-fixed border-collapse">
                    <colgroup>
                      <col className="w-[96px]" />
                      <col />
                      {unordBrand === null && <col className="w-[132px]" />}
                      <col className="w-[100px]" />
                      <col className="w-[76px]" />
                      <col className="w-[104px]" />
                      <col className="w-[56px]" />
                      <col className="w-[96px]" />
                      <col className="w-[104px]" />
                      <col className="w-[72px]" />
                      <col className="w-[112px]" />
                    </colgroup>
                    <thead className="sticky top-0 z-10">
                      <tr className="border-b border-amber-200 bg-amber-50/95 text-[10px] font-bold uppercase tracking-wider text-amber-700 backdrop-blur-sm">
                        <th className="px-2 py-2 text-left">Код</th>
                        <th className="px-2 py-2 text-left">Нэр</th>
                        {unordBrand === null && <th className="px-2 py-2 text-left">Бренд</th>}
                        <th className="px-2 py-2 text-left">Агуулах</th>
                        <th className="px-2 py-2 text-left">Шош</th>
                        <th className="px-2 py-2 text-right">Үлдэгдэл</th>
                        <th className="px-2 py-2 text-right">1х=ш</th>
                        <th className="px-2 py-2 text-right">Сүүлийн үнэ</th>
                        <th className="px-2 py-2 text-right">Дүн</th>
                        <th className="px-2 py-2 text-right">Жин</th>
                        <th className="px-2 py-2 text-right">Захиалах</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unordVisible.map((it) => (
                        <UnordRow
                          key={it.line_id} it={it}
                          qty={unordQtys[it.product_id] ?? 0}
                          editable={unordRowEditable(it)}
                          done={!!unordDone[it.product_id]}
                          showBrand={unordBrand === null}
                          onQty={setUnordQty} onKey={onUnordQtyKey}
                          setRef={unordSetRef} onBrand={selectUnordBrand}
                        />
                      ))}
                    </tbody>
                  </table>
                )}

                {unordRows.length >= UNORD_MAX_ROWS ? (
                  <div className="m-3 flex items-center gap-2.5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
                    <AlertCircle size={16} className="shrink-0 text-amber-600" />
                    {UNORD_MAX_ROWS.toLocaleString("mn-MN")} мөр ачаалагдлаа — хайлт эсвэл брендээр нарийсгана уу.
                  </div>
                ) : unordRows.length > 0 && !unordEnd ? (
                  <button onClick={loadMoreUnord} disabled={unordFetching}
                    className="m-3 flex w-[calc(100%-24px)] items-center justify-center gap-2 rounded-xl border border-amber-200 bg-amber-50/60 py-2.5 text-xs font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-40">
                    {unordFetching ? <RefreshCw size={13} className="animate-spin" /> : <ChevronDown size={13} />}
                    Дараагийн {UNORD_PAGE} ({unordRows.length.toLocaleString("mn-MN")}
                    {unordFound > 0 ? ` / ${unordFound.toLocaleString("mn-MN")}` : ""})
                  </button>
                ) : null}
              </div>

              {/* БАРУУН: сагс */}
              {unordCartOpen && (
                <div className={`w-full shrink-0 flex-col border-l border-gray-100 bg-gray-50/40 lg:w-[340px] ${
                  unordMobilePane === "cart" ? "flex" : "hidden lg:flex"}`}>
                  <div className="flex h-[38px] shrink-0 items-center gap-2 border-b border-gray-100 px-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-gray-500">Сагс</span>
                    <span className="rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                      {unordCartIds.length}
                    </span>
                    {unordCartIds.length > 0 && (
                      <button onClick={() => { if (confirm("Сагсыг бүхэлд нь цэвэрлэх үү?")) { setUnordQtys({}); setUnordCart({}); setUnordCartOrder([]); setUnordFillSnap(null); } }}
                        className="ml-auto text-[11px] text-gray-400 hover:text-red-600">Цэвэрлэх</button>
                    )}
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                    {unordCartIds.length === 0 ? (
                      <p className="py-10 text-center text-xs text-gray-400">Хоосон — хайж олоод тоо оруулна уу.</p>
                    ) : unordCartIds.map((pid) => {
                      const c = unordCart[pid];
                      return (
                        <div key={pid} className="flex items-center gap-2 border-b border-gray-100 py-1.5">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[12px] font-medium text-gray-900" title={c?.name}>{c?.name}</div>
                            <div className="truncate text-[10px] text-gray-400">
                              <span className="font-mono">{c?.item_code}</span> · {c?.brand}
                            </div>
                          </div>
                          <input type="number" min={0} step={1} inputMode="numeric" value={unordQtys[pid] ?? ""}
                            onWheel={(e) => e.currentTarget.blur()} onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => { const v = parseFloat(e.target.value); if (c) setUnordQty(c, isNaN(v) ? 0 : v); }}
                            className="w-16 shrink-0 rounded-lg border border-amber-200 bg-white px-2 py-1 text-right text-[12px] tabular-nums outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-200" />
                          <button onClick={() => c && setUnordQty(c, 0)} aria-label="Хасах"
                            className="shrink-0 text-gray-300 hover:text-red-500"><X size={12} /></button>
                        </div>
                      );
                    })}
                  </div>
                  <div className="shrink-0 border-t border-gray-100 px-3 py-2 text-[11px] tabular-nums text-gray-500">
                    {unordCartIds.length} нэр төрөл · {unordCartBoxes.toLocaleString("mn-MN")} хайрцаг ·{" "}
                    {unordCartKg.toFixed(0)} кг · ₮{Math.round(unordCartMnt).toLocaleString("mn-MN")}
                  </div>
                </div>
              )}
            </div>

            {/* ── Хөл ────────────────────────────────────────────────── */}
            <div className="flex h-[60px] shrink-0 items-center gap-3 border-t border-gray-100 px-4 pb-[env(safe-area-inset-bottom)] sm:px-5">
              <span className="hidden text-[11px] text-gray-400 xl:inline">
                Enter — дараагийн мөр · Shift+Enter — өмнөх · Alt+A — бөглөх · Alt+↑↓ — бренд · Ctrl+Enter — нэмэх · Esc — хаах
              </span>
              <button onClick={closeUnordPanel}
                className="ml-auto rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50">
                Хаах
              </button>
              <button onClick={() => void saveUnordCart()} disabled={unordCartIds.length === 0 || unordSaving}
                className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-amber-700 disabled:opacity-40">
                {unordSaving ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                Захиалгад нэмэх{unordCartIds.length ? ` (${unordCartIds.length})` : ""}
              </button>
            </div>

          </motion.div>
        </motion.div>
      )}
      </AnimatePresence>


    </motion.div>
  );
}
