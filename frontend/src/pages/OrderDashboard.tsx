import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, RefreshCw, Package, Truck,
  ChevronDown, Layers, Box, Scale, DollarSign,
  PlusCircle, Pencil, ArrowRight, Weight, Trash2, UserRound, X, Save,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import { useLiveRefresh } from "../lib/liveEvents";
import { STATUS_COLOR, STATUS_LABEL } from "../store/purchaseOrderStore";

// ─── Types ────────────────────────────────────────────────────
type BrandItem = {
  item_code: string; name: string;
  order_qty_box: number; loaded_qty_box: number;
  unloaded_qty: number; received_qty_box: number;
  weight: number; is_cancelled?: boolean;
};
type Brand = {
  brand: string; line_count: number;
  total_order_boxes: number; total_loaded_boxes: number;
  total_unloaded_boxes: number; total_received_boxes: number;
  total_weight: number; estimated_cost: number;
  brand_status: string; brand_status_label: string; vehicle_names: string[];
  orderer: string;
  items: BrandItem[];
};
type Freight = { class: string; weight: number };
type VehicleInfo = { id: number; name: string; plate: string; capacity_kg: number; driver_name: string; driver_phone: string; is_active?: boolean };
type ExtraBrand = {
  brand: string; total_boxes: number; total_weight: number;
  items: { name: string; item_code: string; qty_box: number; computed_weight: number }[];
};
type ShipmentBrand = { brand: string; loaded_boxes: number; received_boxes: number; weight: number; line_count: number };
type Shipment = {
  id: number; vehicle_id: number | null; vehicle_name: string | null;
  driver_name: string | null; capacity_kg: number;
  status: string; status_label: string;
  brands: ShipmentBrand[];
  total_loaded_boxes: number; total_weight: number; capacity_pct: number;
  freight: Freight[]; notes: string; vehicle: VehicleInfo | null;
};
type UnloadedBrand = {
  brand: string; total_remaining_boxes: number; total_weight: number; orderer: string;
  items: { item_code: string; name: string; remaining_boxes: number; weight: number }[];
};
type DashData = {
  order: { id: number; order_date: string; status: string; status_label: string; notes: string };
  summary: { total_brands: number; total_boxes: number; total_weight: number; total_estimated_cost: number; cancelled_lines: number; cancelled_brands: number };
  brands: Brand[];
  extra_brands: ExtraBrand[];
  shipments: Shipment[];
  unloaded_pool: { brands: UnloadedBrand[]; total_remaining_boxes: number; total_weight: number; freight: Freight[] };
  orderers: { names: string[]; unassigned_label: string };
  freight_classes: string[];
};

const EDIT_ROLES = ["admin", "supervisor", "manager"];

/* Ачааны төрлийн өнгө — нэрээр тогтмол, бусад нь дарааллаар */
const FREIGHT_COLOR: Record<string, { bar: string; dot: string }> = {
  "Хүнд":   { bar: "bg-rose-500",  dot: "bg-rose-500" },
  "Цул":    { bar: "bg-amber-500", dot: "bg-amber-500" },
  "Хөнгөн": { bar: "bg-sky-400",   dot: "bg-sky-400" },
};
const FREIGHT_EXTRA = ["bg-violet-500", "bg-emerald-500", "bg-indigo-400", "bg-pink-400"];
const freightColor = (cls: string, classes: string[]) =>
  !cls ? "bg-gray-300" : FREIGHT_COLOR[cls]?.bar ?? FREIGHT_EXTRA[Math.max(0, classes.indexOf(cls)) % FREIGHT_EXTRA.length];
const freightLabel = (cls: string) => cls || "Ангилалгүй";

/* Захиалагчаар бүлэглэх: тохируулсан дарааллаар → бусад нэр → бүртгэлгүй хамгийн сүүлд */
function groupByOrderer<T extends { orderer?: string }>(list: T[], names: string[], unassigned: string) {
  const by = new Map<string, T[]>();
  for (const x of list) {
    const k = x.orderer || "";
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(x);
  }
  const out: { key: string; name: string; items: T[] }[] = [];
  for (const n of names) if (by.has(n)) out.push({ key: n, name: n, items: by.get(n)! });
  for (const [k, v] of by) if (k && !names.includes(k)) out.push({ key: k, name: k, items: v });
  if (by.has("")) out.push({ key: "", name: unassigned, items: by.get("")! });
  return out;
}

// ─── Status categories ───────────────────────────────────────
const CATEGORIES = [
  { key: "all",         label: "Бүгд",              icon: "📋" },
  { key: "preparing",   label: "Бэлдэж байна",      icon: "📝" },
  { key: "reviewing",   label: "Хянаж байна",       icon: "👁" },
  { key: "sending",     label: "Илгээж байна",      icon: "📤" },
  { key: "loading",     label: "Ачигдаж байна",     icon: "📦" },
  { key: "transit",     label: "Замд",               icon: "🚛" },
  { key: "arrived",     label: "Ирсэн",             icon: "✅" },
  { key: "accounting",  label: "Нягтлан",           icon: "🧮" },
  { key: "confirmed",   label: "Баталгаажсан",      icon: "✔️" },
  { key: "received",    label: "Орлого авагдсан",    icon: "🏁" },
  { key: "cancelled",   label: "Цуцлагдсан",        icon: "❌" },
  { key: "extra",       label: "Нэмэлт",            icon: "➕" },
];

