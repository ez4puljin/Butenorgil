import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  RefreshCw,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  X,
  Truck,
  Package,
  Calendar,
  ArrowRight,
  Save,
  Search,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  usePurchaseOrderStore,
  STATUS_COLOR,
  type POSummary,
} from "../store/purchaseOrderStore";

const TAB_FILTERS = [
  { key: "", label: "Бүгд" },
  { key: "preparing", label: "Бэлдэж байна" },
  { key: "reviewing", label: "Хянаж байна" },
  { key: "sending", label: "Илгээж байна" },
  { key: "loading", label: "Ачигдаж байна" },
  { key: "transit", label: "Замд" },
  { key: "arrived", label: "Ирсэн" },
  { key: "accounting", label: "Нягтлан" },
  { key: "confirmed", label: "Баталгаажсан" },
  { key: "received", label: "Орлого авагдсан" },
];

// Shipment-төвтэй view-н types
type ShipmentItem = {
  id: number;
  purchase_order_id: number;
  vehicle_id: number | null;
  vehicle_name: string | null;
  status: string;
  status_label: string;
  notes: string;
  created_at: string | null;
  line_count: number;
  total_loaded_box: number;
  total_received_box: number;
  total_weight: number;
  brand_count: number;
  brands: string[];
  order_date: string | null;
  order_status: string;
};

type VehicleGroup = {
  vehicle_id: number | null;
  vehicle_name: string | null;
  driver_name: string | null;
  shipments: ShipmentItem[];
  shipment_count: number;
  order_count: number;
  order_ids: number[];
  total_loaded_box: number;
  total_received_box: number;
  total_weight: number;
  total_lines: number;
  brands: string[];
};

type ShipmentLineDetail = {
  id: number;
  po_line_id: number;
  product_id: number;
  item_code: string;
  name: string;
  brand: string;
  warehouse_name: string;
  loaded_qty_box: number;
  received_qty_box: number;
  unit_weight: number;
  pack_ratio: number;
};

