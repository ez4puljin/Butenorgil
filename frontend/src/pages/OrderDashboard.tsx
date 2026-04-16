import { useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  ChevronLeft, ChevronRight, RefreshCw, Package, Truck,
  ChevronDown, Layers, Box, Scale, DollarSign,
  PlusCircle, Pencil, ArrowRight, Weight,
} from "lucide-react";
import { api } from "../lib/api";
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
  items: BrandItem[];
};
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
};
type UnloadedBrand = {
  brand: string; total_remaining_boxes: number; total_weight: number;
  items: { item_code: string; name: string; remaining_boxes: number; weight: number }[];
};
type DashData = {
  order: { id: number; order_date: string; status: string; status_label: string; notes: string };
  summary: { total_brands: number; total_boxes: number; total_weight: number; total_estimated_cost: number; cancelled_lines: number; cancelled_brands: number };
  brands: Brand[];
  extra_brands: ExtraBrand[];
  shipments: Shipment[];
  unloaded_pool: { brands: UnloadedBrand[]; total_remaining_boxes: number; total_weight: number };
};

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
  const [vehicles, setVehicles] = useState<{ id: number; name: string; plate: string; is_active: boolean }[]>([]);
  const [addingVehicle, setAddingVehicle] = useState(false);
  const [assignBusy, setAssignBusy] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  useEffect(() => { load(); }, [id]);

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

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="max-w-[1600px] mx-auto">
      {/* ── Header ── */}
      <div className="rounded-2xl bg-white px-5 py-4 shadow-sm ring-1 ring-gray-100">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/order")} className="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-700 transition-colors">
              <ChevronLeft size={16} /> Буцах
            </button>
            <div className="h-5 w-px bg-gray-200" />
            <h1 className="text-xl font-bold tracking-tight text-gray-900">{order.order_date.replaceAll("-", "/")}</h1>
            <span className="text-sm text-gray-400">#{order.id}</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${stColor}`}>{order.status_label}</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} disabled={loading} className="inline-flex items-center gap-1.5 rounded-xl border border-gray-200 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 transition-colors">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Шинэчлэх
            </button>
            <button onClick={() => navigate(`/order/${id}`)} className="inline-flex items-center gap-1.5 rounded-xl bg-[#0071E3] px-3 py-2 text-xs text-white hover:opacity-90 transition-opacity">
              <Pencil size={13} /> Дэлгэрэнгүй
            </button>
          </div>
        </div>
        {order.notes && <p className="mt-2 text-xs text-gray-400 italic">{order.notes}</p>}

        {/* Summary ribbon */}
        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: Layers, label: "Бренд", value: String(summary.total_brands), bg: "bg-blue-50 text-blue-600" },
            { icon: Box, label: "Хайрцаг", value: fmtNum(summary.total_boxes), bg: "bg-emerald-50 text-emerald-600" },
            { icon: Scale, label: "Жин", value: `${fmtNum(summary.total_weight)} кг`, bg: "bg-violet-50 text-violet-600" },
            { icon: DollarSign, label: "Тооцоолсон", value: fmtCost(summary.total_estimated_cost), bg: "bg-indigo-50 text-indigo-600" },
          ].map(({ icon: Icon, label, value, bg }) => (
            <div key={label} className="flex items-center gap-3 rounded-xl bg-gray-50/80 px-4 py-3">
              <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${bg}`}><Icon size={16} /></div>
              <div>
                <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
                <div className="text-base font-bold text-gray-900">{value}</div>
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
      <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-12">

        {/* ═══ LEFT: Order Pool (7 cols) ═══ */}
        <div className="lg:col-span-7 space-y-4">
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
              ) : filteredBrands.map((b) => {
                const isExp = expandedBrand === b.brand;
                const statusBg = STATUS_BG[b.brand_status] ?? "bg-gray-50 border-gray-200 text-gray-600";
                const loadedPct = b.total_order_boxes > 0 ? (b.total_loaded_boxes / b.total_order_boxes) * 100 : 0;
                return (
                  <div key={b.brand} className="rounded-2xl bg-white shadow-sm border border-gray-100 overflow-hidden transition-shadow hover:shadow-md">
                    {/* Brand header */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      {/* Color indicator */}
                      <div className={`h-10 w-1 rounded-full shrink-0 ${statusBg.includes("blue") ? "bg-blue-400" : statusBg.includes("orange") ? "bg-orange-400" : statusBg.includes("violet") ? "bg-violet-400" : statusBg.includes("emerald") ? "bg-emerald-400" : statusBg.includes("indigo") ? "bg-indigo-400" : statusBg.includes("green") ? "bg-green-400" : statusBg.includes("red") ? "bg-red-400" : "bg-gray-300"}`} />

                      {/* Brand info */}
                      <div
                        className="flex-1 min-w-0 cursor-pointer"
                        onClick={() => navigate(`/order/${id}?brand=${encodeURIComponent(b.brand)}`)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-gray-900 truncate">{b.brand}</span>
                          <span className={`shrink-0 rounded-lg border px-2 py-0.5 text-[10px] font-semibold ${statusBg}`}>
                            {b.brand_status_label || b.brand_status}
                          </span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-3 text-[11px] text-gray-400">
                          <span>{b.line_count} бараа</span>
                          <span>{b.total_order_boxes.toFixed(0)} хайрцаг</span>
                          <span>{b.total_weight.toFixed(0)} кг</span>
                        </div>
                      </div>

                      {/* Right side: progress + navigate */}
                      <div className="flex items-center gap-2 shrink-0">
                        {b.brand_status !== "cancelled" && (
                          <div className="w-24">
                            <div className="text-right text-[10px] text-gray-400 mb-0.5">{loadedPct.toFixed(0)}%</div>
                            <CapacityBar pct={loadedPct} size="sm" />
                          </div>
                        )}
                        <button
                          onClick={() => navigate(`/order/${id}?brand=${encodeURIComponent(b.brand)}`)}
                          className="rounded-lg p-1.5 text-gray-300 hover:text-[#0071E3] hover:bg-blue-50 transition-colors"
                        >
                          <ChevronRight size={16} />
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
              })}
            </div>
          )}
        </div>

        {/* ═══ RIGHT: Vehicle Loading (5 cols) ═══ */}
        <div className="lg:col-span-5 space-y-4">
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
              <div className="space-y-1">
                {unloaded_pool.brands.map((ub) => (
                  <div key={ub.brand} className="flex items-center justify-between rounded-xl bg-white/80 px-3 py-2 border border-amber-100/50">
                    <span className="text-xs font-medium text-gray-700">{ub.brand}</span>
                    <span className="text-xs font-semibold text-amber-600">{ub.total_remaining_boxes.toFixed(0)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