const STATUS_BG: Record<string, string> = {
  preparing: "bg-slate-50 border-slate-200 text-slate-700",
  reviewing: "bg-blue-50 border-blue-200 text-blue-700",
  sending: "bg-violet-50 border-violet-200 text-violet-700",
  loading: "bg-orange-50 border-orange-200 text-orange-700",
  transit: "bg-indigo-50 border-indigo-200 text-indigo-700",
  arrived: "bg-emerald-50 border-emerald-200 text-emerald-700",
  accounting: "bg-purple-50 border-purple-200 text-purple-700",
  confirmed: "bg-teal-50 border-teal-200 text-teal-700",
  received: "bg-green-50 border-green-200 text-green-700",
  cancelled: "bg-red-50 border-red-200 text-red-600",
};

function fmtNum(n: number) { return n.toLocaleString("mn-MN"); }
function fmtCost(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + " сая₮";
  if (n >= 1_000) return (n / 1_000).toFixed(0) + " мян₮";
  return n.toFixed(0) + "₮";
}

// ─── Capacity Bar ────────────────────────────────────────────
function CapacityBar({ pct, size = "md" }: { pct: number; size?: "sm" | "md" }) {
  const h = size === "sm" ? "h-1.5" : "h-2.5";
  const color = pct > 95 ? "bg-red-500" : pct >= 70 ? "bg-amber-400" : "bg-emerald-500";
  return (
    <div className={`${h} w-full rounded-full bg-gray-100 overflow-hidden`}>
      <div className={`${h} rounded-full transition-all duration-500 ${color}`} style={{ width: `${Math.min(pct, 100)}%` }} />
    </div>
  );
}

