import { useState, useEffect, useMemo, useRef } from "react";
import { X, Zap, RefreshCw, Truck, AlertTriangle, ChevronRight, Package } from "lucide-react";
import { api } from "../lib/api";
import type { Vehicle } from "../store/logisticsStore";
import type { POLine } from "../store/purchaseOrderStore";

interface Props {
  orderId: number;
  orderDate: string;
  lines: POLine[];
  quantities: Record<number, number>; // live edit buffer
  onClose: () => void;
  onAdvance: () => void; // called after optional shipment save; parent advances status
}

function FillBar({ pct }: { pct: number }) {
  const color =
    pct > 95 ? "bg-blue-500" : pct >= 70 ? "bg-emerald-500" : "bg-amber-400";
  return (
    <div className="h-2 w-full rounded-full bg-gray-100">
      <div
        className={`h-2 rounded-full transition-all ${color}`}
        style={{ width: `${Math.min(pct, 100)}%` }}
      />
    </div>
  );
}

export default function LogisticsOptModal({
  orderDate,
  lines,
  quantities,
  onClose,
  onAdvance,
}: Props) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loadingVehicles, setLoadingVehicles] = useState(true);
  const [selectedVehicleIds, setSelectedVehicleIds] = useState<Set<number>>(new Set());
  const [assignments, setAssignments] = useState<Record<string, number | null>>({});
  const [optimizing, setOptimizing] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [unassignedBrands, setUnassignedBrands] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  // Compute brand weights from order lines using live quantities
  const brandWeights = useMemo(() => {
    const map: Record<string, number> = {};
    for (const l of lines) {
      const qBox = quantities[l.product_id] ?? l.order_qty_box;
      if (qBox <= 0) continue;
      const raw = (l.brand || "").trim();
      const brand = raw && raw.toLowerCase() !== "nan" ? raw : "Брэнд байхгүй";
      const weight = qBox * l.pack_ratio * l.unit_weight;
      map[brand] = (map[brand] ?? 0) + weight;
    }
    return map;
  }, [lines, quantities]);

  const brandList = useMemo(
    () => Object.entries(brandWeights).sort((a, b) => b[1] - a[1]),
    [brandWeights]
  );

  const totalWeight = brandList.reduce((s, [, w]) => s + w, 0);

  useEffect(() => {
    api
      .get("/logistics/vehicles")
      .then((res) => {
        setVehicles(res.data);
        const activeIds = new Set<number>(
          (res.data as Vehicle[]).filter((v) => v.is_active).map((v) => v.id)
        );
        setSelectedVehicleIds(activeIds);
      })
      .finally(() => setLoadingVehicles(false));
  }, []);

  const activeVehicles = vehicles.filter((v) => v.is_active);

  const runOptimize = async () => {
    if (selectedVehicleIds.size === 0) {
      setError("Машин сонгоно уу");
      return;
    }
    setOptimizing(true);
    setError(null);
    try {
      const res = await api.post("/logistics/optimize", {
        brand_weights: brandWeights,
        vehicle_ids: Array.from(selectedVehicleIds),
      });
      const result = res.data;
      const newAssignments: Record<string, number | null> = {};
      for (const v of result.vehicles) {
        for (const b of v.brands) {
          newAssignments[b.brand] = v.vehicle_id;
        }
      }
      for (const b of result.unassigned_brands) {
        newAssignments[b.brand] = null;
      }
      setAssignments(newAssignments);
      setUnassignedBrands(result.unassigned_brands.map((b: { brand: string }) => b.brand));
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Алдаа гарлаа");
    } finally {
      setOptimizing(false);
    }
  };

  // Per-vehicle load from current assignments
  const vehicleLoadMap = useMemo(() => {
    const map: Record<number, number> = {};
    for (const [brand, vehicleId] of Object.entries(assignments)) {
      if (!vehicleId) continue;
      map[vehicleId] = (map[vehicleId] ?? 0) + (brandWeights[brand] ?? 0);
    }
    return map;
  }, [assignments, brandWeights]);

  const handleAdvance = async () => {
    setAdvancing(true);
    setError(null);

    // Save shipments if there are assignments
    const vehicleGroups: Record<number, { brand: string; weight: number }[]> = {};
    for (const [brand, vehicleId] of Object.entries(assignments)) {
      if (!vehicleId) continue;
      if (!vehicleGroups[vehicleId]) vehicleGroups[vehicleId] = [];
      vehicleGroups[vehicleId].push({ brand, weight: brandWeights[brand] ?? 0 });
    }

    if (Object.keys(vehicleGroups).length > 0) {
      try {
        await Promise.all(
          Object.entries(vehicleGroups).map(([vehicleId, brands]) =>
            api.post("/logistics/shipments", {
              vehicle_id: Number(vehicleId),
              assignments: brands.map((b) => ({
                brand: b.brand,
                allocated_weight: b.weight,
                supplier_id: null,
              })),
            })
          )
        );
      } catch (e: any) {
        setError(
          "Ачааны оновчлол хадгалахад алдаа гарлаа: " +
            (e?.response?.data?.detail ?? "дахин оролдоно уу")
        );
        setAdvancing(false);
        return;
      }
    }

    setAdvancing(false);
    onClose();
    onAdvance();
  };

  return (
    <div
      ref={backdropRef}
      onClick={(e) => e.target === backdropRef.current && onClose()}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
    >
      <div className="w-full max-w-3xl max-h-[90vh] flex flex-col rounded-2xl bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <Truck size={18} className="text-[#0071E3]" />
            <h2 className="text-base font-semibold text-gray-900">
              Ачааны оновчлол — {orderDate}
            </h2>
          </div>
          <button onClick={onClose} className="rounded-full p-1 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          <div className="grid grid-cols-2 divide-x divide-gray-100">
            {/* Left: brands + vehicles + optimize */}
            <div className="p-5 space-y-4">
              {/* Brand weights */}
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Захиалагдсан брэндүүд ({totalWeight.toFixed(0)} кг)
                </div>
                {brandList.length === 0 ? (
                  <div className="rounded-apple bg-amber-50 p-3 text-xs text-amber-700">
                    Захиалсан бараа байхгүй байна
                  </div>
                ) : (
                  <div className="max-h-52 overflow-auto space-y-1">
                    {brandList.map(([brand, weight]) => (
                      <div key={brand} className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-gray-800">{brand}</div>
                          <div className="text-xs text-gray-400">{weight.toFixed(1)} кг</div>
                        </div>
                        <select
                          value={assignments[brand] ?? ""}
                          onChange={(e) =>
                            setAssignments((a) => ({
                              ...a,
                              [brand]: e.target.value ? Number(e.target.value) : null,
                            }))
                          }
                          className="min-w-[110px] rounded border border-gray-200 px-2 py-1 text-xs outline-none focus:border-[#0071E3]"
                        >
                          <option value="">— Хуваарилаагүй —</option>
                          {activeVehicles.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Vehicle checkboxes */}
              <div>
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Хуваарилах машинууд
                </div>
                {loadingVehicles ? (
                  <div className="flex items-center gap-1 text-xs text-gray-400">
                    <RefreshCw size={12} className="animate-spin" /> Ачаалж байна...
                  </div>
                ) : activeVehicles.length === 0 ? (
                  <div className="rounded-apple bg-amber-50 p-3 text-xs text-amber-700">
                    Идэвхтэй машин байхгүй. Логистик цэсээс машин нэмнэ үү.
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {activeVehicles.map((v) => (
                      <label key={v.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={selectedVehicleIds.has(v.id)}
                          onChange={(e) => {
                            const next = new Set(selectedVehicleIds);
                            if (e.target.checked) next.add(v.id);
                            else next.delete(v.id);
                            setSelectedVehicleIds(next);
                          }}
                          className="rounded"
                        />
                        <span className="text-gray-700">{v.name}</span>
                        <span className="text-gray-400">({v.capacity_kg.toLocaleString()}кг)</span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Auto-optimize button */}
              <button
                onClick={runOptimize}
                disabled={optimizing || brandList.length === 0 || activeVehicles.length === 0}
                className="inline-flex w-full items-center justify-center gap-2 rounded-apple bg-[#0071E3] py-2 text-sm text-white hover:opacity-90 disabled:opacity-50"
              >
                {optimizing ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Zap size={14} />
                )}
                Автоматаар хуваарилах
              </button>

              {/* Unassigned warning */}
              {unassignedBrands.length > 0 && (
                <div className="flex items-start gap-2 rounded-apple bg-amber-50 p-3">
                  <AlertTriangle size={14} className="mt-0.5 shrink-0 text-amber-500" />
                  <div className="text-xs text-amber-800">
                    <strong>Машинд багтаагүй:</strong> {unassignedBrands.join(", ")}
                  </div>
                </div>
              )}
            </div>

            {/* Right: vehicle load visualization */}
            <div className="p-5">
              <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Машины ачаалал
              </div>
              {activeVehicles.length === 0 ? (
                <div className="flex flex-col items-center py-10 text-gray-400">
                  <Package size={28} className="mb-2 opacity-40" />
                  <span className="text-xs">Машин байхгүй</span>
                </div>
              ) : (
                <div className="space-y-3">
                  {activeVehicles.map((v) => {
                    const load = vehicleLoadMap[v.id] ?? 0;
                    const pct = v.capacity_kg > 0 ? (load / v.capacity_kg) * 100 : 0;
                    const assignedBrands = brandList.filter(
                      ([brand]) => assignments[brand] === v.id
                    );
                    return (
                      <div key={v.id} className="rounded-apple border border-gray-100 p-3">
                        <div className="mb-1.5 flex items-start justify-between">
                          <div>
                            <div className="text-sm font-semibold text-gray-900">{v.name}</div>
                            {v.plate && (
                              <div className="text-xs text-gray-400">{v.plate}</div>
                            )}
                          </div>
                          <div className="text-right">
                            <div className="text-xs font-bold text-gray-900">
                              {load.toFixed(0)} / {v.capacity_kg.toLocaleString()} кг
                            </div>
                            <div className="text-xs text-gray-400">{pct.toFixed(1)}%</div>
                          </div>
                        </div>
                        <FillBar pct={pct} />
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {assignedBrands.map(([brand, weight]) => (
                            <span
                              key={brand}
                              className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700"
                            >
                              {brand} ({weight.toFixed(0)}кг)
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        {error && (
          <div className="mx-6 mb-2 rounded-apple bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 border-t border-gray-100 px-6 py-4 shrink-0">
          <button
            onClick={onClose}
            className="rounded-apple border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Болих
          </button>
          <button
            onClick={handleAdvance}
            disabled={advancing}
            className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {advancing ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <ChevronRight size={14} />
            )}
            Захиалга илгээх
          </button>
        </div>
      </div>
    </div>
  );
}