export default function PurchaseOrderList() {
  const { role, baseRole } = useAuthStore();
  const isAdmin = (baseRole ?? role) === "admin";
  const canAdvanceTransit = ["admin", "supervisor", "manager"].includes(baseRole ?? role ?? "");

  const store = usePurchaseOrderStore();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("");
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createForm, setCreateForm] = useState<{
    order_date: string;
    notes: string;
    mode: "all" | "brands";
    brands: string[];
  }>({
    order_date: new Date().toISOString().slice(0, 10),
    notes: "",
    mode: "all",
    brands: [],
  });
  const [creating, setCreating] = useState(false);

  // Brand list for the "Сонгосон бренд" mode
  const [allBrands, setAllBrands] = useState<string[]>([]);
  const [brandSearch, setBrandSearch] = useState("");
  const [brandsLoaded, setBrandsLoaded] = useState(false);

  // Archive view toggle (admin/manager/supervisor)
  const [archiveMode, setArchiveMode] = useState<"false" | "only">("false");
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // ── Shipment-төвтэй view (transit/arrived tab) state ──
  const [vehicleGroups, setVehicleGroups] = useState<VehicleGroup[]>([]);
  const [shipBusy, setShipBusy] = useState<number | null>(null); // vehicle_id
  const [receiveTarget, setReceiveTarget] = useState<VehicleGroup | null>(null);
  const [receiveLines, setReceiveLines] = useState<(ShipmentLineDetail & { shipment_id: number; order_id: number })[]>([]);
  const [receiveLoading, setReceiveLoading] = useState(false);
  const [receivedDraft, setReceivedDraft] = useState<Record<number, string>>({});
  const [receiveSaving, setReceiveSaving] = useState(false);

  const isShipmentView = activeTab === "transit" || activeTab === "arrived";

  const flash = (text: string, ok = true) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 4000);
  };

  const loadOrders = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (activeTab) params.status = activeTab;
      params.archived = archiveMode;
      const res = await api.get("/purchase-orders", { params });
      store.setOrders(res.data);
    } finally {
      setLoading(false);
    }
  };

  const loadShipments = async () => {
    setLoading(true);
    try {
      const res = await api.get("/purchase-orders/shipments/by-status", {
        params: { status: activeTab },
      });
      setVehicleGroups(res.data);
    } catch {
      setVehicleGroups([]);
    } finally {
      setLoading(false);
    }
  };

  // ── Vehicle group status advance (transit → arrived for ALL shipments) ──
  const advanceVehicleGroup = async (vg: VehicleGroup) => {
    setShipBusy(vg.vehicle_id);
    try {
      await Promise.all(
        vg.shipments.map((sh) =>
          api.patch(`/purchase-orders/${sh.purchase_order_id}/shipments/${sh.id}/advance`)
        )
      );
      flash(`${vg.vehicle_name ?? "Машин"} — Ирсэн төлөвт оруулав`);
      await loadShipments();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setShipBusy(null);
    }
  };

  // ── Open receive modal for ALL shipments in vehicle group ──
  const openReceiveModal = async (vg: VehicleGroup) => {
    setReceiveTarget(vg);
    setReceiveLoading(true);
    setReceiveLines([]);
    setReceivedDraft({});
    try {
      // Load detail for ALL shipments in this vehicle group
      const results = await Promise.all(
        vg.shipments.map((sh) =>
          api.get(`/purchase-orders/${sh.purchase_order_id}/shipments/${sh.id}`)
        )
      );
      const allLines: (ShipmentLineDetail & { shipment_id: number; order_id: number })[] = [];
      const draft: Record<number, string> = {};
      for (let i = 0; i < results.length; i++) {
        const sh = vg.shipments[i];
        const lines: ShipmentLineDetail[] = results[i].data.lines ?? [];
        for (const l of lines) {
          allLines.push({ ...l, shipment_id: sh.id, order_id: sh.purchase_order_id });
          const v = l.received_qty_box > 0 ? l.received_qty_box : l.loaded_qty_box;
          draft[l.id] = String(v);
        }
      }
      setReceiveLines(allLines);
      setReceivedDraft(draft);
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Дэлгэрэнгүй ачаалахад алдаа", false);
      setReceiveTarget(null);
    } finally {
      setReceiveLoading(false);
    }
  };

  const saveReceived = async () => {
    if (!receiveTarget) return;
    setReceiveSaving(true);
    try {
      // Group lines by shipment, then save each
      const byShipment: Record<string, { orderId: number; shipmentId: number; lines: { shipment_line_id: number; received_qty_box: number }[] }> = {};
      for (const l of receiveLines) {
        const key = `${l.order_id}-${l.shipment_id}`;
        if (!byShipment[key]) byShipment[key] = { orderId: l.order_id, shipmentId: l.shipment_id, lines: [] };
        byShipment[key].lines.push({
          shipment_line_id: l.id,
          received_qty_box: parseFloat(receivedDraft[l.id] || "0") || 0,
        });
      }
      await Promise.all(
        Object.values(byShipment).map((g) =>
          api.post(`/purchase-orders/${g.orderId}/shipments/${g.shipmentId}/received`, { lines: g.lines })
        )
      );
      flash("Ирсэн тоо хадгалагдлаа");
      setReceiveTarget(null);
      await loadShipments();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа", false);
    } finally {
      setReceiveSaving(false);
    }
  };

  const advanceFromReceiveModal = async () => {
    if (!receiveTarget) return;
    setReceiveSaving(true);
    try {
      // 1. Save received quantities for ALL shipments
      const byShipment: Record<string, { orderId: number; shipmentId: number; lines: { shipment_line_id: number; received_qty_box: number }[] }> = {};
      for (const l of receiveLines) {
        const key = `${l.order_id}-${l.shipment_id}`;
        if (!byShipment[key]) byShipment[key] = { orderId: l.order_id, shipmentId: l.shipment_id, lines: [] };
        byShipment[key].lines.push({
          shipment_line_id: l.id,
          received_qty_box: parseFloat(receivedDraft[l.id] || "0") || 0,
        });
      }
      await Promise.all(
        Object.values(byShipment).map((g) =>
          api.post(`/purchase-orders/${g.orderId}/shipments/${g.shipmentId}/received`, { lines: g.lines })
        )
      );
      // 2. Advance ALL shipments
      await Promise.all(
        receiveTarget.shipments.map((sh) =>
          api.patch(`/purchase-orders/${sh.purchase_order_id}/shipments/${sh.id}/advance`)
        )
      );
      flash("Хадгалаад нягтлан руу шилжүүлэв");
      setReceiveTarget(null);
      await loadShipments();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setReceiveSaving(false);
    }
  };

  const checkMaster = async () => {
    try {
      const res = await api.get("/purchase-orders/master-check");
      store.setMasterStatus(res.data.exists, res.data.updated_at);
    } catch {
      store.setMasterStatus(false, null);
    }
  };

  useEffect(() => {
    checkMaster();
    if (isShipmentView) loadShipments();
    else loadOrders();
  }, []);

  useEffect(() => {
    if (isShipmentView) loadShipments();
    else loadOrders();
  }, [activeTab, archiveMode]);

  const createOrder = async () => {
    if (!createForm.order_date) {
      flash("Огноо сонгоно уу", false);
      return;
    }
    if (createForm.mode === "brands" && createForm.brands.length === 0) {
      flash("Ядаж нэг бренд сонгоно уу", false);
      return;
    }
    setCreating(true);
    try {
      const payload: any = {
        order_date: createForm.order_date,
        notes: createForm.notes,
      };
      if (createForm.mode === "brands" && createForm.brands.length > 0) {
        payload.brands = createForm.brands;
      }
      const res = await api.post("/purchase-orders", payload);
      flash(`Захиалга үүслээ — ${res.data.line_count} бараа нэмэгдлээ`);
      setShowCreateModal(false);
      setCreateForm({ order_date: new Date().toISOString().slice(0, 10), notes: "", mode: "all", brands: [] });
      setBrandSearch("");
      await loadOrders();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setCreating(false);
    }
  };

  const archiveOrder = async (id: number, archive: boolean) => {
    if (!confirm(archive ? "Захиалгыг архивлах уу?" : "Архиваас буцаах уу?")) return;
    try {
      await api.patch(`/purchase-orders/${id}/archive`, { archived: archive });
      flash(archive ? "Архивлагдлаа" : "Архиваас буцаагдлаа");
      await loadOrders();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    }
  };

  const loadBrandsIfNeeded = async () => {
    if (brandsLoaded) return;
    try {
      const r = await api.get("/products/all-brands");
      setAllBrands(r.data);
      setBrandsLoaded(true);
    } catch {}
  };

  const filtered: POSummary[] = store.orders;

  const canCreate = role === "manager" || role === "admin" || role === "supervisor";

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="overflow-x-hidden">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Захиалга</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">Захиалгын жагсаалт ба статус хяналт</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Master status */}
          {store.masterExists === true && (
            <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700 ring-1 ring-inset ring-emerald-100">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>
              Master бэлэн
            </div>
          )}
          {store.masterExists === false && (
            <div className="flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700 ring-1 ring-inset ring-amber-100">
              <AlertTriangle size={11} />
              Master байхгүй
            </div>
          )}

          {canCreate && (
            <button
              onClick={() => {
                if (!store.masterExists) {
                  flash("Master Excel файл байхгүй байна. Эхлээд Мастер нэгтгэл хийнэ үү.", false);
                  return;
                }
                setShowCreateModal(true);
              }}
              className={`inline-flex h-10 items-center gap-2 rounded-apple px-4 text-sm font-semibold text-white shadow-sm transition-colors ${
                store.masterExists === false
                  ? "cursor-not-allowed bg-gray-400"
                  : "bg-[#0071E3] hover:bg-[#005BB5] active:bg-[#004aad]"
              }`}
            >
              <Plus size={16} />
              <span className="hidden sm:inline">Шинэ захиалга</span>
              <span className="sm:hidden">Шинэ</span>
            </button>
          )}
        </div>
      </div>

      {msg && (
        <div
          className={`mt-4 rounded-apple px-4 py-3 text-sm font-medium ${
            msg.ok ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-700"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* ── Status filter tabs (horizontally scrollable on mobile) ── */}
      <div className="mt-5 overflow-x-auto pb-1">
        <div className="flex w-max gap-1 rounded-apple bg-gray-100 p-1">
          {TAB_FILTERS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={`whitespace-nowrap rounded-apple px-3 py-1.5 text-xs font-medium transition-colors ${
                activeTab === t.key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═════════════════════════════════════════════════════════════
           SHIPMENT-ТӨВТЭЙ VIEW (transit / arrived tab)
         ═════════════════════════════════════════════════════════════ */}
      {isShipmentView && (
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Truck size={16} className="text-gray-400" />
              <span className="text-sm text-gray-600">
                {activeTab === "transit" ? "Замд явж буй" : "Ирсэн"} машинууд:{" "}
                <strong className="text-gray-900">{vehicleGroups.length}</strong>
              </span>
            </div>
            <button
              onClick={loadShipments}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-apple border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              Шинэчлэх
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <RefreshCw size={20} className="animate-spin text-gray-400" />
            </div>
          ) : vehicleGroups.length === 0 ? (
            <div className="rounded-apple bg-white px-5 py-16 text-center shadow-sm">
              <Truck size={36} className="mx-auto mb-2 text-gray-300" />
              <p className="text-sm text-gray-400">
                {activeTab === "transit"
                  ? "Замд явж буй машин байхгүй"
                  : "Ирсэн машин байхгүй"}
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {vehicleGroups.map((vg) => {
                const isClickable = activeTab === "arrived";
                return (
                  <div
                    key={vg.vehicle_id ?? "none"}
                    onClick={() => isClickable && openReceiveModal(vg)}
                    className={`group rounded-apple bg-white p-4 shadow-sm border border-gray-100 transition-all ${
                      isClickable ? "cursor-pointer hover:border-blue-300 hover:shadow-md" : ""
                    }`}
                  >
                    {/* Vehicle header */}
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${
                          activeTab === "transit" ? "bg-sky-50 text-sky-600" : "bg-emerald-50 text-emerald-600"
                        }`}>
                          <Truck size={18} />
                        </div>
                        <div>
                          <div className="text-sm font-semibold text-gray-900">
                            {vg.vehicle_name ?? "Машин оноогоогүй"}
                          </div>
                          {vg.driver_name && (
                            <div className="text-xs text-gray-400">{vg.driver_name}</div>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        {vg.order_count > 1 && (
                          <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700">
                            {vg.order_count} захиалга
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Order references */}
                    <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                      {vg.shipments.map((sh) => (
                        <span key={sh.id} className="inline-flex items-center gap-1">
                          <Calendar size={10} />
                          {sh.order_date?.replaceAll("-", "/") ?? "?"} <span className="text-gray-300">#{sh.purchase_order_id}</span>
                        </span>
                      ))}
                    </div>

                    {/* Brands */}
                    {vg.brands.length > 0 && (
                      <div className="mb-3 flex flex-wrap gap-1">
                        {vg.brands.slice(0, 4).map((b) => (
                          <span key={b} className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
                            {b}
                          </span>
                        ))}
                        {vg.brands.length > 4 && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500">
                            +{vg.brands.length - 4}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Stats */}
                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-gray-50 p-2 text-center">
                      <div>
                        <div className="text-[10px] text-gray-400">Бараа</div>
                        <div className="text-sm font-semibold text-gray-900">{vg.total_lines}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-400">Хайрцаг</div>
                        <div className="text-sm font-semibold text-gray-900">{vg.total_loaded_box.toFixed(0)}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-gray-400">Жин (кг)</div>
                        <div className="text-sm font-semibold text-gray-900">{vg.total_weight.toFixed(0)}</div>
                      </div>
                    </div>

                    {/* Actions */}
                    {activeTab === "transit" && canAdvanceTransit && (
                      <button
                        onClick={(e) => { e.stopPropagation(); advanceVehicleGroup(vg); }}
                        disabled={shipBusy === vg.vehicle_id}
                        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-apple bg-emerald-600 py-2 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
                      >
                        {shipBusy === vg.vehicle_id ? <RefreshCw size={12} className="animate-spin" /> : <ArrowRight size={12} />}
                        Ирсэн төлөвт оруулах
                      </button>
                    )}
                    {activeTab === "arrived" && (
                      <button
                        onClick={(e) => { e.stopPropagation(); openReceiveModal(vg); }}
                        className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-apple bg-[#0071E3] py-2 text-xs font-medium text-white hover:opacity-90"
                      >
                        <Package size={12} />
                        Бараа харах / Тоо оруулах
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════
           ЗАХИАЛГА-ТӨВТЭЙ VIEW (бусад tab-ууд)
         ═════════════════════════════════════════════════════════════ */}
      {!isShipmentView && (
      <div className="mt-4 rounded-apple bg-white shadow-sm ring-1 ring-gray-100">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 px-3 py-2.5 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-medium text-gray-600 sm:text-sm">
              <span className="tabular-nums text-gray-900">{filtered.length}</span> захиалга
            </span>
            {archiveMode === "only" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-700 ring-1 ring-inset ring-amber-100">
                <Archive size={10}/> Архив
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {(role === "admin" || role === "manager" || role === "supervisor") && (
              <button
                onClick={() => setArchiveMode(m => m === "only" ? "false" : "only")}
                className={`inline-flex h-9 items-center gap-1.5 rounded-apple border px-2.5 text-[11px] font-medium sm:text-xs ${
                  archiveMode === "only"
                    ? "border-amber-300 bg-amber-50 text-amber-700"
                    : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50 active:bg-gray-100"
                }`}
              >
                {archiveMode === "only" ? <ArchiveRestore size={13}/> : <Archive size={13}/>}
                <span className="hidden sm:inline">{archiveMode === "only" ? "Үндсэн жагсаалт" : "Архив харах"}</span>
                <span className="sm:hidden">{archiveMode === "only" ? "Үндсэн" : "Архив"}</span>
              </button>
            )}
            <button
              onClick={loadOrders}
              disabled={loading}
              aria-label="Шинэчлэх"
              className="inline-flex h-9 items-center gap-1.5 rounded-apple border border-gray-200 bg-white px-2.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 active:bg-gray-100 sm:text-xs"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              <span className="hidden sm:inline">Шинэчлэх</span>
            </button>
          </div>
        </div>

        {filtered.length === 0 && !loading ? (
          <div className="px-5 py-12 text-center text-sm text-gray-400">
            Захиалга байхгүй байна
          </div>
        ) : (
          <>
            {/* ── Mobile card view (hidden on md+) ── */}
            <div className="divide-y divide-gray-100 md:hidden">
              {filtered.map((o) => {
                const stColor = STATUS_COLOR[o.status] ?? "bg-gray-100 text-gray-600";
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => navigate(`/order/${o.id}/dashboard`)}
                    className="block w-full text-left px-4 py-3.5 transition-colors active:bg-gray-50"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-lg font-bold tabular-nums tracking-tight text-gray-900 leading-none">
                          {o.order_date.replaceAll("-", "/")}
                        </div>
                        <div className="mt-1 text-[11px] text-gray-400">
                          #{o.id} · {o.created_by_username}
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1 ring-inset ring-black/5 ${stColor}`}>
                          <span className="h-1.5 w-1.5 rounded-full bg-current opacity-60"/>
                          {o.status_label}
                        </span>
                        <ChevronRight size={15} className="text-gray-300 shrink-0" />
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-gray-500">
                      <span className="inline-flex items-center gap-1">
                        <span className="font-semibold text-gray-700 tabular-nums">{o.line_count}</span>
                        бараа
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="font-semibold text-gray-700 tabular-nums">{o.total_boxes.toFixed(0)}</span>
                        хайрцаг
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="font-semibold text-gray-700 tabular-nums">{o.total_weight.toFixed(1)}</span>
                        кг
                      </span>
                      {o.vehicle_name && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700 ring-1 ring-inset ring-blue-100">
                          <Truck size={10} /> {o.vehicle_name}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* ── Desktop table (hidden on mobile) ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                    <th className="px-5 py-3 font-medium">Огноо</th>
                    <th className="px-5 py-3 font-medium">Статус</th>
                    <th className="px-5 py-3 font-medium text-right">Мөрийн тоо</th>
                    <th className="px-5 py-3 font-medium text-right">Нийт хайрцаг</th>
                    <th className="px-5 py-3 font-medium text-right">Нийт жин (кг)</th>
                    <th className="px-5 py-3 font-medium">Машин</th>
                    <th className="px-5 py-3 font-medium">Тэмдэглэл</th>
                    <th className="px-5 py-3 font-medium">Үүсгэсэн</th>
                    <th className="px-5 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filtered.map((o) => {
                    const stColor = STATUS_COLOR[o.status] ?? "bg-gray-100 text-gray-600";
                    return (
                      <tr
                        key={o.id}
                        onClick={() => navigate(`/order/${o.id}/dashboard`)}
                        className="cursor-pointer hover:bg-gray-50"
                      >
                        <td className="px-5 py-3.5 font-semibold text-gray-900">
                          {o.order_date.replaceAll("-", "/")}
                        </td>
                        <td className="px-5 py-3.5">
                          <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${stColor}`}>
                            {o.status_label}
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right text-gray-700">{o.line_count}</td>
                        <td className="px-5 py-3.5 text-right text-gray-700">
                          {o.total_boxes.toFixed(0)}
                        </td>
                        <td className="px-5 py-3.5 text-right font-medium text-gray-900">
                          {o.total_weight.toFixed(2)}
                        </td>
                        <td className="px-5 py-3.5 text-gray-500">
                          {o.vehicle_name
                            ? <span className="flex items-center gap-1 text-xs"><Truck size={12} className="text-blue-400" />{o.vehicle_name}</span>
                            : <span className="text-gray-300 text-xs">—</span>
                          }
                        </td>
                        <td className="px-5 py-3.5 text-gray-500 text-xs max-w-[200px] truncate" title={o.notes || ""}>
                          {o.notes || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-5 py-3.5 text-gray-500">{o.created_by_username}</td>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-1">
                            {(role === "admin" || role === "manager" || role === "supervisor") && (
                              <button
                                onClick={(e) => { e.stopPropagation(); archiveOrder(o.id, !(o as any).is_archived); }}
                                title={(o as any).is_archived ? "Архиваас буцаах" : "Архивлах"}
                                className="rounded-md p-1 text-gray-300 hover:bg-amber-50 hover:text-amber-600"
                              >
                                {(o as any).is_archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>}
                              </button>
                            )}
                            <ChevronRight size={16} className="text-gray-300" />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      )}

      {/* ── Create modal ── */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
          <div className="flex w-full max-w-md max-h-[92vh] flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-apple"
               style={{ paddingBottom: "env(safe-area-inset-bottom)" }}>
            {/* Grabber (mobile bottom sheet) */}
            <div className="flex justify-center py-2 sm:hidden">
              <div className="h-1 w-10 rounded-full bg-gray-300"/>
            </div>
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-3 sm:px-6 sm:py-4">
              <h2 className="text-base font-semibold text-gray-900 sm:text-lg">Шинэ захиалга үүсгэх</h2>
              <button onClick={() => setShowCreateModal(false)} className="grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700">
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 sm:px-6 space-y-4">
              {store.masterExists && store.masterUpdatedAt && (
                <div className="flex items-center gap-1.5 rounded-apple bg-emerald-50 px-3 py-2 text-xs text-emerald-700 ring-1 ring-inset ring-emerald-100">
                  <CheckCircle2 size={13} />
                  Master: {new Date(store.masterUpdatedAt).toLocaleString("mn-MN")}
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600">Захиалгын огноо</label>
                <input
                  type="date"
                  value={createForm.order_date}
                  onChange={(e) => setCreateForm((f) => ({ ...f, order_date: e.target.value }))}
                  className="w-full rounded-apple border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15"
                />
              </div>

              {/* Mode toggle */}
              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600">Бараа дуудах горим</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setCreateForm(f => ({ ...f, mode: "all" }))}
                    className={`flex-1 rounded-apple border py-2.5 text-xs font-semibold transition-colors ${
                      createForm.mode === "all"
                        ? "border-[#0071E3] bg-[#0071E3] text-white shadow-sm"
                        : "border-gray-200 bg-white text-gray-700 active:bg-gray-50"
                    }`}
                  >
                    Нэгдсэн захиалга
                  </button>
                  <button
                    onClick={() => { setCreateForm(f => ({ ...f, mode: "brands" })); loadBrandsIfNeeded(); }}
                    className={`flex-1 rounded-apple border py-2.5 text-xs font-semibold transition-colors ${
                      createForm.mode === "brands"
                        ? "border-[#0071E3] bg-[#0071E3] text-white shadow-sm"
                        : "border-gray-200 bg-white text-gray-700 active:bg-gray-50"
                    }`}
                  >
                    Сонгосон бренд
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-gray-400">
                  {createForm.mode === "all"
                    ? "Бүх брэнд, бүх бараа нэг захиалгад ачаалагдана."
                    : "Зөвхөн сонгосон брэндүүдийн бараа ачаалагдана."}
                </p>
              </div>

              {/* Brand picker */}
              {createForm.mode === "brands" && (
                <div>
                  <label className="mb-1.5 block text-xs font-semibold text-gray-600">
                    Брэнд сонгох <span className="text-gray-300 font-normal">({createForm.brands.length} сонгосон)</span>
                  </label>
                  <div className="flex items-center gap-2 rounded-apple border border-gray-200 bg-white px-3 py-2.5">
                    <Search size={14} className="text-gray-400"/>
                    <input
                      value={brandSearch}
                      onChange={e => setBrandSearch(e.target.value)}
                      placeholder="Брэнд хайх..."
                      className="flex-1 bg-transparent text-base outline-none sm:text-sm"
                    />
                  </div>
                  {createForm.brands.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {createForm.brands.map(b => (
                        <span key={b} className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-700">
                          {b}
                          <button
                            onClick={() => setCreateForm(f => ({ ...f, brands: f.brands.filter(x => x !== b) }))}
                            className="hover:text-blue-900"
                          >
                            <X size={10}/>
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-2 max-h-48 overflow-y-auto rounded-apple border border-gray-100 bg-gray-50/50 p-1">
                    {allBrands
                      .filter(b => !createForm.brands.includes(b))
                      .filter(b => !brandSearch.trim() || b.toLowerCase().includes(brandSearch.toLowerCase()))
                      .slice(0, 50)
                      .map(b => (
                        <button
                          key={b}
                          onClick={() => setCreateForm(f => ({ ...f, brands: [...f.brands, b] }))}
                          className="block w-full rounded px-2 py-1 text-left text-xs text-gray-700 hover:bg-white"
                        >
                          {b}
                        </button>
                      ))}
                    {allBrands.length === 0 && (
                      <div className="px-2 py-3 text-center text-xs text-gray-400">Брэнд байхгүй</div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="mb-1.5 block text-xs font-semibold text-gray-600">Тэмдэглэл</label>
                <textarea
                  value={createForm.notes}
                  onChange={(e) => setCreateForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  className="w-full rounded-apple border border-gray-200 px-3 py-2.5 text-base outline-none focus:border-[#0071E3] focus:ring-2 focus:ring-[#0071E3]/15 sm:text-sm"
                  placeholder="Нэмэлт тэмдэглэл..."
                />
              </div>
            </div>

            <div className="flex flex-col-reverse gap-2 border-t border-gray-100 px-5 py-3 sm:flex-row sm:justify-end sm:px-6">
              <button
                onClick={() => setShowCreateModal(false)}
                className="h-11 rounded-apple border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50 active:bg-gray-100"
              >
                Болих
              </button>
              <button
                onClick={createOrder}
                disabled={creating}
                className="inline-flex h-11 items-center justify-center gap-2 rounded-apple bg-[#0071E3] px-4 text-sm font-semibold text-white shadow-sm hover:bg-[#005BB5] active:bg-[#004aad] disabled:opacity-50"
              >
                {creating && <RefreshCw size={14} className="animate-spin" />}
                Үүсгэх
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═════════════════════════════════════════════════════════════
           RECEIVE MODAL — Ачигдсан бараа + Ирсэн тоо оруулах
         ═════════════════════════════════════════════════════════════ */}
      {receiveTarget && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4">
          <div className="w-full max-w-4xl max-h-[92vh] overflow-hidden rounded-t-2xl bg-white shadow-xl sm:rounded-apple flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                  <Truck size={20} />
                </div>
                <div>
                  <div className="text-base font-semibold text-gray-900">
                    {receiveTarget.vehicle_name ?? "Машин"}
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-gray-500">
                    {receiveTarget.shipments.map((sh) => (
                      <span key={sh.id}>
                        Захиалга #{sh.purchase_order_id} · {sh.order_date?.replaceAll("-", "/")}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
              <button
                onClick={() => setReceiveTarget(null)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
              >
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {receiveLoading ? (
                <div className="flex items-center justify-center py-16">
                  <RefreshCw size={20} className="animate-spin text-gray-400" />
                </div>
              ) : receiveLines.length === 0 ? (
                <div className="py-16 text-center text-sm text-gray-400">
                  Бараа байхгүй
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 z-10">
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                      <th className="px-3 py-2.5 font-medium">Код</th>
                      <th className="px-3 py-2.5 font-medium">Нэр</th>
                      <th className="px-3 py-2.5 font-medium">Бренд</th>
                      {receiveTarget.order_count > 1 && (
                        <th className="px-3 py-2.5 font-medium">Захиалга</th>
                      )}
                      <th className="px-3 py-2.5 font-medium text-right">Ачигдсан</th>
                      <th className="px-3 py-2.5 font-medium text-right">Ирсэн тоо</th>
                      <th className="px-3 py-2.5 font-medium text-right">Зөрүү</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {receiveLines.map((l) => {
                      const recVal = parseFloat(receivedDraft[l.id] || "0") || 0;
                      const diff = l.loaded_qty_box - recVal;
                      const hasDiff = Math.abs(diff) > 0.0001;
                      return (
                        <tr key={l.id} className={hasDiff ? "bg-amber-50/50" : ""}>
                          <td className="px-3 py-2 text-xs text-gray-500 font-mono">{l.item_code}</td>
                          <td className="px-3 py-2 text-xs text-gray-800">{l.name}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{l.brand || "—"}</td>
                          {receiveTarget.order_count > 1 && (
                            <td className="px-3 py-2 text-xs text-gray-400">#{(l as any).order_id}</td>
                          )}
                          <td className="px-3 py-2 text-right text-xs font-semibold text-gray-700">
                            {l.loaded_qty_box.toFixed(0)}
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="0.01"
                              value={receivedDraft[l.id] ?? ""}
                              onChange={(e) =>
                                setReceivedDraft((d) => ({ ...d, [l.id]: e.target.value }))
                              }
                              className="w-20 rounded border border-gray-200 px-2 py-1 text-right text-xs outline-none focus:border-[#0071E3]"
                            />
                          </td>
                          <td className={`px-3 py-2 text-right text-xs font-semibold ${
                            !hasDiff ? "text-gray-300" : diff > 0 ? "text-red-600" : "text-blue-600"
                          }`}>
                            {hasDiff ? (diff > 0 ? `-${diff.toFixed(0)}` : `+${(-diff).toFixed(0)}`) : "0"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Footer */}
            <div className="border-t border-gray-100 px-5 py-3 bg-gray-50">
              <div className="flex items-center justify-between gap-2">
                <div className="text-xs text-gray-500">
                  Зөвхөн <strong>ирсэн тоо</strong> хадгалагдана. Захиалгын бусад мэдээлэл өөрчлөгдөхгүй.
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setReceiveTarget(null)}
                    className="rounded-apple border border-gray-200 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    Хаах
                  </button>
                  <button
                    onClick={saveReceived}
                    disabled={receiveSaving || receiveLoading}
                    className="inline-flex items-center gap-1.5 rounded-apple bg-[#0071E3] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                  >
                    {receiveSaving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
                    Хадгалах
                  </button>
                  {isAdmin && (
                    <button
                      onClick={advanceFromReceiveModal}
                      disabled={receiveSaving || receiveLoading}
                      className="inline-flex items-center gap-1.5 rounded-apple bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                    >
                      {receiveSaving ? <RefreshCw size={13} className="animate-spin" /> : <ArrowRight size={13} />}
                      Нягтлан руу
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
}