// ─── Main Page ───────────────────────────────────────────────
export default function OrderDashboard() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<DashData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCat, setSelectedCat] = useState("all");
  const [expandedBrand, setExpandedBrand] = useState<string | null>(null);
  const [expandedVehicle, setExpandedVehicle] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ msg: string; ok: boolean } | null>(null);
  const [vehicles, setVehicles] = useState<VehicleInfo[]>([]);
  const { role, baseRole } = useAuthStore();
  const canEdit = EDIT_ROLES.includes((baseRole || role || "") as string);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggleGroup = (k: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const [ordererBusy, setOrdererBusy] = useState<string | null>(null);
  // Ачилтын машин засах цонх
  type ShipEdit = { sid: number; origVehicleId: number | null; vehicle_id: number | null; name: string; plate: string;
    capacity_kg: string; driver_name: string; driver_phone: string; is_active: boolean; notes: string; origNotes: string;
    orig: VehicleInfo | null };
  const [shipEdit, setShipEdit] = useState<ShipEdit | null>(null);
  const [shipSaving, setShipSaving] = useState(false);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [assignBusy, setAssignBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const dashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFlash = (msg: string, ok = true) => { setFlash({ msg, ok }); setTimeout(() => setFlash(null), 3000); };

  const load = async () => {
    setLoading(true); setLoadError(null);
    try {
      const dashRes = await api.get(`/purchase-orders/${id}/dashboard`);
      setData(dashRes.data);
      setVehicles(dashRes.data.available_vehicles ?? []);
    } catch (e: any) {
      setData(null);
      setLoadError(e?.response?.data?.detail ?? "Dashboard ачаалахад алдаа гарлаа");
    } finally { setLoading(false); }
  };

  const addVehicleShipment = async (vehicleId: number) => {
    setAddingVehicle(true);
    try { await api.post(`/purchase-orders/${id}/shipments`, { vehicle_id: vehicleId }); showFlash("Машин нэмэгдлээ"); await load(); }
    catch (e: any) { showFlash(e?.response?.data?.detail ?? "Алдаа", false); }
    finally { setAddingVehicle(false); }
  };

  const assignBrandToShipment = async (brand: string, shipmentId: number) => {
    setAssignBusy(brand);
    try { await api.post(`/purchase-orders/${id}/shipments/${shipmentId}/assign-brand`, { brand }); showFlash(`${brand} → машинд хуваарилагдлаа`); await load(); }
    catch (e: any) { showFlash(e?.response?.data?.detail ?? "Алдаа", false); }
    finally { setAssignBusy(null); }
  };

  const deleteShipment = async (shipmentId: number) => {
    if (!confirm("Хоосон машиныг устгах уу?")) return;
    try {
      await api.delete(`/purchase-orders/${id}/shipments/${shipmentId}`);
      showFlash("Машин устгагдлаа");
      await load();
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Устгахад алдаа", false);
    }
  };

  const setOrderer = async (brand: string, value: string) => {
    let orderer = value;
    if (value === "__new__") {
      const nm = (prompt("Шинэ захиалагчийн нэр:") || "").trim();
      if (!nm) return;
      orderer = nm;
    }
    setOrdererBusy(brand);
    try {
      await api.put("/brand-orderers", { brand, orderer });
      // Бүтэн dashboard дахин татахгүй — зөвхөн захиалагчийг шууд солино
      setData((d) => d && ({
        ...d,
        brands: d.brands.map((b) => (b.brand === brand ? { ...b, orderer } : b)),
        unloaded_pool: { ...d.unloaded_pool, brands: d.unloaded_pool.brands.map((b) => (b.brand === brand ? { ...b, orderer } : b)) },
        orderers: d.orderers.names.includes(orderer) || !orderer ? d.orderers : { ...d.orderers, names: [...d.orderers.names, orderer] },
      }));
      showFlash(orderer ? `${brand} → ${orderer}` : `${brand}: захиалагч хасагдлаа`);
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Захиалагч хадгалахад алдаа", false); }
    finally { setOrdererBusy(null); }
  };

  const openShipEdit = (sh: Shipment) => {
    const v = sh.vehicle;
    setShipEdit({
      sid: sh.id, origVehicleId: sh.vehicle_id, vehicle_id: sh.vehicle_id, orig: v,
      name: v?.name ?? "", plate: v?.plate ?? "", capacity_kg: v ? String(v.capacity_kg) : "",
      driver_name: v?.driver_name ?? "", driver_phone: v?.driver_phone ?? "", is_active: v?.is_active ?? true,
      notes: sh.notes ?? "", origNotes: sh.notes ?? "",
    });
  };
  const pickShipVehicle = (vid: number | null) => {
    setShipEdit((f) => {
      if (!f) return f;
      const v = vid == null ? null : (vid === f.origVehicleId ? f.orig : vehicles.find((x) => x.id === vid) ?? null);
      return { ...f, vehicle_id: vid, orig: v, name: v?.name ?? "", plate: v?.plate ?? "", capacity_kg: v ? String(v.capacity_kg) : "",
        driver_name: v?.driver_name ?? "", driver_phone: v?.driver_phone ?? "", is_active: v?.is_active ?? true };
    });
  };
  const saveShipEdit = async () => {
    if (!shipEdit) return;
    const f = shipEdit;
    const cap = parseFloat(String(f.capacity_kg).replace(",", "."));
    if (f.vehicle_id != null && !f.name.trim()) { showFlash("Машины нэр хоосон байна", false); return; }
    if (f.vehicle_id != null && !(cap > 0)) { showFlash("Даац (кг) 0-ээс их байх ёстой", false); return; }
    setShipSaving(true);
    try {
      if (f.vehicle_id !== f.origVehicleId || f.notes !== f.origNotes) {
        await api.patch(`/purchase-orders/${id}/shipments/${f.sid}`, { vehicle_id: f.vehicle_id ?? 0, notes: f.notes });
      }
      const o = f.orig;
      if (f.vehicle_id != null && o && (o.name !== f.name.trim() || o.plate !== f.plate.trim() || o.capacity_kg !== cap
          || o.driver_name !== f.driver_name.trim() || o.driver_phone !== f.driver_phone.trim())) {
        await api.put(`/logistics/vehicles/${f.vehicle_id}`, { name: f.name.trim(), plate: f.plate.trim(), capacity_kg: cap,
          driver_name: f.driver_name.trim(), driver_phone: f.driver_phone.trim(), is_active: f.is_active });
      }
      showFlash("Машины мэдээлэл хадгалагдлаа");
      setShipEdit(null);
      await load();
    } catch (e: any) { showFlash(e?.response?.data?.detail ?? "Хадгалахад алдаа", false); }
    finally { setShipSaving(false); }
  };

  useEffect(() => { load(); }, [id]);

  // ── Real-time: өөр хэрэглэгч ачилт/хуваарилалт/статус өөрчлөхөд шууд шинэчилнэ.
  //    Зөвхөн энэ захиалгын event-д хариу үзүүлнэ (order_id таарвал эсвэл тодорхойгүй).
  useLiveRefresh(["purchase-orders"], (e) => {
    const oid = (e.data as any)?.order_id;
    if (oid == null || String(oid) === String(id)) {
      if (dashTimer.current) clearTimeout(dashTimer.current);
      dashTimer.current = setTimeout(() => load(), 400);
    }
  });

  if (loading || !data) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-32 text-gray-400">
        <RefreshCw size={22} className={loading ? "animate-spin text-[#0071E3]" : ""} />
        <span className="text-sm">{loading ? "Уншиж байна..." : loadError ?? "Мэдээлэл олдсонгүй"}</span>
        {!loading && <button onClick={() => navigate(`/order/${id}`)} className="mt-2 text-xs text-[#0071E3] hover:underline">Дэлгэрэнгүй хуудас руу очих</button>}
      </div>
    );
  }

  const { order, summary, brands, extra_brands, shipments, unloaded_pool } = data;
  const stColor = STATUS_COLOR[order.status] ?? "bg-gray-100 text-gray-600";
  const activeBrands = brands.filter(b => b.total_order_boxes > 0 || b.brand_status === "cancelled");
  const statusCounts: Record<string, number> = { all: activeBrands.length };
  for (const b of activeBrands) statusCounts[b.brand_status] = (statusCounts[b.brand_status] ?? 0) + 1;
  statusCounts.extra = extra_brands.length;
  const filteredBrands = selectedCat === "all" ? activeBrands : selectedCat === "extra" ? [] : activeBrands.filter(b => b.brand_status === selectedCat);
  const loadingShipments = shipments.filter(s => s.status === "loading");

  const ordererNames = data.orderers?.names ?? [];
  const unassignedLabel = data.orderers?.unassigned_label ?? "Захиалагч бүртгэлгүй";
  const freightClasses = data.freight_classes ?? [];

  /* Ачааны төрлийн задаргаа — өнгөт зурвас + кг/хувь */
  const renderFreight = (fr: Freight[], total: number) => {
    if (!fr || fr.length === 0) return null;
    const sum = fr.reduce((t, f) => t + f.weight, 0) || total || 1;
    return (
      <div className="mb-2.5">
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-gray-100">
          {fr.map((f) => <div key={f.class || "_"} className={freightColor(f.class, freightClasses)} style={{ width: `${(f.weight / sum) * 100}%` }} title={`${freightLabel(f.class)}: ${fmtNum(Math.round(f.weight))} кг`} />)}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500">
          {fr.map((f) => (
            <span key={f.class || "_"} className="inline-flex items-center gap-1">
              <span className={`h-2 w-2 rounded-full ${freightColor(f.class, freightClasses)}`} />
              {freightLabel(f.class)} <strong className="text-gray-800">{fmtNum(Math.round(f.weight))} кг</strong>
              <span className="text-gray-400">({((f.weight / sum) * 100).toFixed(0)}%)</span>
            </span>
          ))}
        </div>
      </div>
    );
  };

  const renderBrand = (b: Brand) => {
                const isExp = expandedBrand === b.brand;
                const statusBg = STATUS_BG[b.brand_status] ?? "bg-gray-50 border-gray-200 text-gray-600";
                const loadedPct = b.total_order_boxes > 0 ? (b.total_loaded_boxes / b.total_order_boxes) * 100 : 0;
                return (
                  <div key={b.brand} className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden transition-shadow hover:shadow-md">
                    {/* Brand header */}
                    <div className="flex items-center gap-2 px-3 py-3 sm:gap-3 sm:px-4">
                      {/* Color indicator */}
                      <div className={`h-10 w-1 rounded-full shrink-0 ${statusBg.includes("blue") ? "bg-blue-400" : statusBg.includes("orange") ? "bg-orange-400" : statusBg.includes("violet") ? "bg-violet-400" : statusBg.includes("emerald") ? "bg-emerald-400" : statusBg.includes("indigo") ? "bg-indigo-400" : statusBg.includes("green") ? "bg-green-400" : statusBg.includes("red") ? "bg-red-400" : "bg-gray-300"}`} />

                      {/* Brand info */}
                      <div
                        className="flex-1 min-w-0 cursor-pointer"
                        onClick={() => navigate(`/order/${id}?brand=${encodeURIComponent(b.brand)}`)}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900 truncate">{b.brand}</span>
                          <span className={`shrink-0 rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${statusBg}`}>
                            {b.brand_status_label || b.brand_status}
                          </span>
                          {canEdit ? (
                            <select
                              value={b.orderer || ""}
                              disabled={ordererBusy === b.brand}
                              onClick={(e) => e.stopPropagation()}
                              onChange={(e) => setOrderer(b.brand, e.target.value)}
                              title="Захиалагч"
                              className={`shrink-0 rounded-lg border px-1.5 py-0.5 text-[10px] font-semibold outline-none ${b.orderer ? "border-indigo-200 bg-indigo-50 text-indigo-700" : "border-dashed border-gray-300 bg-white text-gray-400"}`}
                            >
                              <option value="">{b.orderer ? "— Хасах" : "Захиалагч…"}</option>
                              {ordererNames.map((n) => <option key={n} value={n}>{n}</option>)}
                              <option value="__new__">+ Шинэ захиалагч…</option>
                            </select>
                          ) : b.orderer ? (
                            <span className="shrink-0 rounded-lg border border-indigo-200 bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">{b.orderer}</span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0 text-[11px] text-gray-400">
                          <span>{b.line_count} бараа</span>
                          <span>{b.total_order_boxes.toFixed(0)} хайрцаг</span>
                          <span>{b.total_weight.toFixed(0)} кг</span>
                        </div>
                      </div>

                      {/* Right side: progress + navigate */}
                      <div className="flex items-center gap-1.5 shrink-0 sm:gap-2">
                        {b.brand_status !== "cancelled" && (
                          <div className="hidden w-24 sm:block">
                            <div className="text-right text-[10px] text-gray-400 mb-0.5">{loadedPct.toFixed(0)}%</div>
                            <CapacityBar pct={loadedPct} size="sm" />
                          </div>
                        )}
                        <button
                          onClick={() => navigate(`/order/${id}?brand=${encodeURIComponent(b.brand)}`)}
                          aria-label="Дэлгэрэнгүй"
                          className="inline-flex h-8 items-center gap-0.5 rounded-lg border border-[#0071E3]/25 bg-blue-50/60 pl-2.5 pr-1.5 text-[11px] font-semibold text-[#0071E3] hover:bg-blue-100 active:bg-blue-200 transition-colors"
                        >
                          Дэлгэрэнгүй <ChevronRight size={14} />
                        </button>
                      </div>
                    </div>

                    {/* Assign to vehicle — loading brands with shipments */}
                    {b.brand_status === "loading" && b.total_unloaded_boxes > 0 && loadingShipments.length > 0 && (
                      <div className="px-4 pb-3">
                        <select
                          disabled={assignBusy === b.brand}
                          defaultValue=""
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => {
                            const sid = parseInt(e.target.value);
                            if (sid) { assignBrandToShipment(b.brand, sid); e.target.value = ""; }
                          }}
                          className="w-full rounded-xl border border-orange-200 bg-orange-50/50 px-3 py-2 text-xs font-medium text-orange-700 outline-none focus:ring-2 focus:ring-orange-200 transition-all"
                        >
                          <option value="">
                            {assignBusy === b.brand ? "Хуваарилж байна..." : `🚛 Машинд ачих — ${b.total_unloaded_boxes.toFixed(0)} хайрцаг`}
                          </option>
                          {loadingShipments.map((s) => (
                            <option key={s.id} value={s.id}>{s.vehicle_name ?? `Ачилт #${s.id}`}</option>
                          ))}
                        </select>
                      </div>
                    )}

                    {/* Vehicle names */}
                    {b.vehicle_names.length > 0 && (
                      <div className="px-4 pb-2 flex flex-wrap gap-1">
                        {b.vehicle_names.map((vn) => (
                          <span key={vn} className="inline-flex items-center gap-1 rounded-lg bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-700">
                            <Truck size={10} /> {vn}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Expandable items */}
                    <div className="border-t border-gray-50">
                      <button
                        onClick={() => setExpandedBrand(isExp ? null : b.brand)}
                        className="flex w-full items-center justify-center gap-1 py-1.5 text-[10px] text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        <ChevronDown size={12} className={`transition-transform ${isExp ? "rotate-180" : ""}`} />
                        {isExp ? "Хаах" : `${b.items.filter(i => !i.is_cancelled).length} бараа`}
                      </button>
                    </div>

                    <AnimatePresence>
                      {isExp && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.2 }}
                          className="overflow-hidden"
                        >
                          <div className="bg-gray-50/70 px-4 py-2">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="text-left text-gray-400 border-b border-gray-200">
                                  <th className="py-1.5 font-medium">Код</th>
                                  <th className="py-1.5 font-medium">Нэр</th>
                                  <th className="py-1.5 text-right font-medium">Захиалга</th>
                                  <th className="py-1.5 text-right font-medium">Ачигдсан</th>
                                  <th className="py-1.5 text-right font-medium">Үлдсэн</th>
                                </tr>
                              </thead>
                              <tbody>
                                {b.items.filter(it => !it.is_cancelled).map((it, i) => (
                                  <tr key={i} className={`border-b border-gray-100 last:border-0 ${it.unloaded_qty > 0 ? "" : "opacity-40"}`}>
                                    <td className="py-1.5 font-mono text-gray-500">{it.item_code}</td>
                                    <td className="py-1.5 text-gray-700 truncate max-w-[200px]">{it.name}</td>
                                    <td className="py-1.5 text-right font-semibold">{it.order_qty_box.toFixed(0)}</td>
                                    <td className="py-1.5 text-right text-emerald-600">{it.loaded_qty_box.toFixed(0)}</td>
                                    <td className={`py-1.5 text-right font-semibold ${it.unloaded_qty > 0 ? "text-amber-600" : "text-gray-300"}`}>
                                      {it.unloaded_qty.toFixed(0)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[1600px] mx-auto overflow-x-hidden">
      {/* ── Header ── */}
      <div className="rounded-2xl bg-white px-3 py-3 shadow-sm ring-1 ring-gray-100 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
            <button onClick={() => navigate("/order")} className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-700 transition-colors">
              <ChevronLeft size={16} /> Буцах
            </button>
            <div className="h-5 w-px bg-gray-200" />
            <h1 className="text-lg font-bold tracking-tight text-gray-900 sm:text-xl">{order.order_date.replaceAll("-", "/")}</h1>
            <span className="text-xs text-gray-400 sm:text-sm">#{order.id}</span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset ring-black/5 ${stColor}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60"/>
              {order.status_label}
            </span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <button onClick={load} disabled={loading} aria-label="Шинэчлэх" className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-2.5 text-xs text-gray-600 hover:bg-gray-50 active:bg-gray-100 transition-colors">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /><span className="hidden sm:inline">Шинэчлэх</span>
            </button>
            <button onClick={() => navigate(`/order/${id}`)} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 text-xs font-semibold text-white shadow-sm hover:bg-[#005BB5] active:bg-[#004aad] transition-colors">
              <Pencil size={13} /> Дэлгэрэнгүй
            </button>
          </div>
        </div>
        {order.notes && <p className="mt-2 text-xs text-gray-400 italic">{order.notes}</p>}

        {/* Summary ribbon */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:mt-4 sm:grid-cols-4 sm:gap-3">
          {[
            { icon: Layers, label: "Бренд", value: String(summary.total_brands), bg: "bg-blue-50 text-blue-600" },
            { icon: Box, label: "Хайрцаг", value: fmtNum(summary.total_boxes), bg: "bg-emerald-50 text-emerald-600" },
            { icon: Scale, label: "Жин", value: `${fmtNum(summary.total_weight)} кг`, bg: "bg-violet-50 text-violet-600" },
            { icon: DollarSign, label: "Тооцоолсон", value: fmtCost(summary.total_estimated_cost), bg: "bg-indigo-50 text-indigo-600" },
          ].map(({ icon: Icon, label, value, bg }) => (
            <div key={label} className="flex items-center gap-2 rounded-xl bg-gray-50/80 px-3 py-2.5 sm:gap-3 sm:px-4 sm:py-3">
              <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${bg}`}><Icon size={16} /></div>
              <div className="min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
                <div className="truncate text-sm font-bold text-gray-900 sm:text-base">{value}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {flash && (
        <div className={`mt-3 rounded-xl px-4 py-2.5 text-sm font-medium ${flash.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"}`}>
          {flash.msg}
        </div>
      )}

      {/* ── Two-panel grid ── */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:mt-5 sm:gap-5 lg:grid-cols-12">

        {/* ═══ LEFT: Order Pool (7 cols) ═══ */}
        <div className="lg:col-span-7 space-y-3 sm:space-y-4">
          {/* Status pills */}
          <div className="overflow-x-auto pb-1">
            <div className="flex gap-1.5 w-max">
              {CATEGORIES.map(({ key, label, icon }) => {
                const cnt = statusCounts[key] ?? 0;
                if (cnt === 0 && key !== "all") return null;
                const isActive = selectedCat === key;
                const bg = STATUS_BG[key] ?? "bg-gray-50 border-gray-200 text-gray-600";
                return (
                  <button key={key} onClick={() => setSelectedCat(key)}
                    className={`flex items-center gap-1.5 rounded-xl border px-3 py-2 text-xs font-medium transition-all ${
                      isActive ? `${bg} shadow-sm ring-1 ring-black/5` : "border-transparent bg-white text-gray-500 hover:bg-gray-50"
                    }`}
                  >
                    <span className="text-sm">{icon}</span>
                    <span>{label}</span>
                    <span className={`ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${isActive ? "bg-white/60" : "bg-gray-100"}`}>{cnt}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Brand list */}
          {selectedCat === "extra" ? (
            <div className="space-y-2">
              {extra_brands.length === 0 ? (
                <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 shadow-sm">Нэмэлт захиалга байхгүй</div>
              ) : extra_brands.map((eb) => (
                <div key={eb.brand} className="rounded-2xl bg-white p-4 shadow-sm border border-violet-100">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <PlusCircle size={14} className="text-violet-500" />
                      <span className="text-sm font-semibold text-gray-900">{eb.brand}</span>
                    </div>
                    <span className="text-xs text-gray-400">{eb.total_boxes} хайрцаг · {eb.total_weight} кг</span>
                  </div>
                  <div className="mt-2 space-y-1">
                    {eb.items.map((it, i) => (
                      <div key={i} className="flex justify-between text-xs text-gray-600 px-2">
                        <span className="truncate">{it.item_code} — {it.name}</span>
                        <span className="font-medium shrink-0 ml-2">{it.qty_box}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {filteredBrands.length === 0 ? (
                <div className="rounded-2xl bg-white p-10 text-center text-sm text-gray-400 shadow-sm">
                  {selectedCat === "all" ? "Бренд байхгүй" : "Энэ ангилалд бренд байхгүй"}
                </div>
              ) : groupByOrderer(filteredBrands, ordererNames, unassignedLabel).map((g) => {
                const gk = `brand:${g.key}`;
                const isCol = collapsed.has(gk);
                const gBoxes = g.items.reduce((t, b) => t + b.total_order_boxes, 0);
                const gKg = g.items.reduce((t, b) => t + b.total_weight, 0);
                return (
                  <div key={gk} className="space-y-2">
                    <button onClick={() => toggleGroup(gk)} className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors ${g.key ? "bg-indigo-50/70 hover:bg-indigo-50" : "bg-gray-100/80 hover:bg-gray-100"}`}>
                      <UserRound size={14} className={g.key ? "text-indigo-500" : "text-gray-400"} />
                      <span className={`text-[13px] font-bold ${g.key ? "text-indigo-900" : "text-gray-600"}`}>{g.name}</span>
                      <span className="text-[11px] text-gray-500">{g.items.length} бренд · {fmtNum(Math.round(gBoxes))} хайрцаг · {fmtNum(Math.round(gKg))} кг</span>
                      <ChevronDown size={14} className={`ml-auto text-gray-400 transition-transform ${isCol ? "-rotate-90" : ""}`} />
                    </button>
                    {!isCol && g.items.map(renderBrand)}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Vehicle Loading (5 cols) ═══ */}
        <div className="lg:col-span-5 space-y-3 sm:space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                <Truck size={16} />
              </div>
              <div>
                <span className="text-sm font-semibold text-gray-900">Машины ачилт</span>
                <span className="ml-2 text-xs text-gray-400">{shipments.length}</span>
              </div>
            </div>
            {vehicles.length > 0 && (
              <select
                disabled={addingVehicle}
                defaultValue=""
                onChange={(e) => { const v = parseInt(e.target.value); if (v) { addVehicleShipment(v); e.target.value = ""; } }}
                className="rounded-xl border border-[#0071E3]/30 bg-blue-50/50 px-3 py-2 text-xs font-medium text-[#0071E3] outline-none hover:bg-blue-50 focus:ring-2 focus:ring-[#0071E3]/20 transition-all cursor-pointer"
              >
                <option value="">+ Машин нэмэх</option>
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.plate})</option>)}
              </select>
            )}
          </div>

          {/* Shipment cards */}
          {shipments.length === 0 ? (
            <div className="rounded-2xl bg-gradient-to-br from-gray-50 to-white p-10 text-center shadow-sm border border-gray-100">
              <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gray-100">
                <Truck size={24} className="text-gray-400" />
              </div>
              <p className="text-sm font-medium text-gray-500">Ачилт үүсээгүй байна</p>
              <p className="mt-1 text-xs text-gray-400">Машин нэмэхийн тулд дээд талын товчийг ашиглана</p>
            </div>
          ) : (
            <div className="space-y-3">
              {shipments.map((sh) => {
                const isExp = expandedVehicle === sh.id;
                const shipStColor = STATUS_COLOR[sh.status] ?? "bg-gray-100 text-gray-600";
                return (
                  <div key={sh.id} className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden transition-shadow hover:shadow-md">
                    <div onClick={() => setExpandedVehicle(isExp ? null : sh.id)} className="px-4 py-3 cursor-pointer">
                      {/* Vehicle info */}
                      <div className="flex items-center justify-between mb-3">
                        <div className="flex items-center gap-2.5">
                          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-50 to-blue-50 text-sky-600 shadow-sm">
                            <Truck size={18} />
                          </div>
                          <div>
                            <div className="text-sm font-bold text-gray-900">{sh.vehicle_name ?? "Машин оноогоогүй"}</div>
                            {sh.driver_name && <div className="text-[11px] text-gray-400">{sh.driver_name}</div>}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-lg px-2 py-0.5 text-[10px] font-semibold ${shipStColor}`}>{sh.status_label}</span>
                          {canEdit && (
                            <button
                              onClick={(e) => { e.stopPropagation(); openShipEdit(sh); }}
                              className="rounded-lg p-1 text-gray-400 hover:bg-blue-50 hover:text-[#0071E3] transition-colors"
                              title="Машины мэдээлэл засах"
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                          {/* Хоосон + loading statustai shipment устгах */}
                          {sh.status === "loading" && sh.total_loaded_boxes === 0 && (
                            <button
                              onClick={(e) => { e.stopPropagation(); deleteShipment(sh.id); }}
                              className="rounded-lg p-1 text-gray-300 hover:bg-red-50 hover:text-red-500 transition-colors"
                              title="Хоосон машиныг устгах"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                          <ChevronDown size={14} className={`text-gray-300 transition-transform ${isExp ? "rotate-180" : ""}`} />
                        </div>
                      </div>

                      {/* Capacity */}
                      <div className="mb-2.5">
                        <div className="flex justify-between text-[10px] mb-1">
                          <span className="text-gray-400">{sh.total_weight.toFixed(0)} / {sh.capacity_kg.toFixed(0)} кг</span>
                          <span className={`font-bold ${sh.capacity_pct > 95 ? "text-red-600" : sh.capacity_pct >= 70 ? "text-amber-600" : "text-emerald-600"}`}>
                            {sh.capacity_pct.toFixed(0)}%
                          </span>
                        </div>
                        <CapacityBar pct={sh.capacity_pct} />
                      </div>

                      {/* Ачааны төрлөөр жингийн задаргаа */}
                      {renderFreight(sh.freight, sh.total_weight)}
                      {sh.notes && <div className="mb-2 text-[11px] italic text-gray-400">{sh.notes}</div>}

                      {/* Brand chips */}
                      {sh.brands.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {sh.brands.map((sb) => (
                            <span key={sb.brand} className="inline-flex items-center gap-1 rounded-lg bg-blue-50 px-2 py-1 text-[10px] font-medium text-blue-700">
                              <Package size={9} /> {sb.brand} <span className="opacity-60">({sb.loaded_boxes.toFixed(0)})</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Stats */}
                      <div className="mt-2.5 flex items-center gap-4 text-[11px]">
                        <span className="text-gray-400"><strong className="text-gray-700">{sh.brands.length}</strong> бренд</span>
                        <span className="text-gray-400"><strong className="text-gray-700">{sh.total_loaded_boxes.toFixed(0)}</strong> хайрцаг</span>
                        <span className="text-gray-400"><strong className="text-gray-700">{sh.total_weight.toFixed(0)}</strong> кг</span>
                      </div>
                    </div>

                    {/* Expanded */}
                    <AnimatePresence>
                      {isExp && (
                        <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
                          <div className="border-t border-gray-100 bg-gray-50/70 px-4 py-2">
                            {sh.brands.map((sb) => (
                              <div key={sb.brand} className="flex items-center justify-between py-1.5 border-b border-gray-100 last:border-0">
                                <span className="text-xs font-semibold text-gray-700">{sb.brand}</span>
                                <div className="flex items-center gap-4 text-xs text-gray-500">
                                  <span>{sb.loaded_boxes.toFixed(0)} хайрцаг</span>
                                  <span>{sb.weight.toFixed(0)} кг</span>
                                  <span>{sb.line_count} бараа</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}

          {/* Unloaded pool */}
          {unloaded_pool.brands.length > 0 && (
            <div className="rounded-2xl border-2 border-dashed border-amber-200 bg-gradient-to-br from-amber-50/50 to-orange-50/30 p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-600">
                    <Package size={14} />
                  </div>
                  <span className="text-sm font-semibold text-amber-800">Ачигдаагүй</span>
                </div>
                <div className="text-right">
                  <div className="text-xs font-bold text-amber-700">{unloaded_pool.total_remaining_boxes.toFixed(0)} хайрцаг</div>
                  <div className="text-[10px] text-amber-500">{unloaded_pool.total_weight.toFixed(0)} кг</div>
                </div>
              </div>
              {renderFreight(unloaded_pool.freight, unloaded_pool.total_weight)}
              <div className="space-y-2">
                {groupByOrderer(unloaded_pool.brands, ordererNames, unassignedLabel).map((g) => (
                  <div key={g.key || "__none"} className="space-y-1">
                    <div className="flex items-center gap-1.5 px-1 pt-1 text-[11px] font-bold text-amber-900">
                      <UserRound size={12} className={g.key ? "text-indigo-500" : "text-gray-400"} />
                      <span className={g.key ? "" : "text-gray-500"}>{g.name}</span>
                      <span className="ml-auto font-semibold text-amber-700">{fmtNum(Math.round(g.items.reduce((t, x) => t + x.total_remaining_boxes, 0)))} хайрцаг</span>
                      <span className="font-normal text-amber-500">· {fmtNum(Math.round(g.items.reduce((t, x) => t + x.total_weight, 0)))} кг</span>
                    </div>
                    {g.items.map((ub) => (
                      <div key={ub.brand} className="flex items-center justify-between rounded-xl bg-white/80 px-3 py-2 border border-amber-100/50">
                        <span className="text-xs font-medium text-gray-700">{ub.brand}</span>
                        <span className="text-xs font-semibold text-amber-600">{ub.total_remaining_boxes.toFixed(0)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {shipEdit && (
        <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/30 p-0 sm:items-center sm:p-4" onClick={() => !shipSaving && setShipEdit(null)}>
          <div className="w-full max-w-md rounded-t-2xl bg-white p-4 shadow-xl sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-50 text-sky-600"><Truck size={15} /></div>
              <span className="text-sm font-bold text-gray-900">Ачилтын машин засах</span>
              <button onClick={() => setShipEdit(null)} className="ml-auto rounded-lg p-1 text-gray-400 hover:bg-gray-100"><X size={16} /></button>
            </div>
            <label className="block text-[11px] text-gray-500">Машин
              <select value={shipEdit.vehicle_id ?? ""} onChange={(e) => pickShipVehicle(e.target.value ? Number(e.target.value) : null)}
                className="mt-0.5 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-[13px] outline-none focus:border-[#0071E3]">
                <option value="">— Машин оноохгүй</option>
                {shipEdit.origVehicleId != null && shipEdit.orig && !vehicles.some((v) => v.id === shipEdit.origVehicleId) && shipEdit.vehicle_id === shipEdit.origVehicleId && (
                  <option value={shipEdit.origVehicleId}>{shipEdit.orig.name} ({shipEdit.orig.plate})</option>
                )}
                {vehicles.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.plate})</option>)}
              </select>
            </label>
            {shipEdit.vehicle_id != null && (
              <div className="mt-3 rounded-xl bg-gray-50 p-3">
                <div className="mb-2 text-[11px] font-semibold text-gray-600">Машины мэдээлэл <span className="font-normal text-gray-400">(бүх захиалгад хамаарна)</span></div>
                <div className="grid grid-cols-2 gap-2">
                  {([["name", "Нэр"], ["plate", "Улсын дугаар"], ["capacity_kg", "Даац (кг)"], ["driver_name", "Жолооч"], ["driver_phone", "Жолоочийн утас"]] as const).map(([k, l]) => (
                    <label key={k} className={`text-[11px] text-gray-500 ${k === "name" ? "col-span-2" : ""}`}>{l}
                      <input value={(shipEdit as any)[k]} onChange={(e) => setShipEdit((f) => f && ({ ...f, [k]: e.target.value }))}
                        inputMode={k === "capacity_kg" ? "decimal" : k === "driver_phone" ? "tel" : undefined}
                        className="mt-0.5 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#0071E3]" />
                    </label>
                  ))}
                </div>
              </div>
            )}
            <label className="mt-3 block text-[11px] text-gray-500">Тэмдэглэл (энэ ачилт)
              <input value={shipEdit.notes} onChange={(e) => setShipEdit((f) => f && ({ ...f, notes: e.target.value }))}
                className="mt-0.5 w-full rounded-xl border border-gray-200 px-3 py-2 text-[13px] outline-none focus:border-[#0071E3]" />
            </label>
            <div className="mt-4 flex gap-2">
              <button onClick={saveShipEdit} disabled={shipSaving}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-2.5 text-[13px] font-semibold text-white disabled:opacity-50">
                {shipSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />} Хадгалах
              </button>
              <button onClick={() => setShipEdit(null)} disabled={shipSaving} className="rounded-xl border border-gray-200 px-4 py-2.5 text-[13px] font-semibold text-gray-600">Болих</button>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
