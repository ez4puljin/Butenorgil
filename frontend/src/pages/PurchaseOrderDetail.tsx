import { useEffect, useRef, useState, Fragment } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  ChevronLeft, RefreshCw, CheckCircle2, Save, FileDown,
  Trash2, Plus, Search, X, Package, AlertCircle, CheckCheck,
  Truck, RotateCcw, ChevronDown, ChevronUp,
} from "lucide-react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/authStore";
import {
  usePurchaseOrderStore,
  STATUS_SEQUENCE,
  STATUS_LABEL,
  STATUS_COLOR,
} from "../store/purchaseOrderStore";
import PDFExportModal from "../components/PDFExportModal";
import ERPExcelModal from "../components/ERPExcelModal";

export default function PurchaseOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const brandFilter = searchParams.get("brand");
  const brandMode = !!brandFilter;
  const { role } = useAuthStore();
  const store = usePurchaseOrderStore();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [showPDFModal, setShowPDFModal] = useState(false);
  const [showERPModal, setShowERPModal] = useState(false);

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

  const order = store.currentOrder;

  // Loading/transit/arrived status-т shipments ачаална
  useEffect(() => {
    if (order && ["loading", "transit", "arrived", "accounting", "confirmed", "received"].includes(effectiveStatus)) {
      loadShipments();
    }
  }, [order?.status, order?.id]);

  useEffect(() => {
    if (role === "admin" || role === "manager") {
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

  const canEdit = (() => {
    if (!order) return false;
    const st = effectiveStatus;
    if (role === "warehouse_clerk")
      return st === "preparing" || st === "arrived";
    if (role === "accountant")
      return st === "accounting";
    if (role === "manager" || role === "supervisor")
      return ["preparing", "reviewing", "loading", "accounting"].includes(st);
    if (role === "admin")
      return true;
    return false;
  })();

  const saveLines = async () => {
    if (!order) return;
    setSaving(true);
    try {
      const payload = order.lines.map((l) => ({
        product_id: l.product_id,
        order_qty_box: store.quantities[l.product_id] ?? 0,
        supplier_qty_box: suppQtys[l.product_id] ?? l.supplier_qty_box,
        loaded_qty_box: loadedQtys[l.product_id] ?? l.loaded_qty_box,
        received_qty_box: receivedQtys[l.product_id] ?? l.received_qty_box,
        received_qty_extra_pcs: receivedExtraPcs[l.product_id] ?? l.received_qty_extra_pcs ?? 0,
        unit_price: priceInputs[l.product_id] ?? l.unit_price ?? 0,
        remark: remarkInputs[l.product_id] ?? l.remark ?? "",
      }));
      await api.post(`/purchase-orders/${order.id}/set-lines`, payload);
      if (effectiveStatus === "loading" && Object.keys(brandVehicles).length > 0) {
        const bvPayload = Object.entries(brandVehicles).map(([brand, vehicle_id]) => ({ brand, vehicle_id: vehicle_id ?? null }));
        await api.post(`/purchase-orders/${order.id}/brand-vehicles`, bvPayload);
      }
      flash("Хадгалагдлаа");
      await loadOrder();
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

  const advanceStatus = async () => {
    if (!order) return;
    setAdvancing(true);
    try {
      if (brandMode && brandFilter) {
        await api.patch(`/purchase-orders/${order.id}/brand-advance`, null, { params: { brand: brandFilter } });
        flash(`${brandFilter} — Статус шинэчлэгдлээ`);
      } else {
        await api.patch(`/purchase-orders/${order.id}/status`);
        flash("Статус шинэчлэгдлээ");
      }
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
    } finally {
      setAdvancing(false);
    }
  };

  const forceStatus = async (newStatus: string) => {
    if (!order) return;
    setShowStatusDropdown(false);
    try {
      const params = brandMode && brandFilter ? { brand: brandFilter } : undefined;
      await api.patch(`/purchase-orders/${order.id}/force-status`, { status: newStatus }, { params });
      flash(brandMode && brandFilter ? `${brandFilter} — Статус шинэчлэгдлээ` : "Статус шинэчлэгдлээ");
      await loadOrder();
    } catch (e: any) {
      flash(e?.response?.data?.detail ?? "Алдаа гарлаа", false);
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
      await api.post(`/purchase-orders/${order.id}/revert`);
      flash("Статус буцлаа");
      await loadOrder();
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
    if (role === "warehouse_clerk") return false;
    if (role === "accountant") return st === "accounting" || st === "confirmed";
    if (role === "manager" || role === "supervisor" || role === "admin") return true;
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
  const isEnteringQty = role === "warehouse_clerk" && effectiveStatus === "preparing";

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

  const showStockCols = ["preparing", "reviewing"].includes(effectiveStatus);
  const showEstCostCols = ["preparing", "reviewing", "sending"].includes(effectiveStatus);
  const showLoadingCols = effectiveStatus === "loading";
  const showTransitCols = effectiveStatus === "transit";
  const showReceivedCols = ["arrived", "accounting", "confirmed", "received"].includes(effectiveStatus);
  const showPriceCols = ["accounting", "confirmed", "received"].includes(effectiveStatus);
  const showPriceDiff = effectiveStatus === "accounting";

  const colCount = (() => {
    const base = showStockCols ? 9 : 7;
    let total;
    if (showEstCostCols) total = base + 2;
    else if (showLoadingCols) total = base + 2;
    else if (showTransitCols) total = base - 1 + 1;
    else if (showReceivedCols) total = base + 4 + (showPriceCols ? (showPriceDiff ? 4 : 3) : 0);
    else total = base;
    return total + 1; // +1 for Машин column
  })();

  // ── Loading skeleton ──
  if (loading && !order) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-32 text-gray-400">
        <RefreshCw size={22} className="animate-spin text-[#0071E3]" />
        <span className="text-sm">Уншиж байна...</span>
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
            className={`fixed left-3 right-3 top-3 z-50 flex items-center gap-2.5 rounded-xl px-4 py-3 shadow-lg text-sm font-medium sm:left-auto sm:right-5 sm:top-5 sm:max-w-sm ${
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
            {effectiveStatus === "sending" && (
              <button
                onClick={() => setShowPDFModal(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 active:bg-gray-100 transition-colors"
              >
                <FileDown size={13} />
                PDF татах
              </button>
            )}
            {(role === "accountant" || role === "admin") && effectiveStatus === "accounting" && (
              <button
                onClick={revertStatus}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-3 text-xs font-medium text-amber-700 shadow-sm hover:bg-amber-100 active:bg-amber-200 transition-colors"
              >
                <RotateCcw size={13} />
                Ачаа ирсэн рүү буцаах
              </button>
            )}
            {effectiveStatus === "confirmed" && (
              <>
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
                <button
                  onClick={() => setShowERPModal(true)}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-blue-50 px-3 text-xs font-medium text-blue-700 shadow-sm hover:bg-blue-100 active:bg-blue-200 transition-colors"
                >
                  <FileDown size={13} />
                  ERP Импорт
                </button>
              </>
            )}
            {role === "admin" && (
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
                        className={`w-full text-left px-3 py-2 text-xs hover:bg-gray-50 transition-colors ${order.status === st ? "font-semibold text-[#0071E3] bg-blue-50" : "text-gray-700"}`}
                      >
                        {STATUS_LABEL[st as keyof typeof STATUS_LABEL]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {role === "admin" && (
              <button
                onClick={() => setShowDeleteConfirm(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 text-xs font-medium text-red-600 shadow-sm hover:bg-red-100 active:bg-red-200 transition-colors"
              >
                <Trash2 size={13} />
                Устгах
              </button>
            )}
            {canAdvance() && (
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

      {/* ── Shipment Panel (loading+) ── */}
      {order && ["loading", "transit", "arrived", "accounting", "confirmed", "received"].includes(effectiveStatus) && (
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
                  const canEdit = sh.status === "loading" && (role === "admin" || role === "supervisor" || role === "manager");
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
                          {sh.status === "loading" && sh.line_count > 0 && (role === "admin" || role === "supervisor" || role === "manager") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Замд гарлаа"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-blue-500 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 active:bg-blue-700 transition-colors">Замд гаргах</button>
                          )}
                          {sh.status === "transit" && (role === "admin" || role === "supervisor" || role === "warehouse_clerk") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Ачаа ирсэн"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-emerald-500 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-600 active:bg-emerald-700 transition-colors">Ирсэн</button>
                          )}
                          {sh.status === "arrived" && (role === "admin" || role === "supervisor" || role === "warehouse_clerk") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Нягтлан руу шилжлээ"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-violet-500 px-3 py-2 text-xs font-semibold text-white hover:bg-violet-600 active:bg-violet-700 transition-colors">Нягтлан руу</button>
                          )}
                          {(sh.status === "accounting" || sh.status === "confirmed") && (role === "admin" || role === "accountant") && (
                            <button onClick={async () => { try { await api.patch(`/purchase-orders/${order.id}/shipments/${sh.id}/advance`); await loadShipments(); await loadOrder(); flash("Статус шилжлээ"); } catch (e: any) { flash(e?.response?.data?.detail ?? "Алдаа", false); } }}
                              className="rounded-lg bg-green-600 px-3 py-2 text-xs font-semibold text-white hover:bg-green-700 active:bg-green-800 transition-colors">{sh.status === "accounting" ? "Баталгаажуулах" : "Орлого авах"}</button>
                          )}
                          {sh.status === "loading" && (role === "admin" || role === "supervisor") && (
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
      <div className="mt-3 overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-100">

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
            {(effectiveStatus === "preparing" || effectiveStatus === "loading") &&
              (role === "manager" || role === "admin" || role === "supervisor") && (
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
                      <th className="px-2 py-2.5 text-right text-xs font-semibold text-gray-500 md:px-4">Нөөц</th>
                      <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Борлуулалт</th>
                    </>
                  )}
                  <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Нэгж жин</th>
                  <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Хайрцаг/ш</th>
                  {!showTransitCols && (
                    <th className="w-20 px-2 py-2.5 text-right text-xs font-semibold text-gray-500 md:w-28 md:px-4">
                      {showReceivedCols ? "Захиалсан" : "Захиалах"}
                    </th>
                  )}
                  {showEstCostCols && (
                    <>
                      <th className="hidden w-28 px-4 py-2.5 text-right text-xs font-semibold text-indigo-500 md:table-cell">Нэгж үнэ</th>
                      <th className="hidden w-32 px-4 py-2.5 text-right text-xs font-semibold text-indigo-600 md:table-cell">Тооцоолсон дүн</th>
                    </>
                  )}
                  {showLoadingCols && (
                    <>
                      <th className="w-20 px-2 py-2.5 text-right text-xs font-semibold text-orange-500 md:w-28 md:px-4">Ачигдсан</th>
                      <th className="w-8 px-2 py-2.5" />
                    </>
                  )}
                  {showTransitCols && (
                    <th className="w-20 px-2 py-2.5 text-right text-xs font-semibold text-orange-500 md:w-28 md:px-4">Ачигдсан</th>
                  )}
                  {showReceivedCols && (
                    <>
                      <th className="hidden w-24 px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Ачигдсан</th>
                      <th className="w-40 px-2 py-2.5 text-right text-xs font-semibold text-teal-600 md:px-4">Ирсэн (х × ш)</th>
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
                  <th className="hidden px-4 py-2.5 text-xs font-semibold text-sky-600 md:table-cell">Машин</th>
                  <th className="hidden px-4 py-2.5 text-right text-xs font-semibold text-gray-500 md:table-cell">Жин (кг)</th>
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
                          {effectiveStatus === "loading" && (role === "manager" || role === "admin" || role === "supervisor") && (
                            <button
                              onClick={() => openAddExtra(brand)}
                              className="ml-auto inline-flex items-center gap-1 rounded-md border border-amber-200 bg-white px-2 py-0.5 text-[10px] font-semibold text-amber-600 hover:bg-amber-50 transition-colors"
                            >
                              <Plus size={10} /> Нэмэлт мөр
                            </button>
                          )}
                          {role === "admin" && (effectiveStatus === "preparing" || effectiveStatus === "loading") && (
                            <button
                              onClick={() => openCrossBrand(brand)}
                              className={`${effectiveStatus === "loading" && (role === "admin") ? "" : "ml-auto"} inline-flex items-center gap-1 rounded-md border border-violet-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-violet-600 hover:bg-violet-50 transition-colors`}
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
                              <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.sales_qty.toFixed(0)}</td>
                            </>
                            );
                          })()}
                          <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.unit_weight.toFixed(3)}</td>
                          <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{l.pack_ratio}</td>
                          {!showTransitCols && (
                            <td className="px-2 py-2 text-right md:px-4">
                              {canEdit && !showReceivedCols ? (
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

                          {/* Transit: ачигдсан тоо read-only */}
                          {showTransitCols && (
                            <td className="px-2 py-2 text-right text-xs font-semibold tabular-nums text-orange-600 md:px-4 md:py-2.5">
                              {(l.loaded_qty_box ?? 0) > 0
                                ? (l.loaded_qty_box ?? 0).toFixed(0)
                                : <span className="text-gray-300">—</span>}
                            </td>
                          )}

                          {/* Loading: loaded only */}
                          {showLoadingCols && (
                            <>
                              <td className="px-2 py-2 text-right md:px-4">
                                {(role === "manager" || role === "admin" || role === "supervisor") ? (
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
                                  <span className="text-xs tabular-nums text-gray-600">{(loadedQtys[l.product_id] ?? 0).toFixed(0)}</span>
                                )}
                              </td>
                              <td className="px-2 py-2 text-center">
                                <button
                                  onClick={() => deleteLine(l.line_id)}
                                  className="rounded-lg p-1.5 text-gray-300 opacity-0 transition-all group-hover:opacity-100 hover:bg-red-50 hover:text-red-500"
                                  title="Мөр устгах"
                                >
                                  <Trash2 size={13} />
                                </button>
                              </td>
                            </>
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
                            const canEditReceived = (role === "warehouse_clerk" || role === "admin") && effectiveStatus === "arrived";
                            return (
                              <>
                                <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-500 md:table-cell">{loaded.toFixed(0)}</td>
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
                            const canEditPrice = (role === "accountant" || role === "admin" || role === "manager" || role === "supervisor") && effectiveStatus === "accounting";
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
                          {/* Жин (кг) — хамгийн сүүлийн багана */}
                          <td className="hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums text-gray-700 md:table-cell">
                            {rowWeight > 0 ? rowWeight.toFixed(2) : <span className="text-gray-300">—</span>}
                          </td>
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
                        <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-400 md:table-cell">{el.unit_weight.toFixed(3)}</td>
                        <td className="hidden px-4 py-2.5 text-right text-xs tabular-nums text-gray-400 md:table-cell">{el.pack_ratio}</td>
                        <td className="px-2 py-2 text-right md:px-4">
                          <span className="text-xs font-semibold tabular-nums text-amber-700">{el.qty_box.toFixed(0)}</span>
                        </td>
                        {showLoadingCols && (
                          <>
                            <td className="hidden md:table-cell"/>
                            <td className="px-2 py-2 text-right">
                              {(role === "manager" || role === "admin" || role === "supervisor") && (
                                <div className="flex items-center justify-end gap-1 opacity-60 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                                  <button onClick={() => openEditExtra(el)} className="rounded p-1 text-amber-400 hover:bg-amber-100 hover:text-amber-600" title="Засах">
                                    <RefreshCw size={12} />
                                  </button>
                                  <button onClick={() => deleteExtraLine(el.id)} className="rounded p-1 text-gray-300 hover:bg-red-50 hover:text-red-500" title="Устгах">
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              )}
                            </td>
                          </>
                        )}
                        {showEstCostCols && <><td className="hidden md:table-cell"/><td className="hidden md:table-cell"/></>}
                        {showReceivedCols && <><td className="hidden md:table-cell"/><td/><td className="hidden md:table-cell"/><td className="hidden md:table-cell"/></>}
                        {showPriceCols && <><td className="hidden md:table-cell"/><td/><td className="hidden md:table-cell"/>{showPriceDiff && <td className="hidden md:table-cell"/>}</>}
                        <td className="hidden md:table-cell"/>
                        <td className="hidden px-4 py-2.5 text-right text-xs font-semibold tabular-nums text-amber-600 md:table-cell">{el.computed_weight.toFixed(2)}</td>
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
      {crossBrandTarget && role === "admin" && (
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

    </motion.div>
  );
}
