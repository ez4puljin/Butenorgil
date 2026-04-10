import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Download, Pencil, Building2, Truck, AlertCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { useSupervisorStore } from "../store/supervisorStore";

type BrandSummary = {
  brand: string;
  computedSum: number;
  hasMissingWeight: boolean;
  lineCount: number;
};

export default function OrderSupervisor() {
  const {
    lines, setLines, brandOverride, setBrandOverride,
    supplierGroups, unmappedBrands, supplierFilter,
    setSupplierData, setSupplierFilter,
  } = useSupervisorStore();

  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"brand" | "supplier">("brand");

  // Load brand lines
  const loadBrands = async () => {
    setLoading(true);
    try {
      const res = await api.get("/orders/supervisor", { params: { status: "submitted" } });
      setLines(res.data.lines);
    } finally {
      setLoading(false);
    }
  };

  // Load supplier view
  const loadSuppliers = async () => {
    setLoading(true);
    try {
      const res = await api.get("/orders/supervisor/by-supplier", { params: { status: "submitted" } });
      setSupplierData(res.data.suppliers, res.data.unmapped_brands);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBrands();
  }, []);

  useEffect(() => {
    if (tab === "supplier") loadSuppliers();
  }, [tab]);

  const brandSummaries: BrandSummary[] = useMemo(() => {
    const map = new Map<string, { sum: number; missing: boolean; n: number }>();
    for (const l of lines) {
      const cur = map.get(l.brand) ?? { sum: 0, missing: false, n: 0 };
      cur.sum += l.computedWeight ?? 0;
      cur.n += 1;
      if (!l.unitWeight || l.unitWeight <= 0) cur.missing = true;
      map.set(l.brand, cur);
    }
    return Array.from(map.entries()).map(([brand, v]) => ({
      brand,
      computedSum: v.sum,
      hasMissingWeight: v.missing,
      lineCount: v.n,
    }));
  }, [lines]);

  const finalWeightByBrand = (brand: string, computedSum: number) => {
    const ov = brandOverride[brand];
    if (ov !== undefined && ov !== null && !Number.isNaN(ov) && ov > 0) return ov;
    return computedSum;
  };

  const onExport = async () => {
    const payload = { overrides: brandOverride };
    const res = await api.post("/reports/export", payload, { responseType: "blob" });
    const url = window.URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = "negdsen_zahialga.xlsx";
    a.click();
    window.URL.revokeObjectURL(url);
  };

  // Supplier filter options
  const filteredGroups = supplierFilter
    ? supplierGroups.filter((g) => g.supplier_id === supplierFilter)
    : supplierGroups;

  return (
    <div className="min-h-screen bg-[#F5F5F7] p-1">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold text-gray-900">Нэгтгэсэн захиалга</h1>
          <button
            onClick={onExport}
            className="inline-flex items-center gap-2 rounded-apple bg-[#0071E3] px-4 py-2 text-white shadow-sm hover:opacity-95"
          >
            <Download size={18} />
            Эцсийн файл татах
          </button>
        </div>

        {/* Tabs */}
        <div className="mt-5 flex gap-1 rounded-apple bg-gray-100 p-1 w-fit">
          {(
            [
              { key: "brand",    label: "Брэндээр",      icon: Download },
              { key: "supplier", label: "Нийлүүлэгчээр", icon: Building2 },
            ] as const
          ).map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 rounded-apple px-4 py-2 text-sm font-medium transition-colors ${
                tab === key
                  ? "bg-white text-gray-900 shadow-sm"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>

        {/* ── Brand view ── */}
        {tab === "brand" && (
          <>
            <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {brandSummaries.map((b) => {
                const finalW = finalWeightByBrand(b.brand, b.computedSum);
                return (
                  <div key={b.brand} className="rounded-apple bg-white p-5 shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-gray-500">Брэнд</div>
                        <div className="text-lg font-semibold text-gray-900">{b.brand}</div>
                        <div className="mt-1 text-sm text-gray-500">{b.lineCount} мөр</div>
                      </div>
                      <div
                        className={`rounded-full px-3 py-1 text-xs ${
                          b.hasMissingWeight
                            ? "bg-amber-50 text-amber-700"
                            : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {b.hasMissingWeight ? "Жин дутуу" : "Хэвийн"}
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-apple bg-[#F5F5F7] p-3">
                        <div className="text-xs text-gray-500">Авто нийлбэр</div>
                        <div className="text-lg font-semibold">{b.computedSum.toFixed(2)} кг</div>
                      </div>
                      <div className="rounded-apple bg-[#F5F5F7] p-3">
                        <div className="text-xs text-gray-500">Эцсийн дүн</div>
                        <div className="text-lg font-semibold">{finalW.toFixed(2)} кг</div>
                      </div>
                    </div>

                    <div className="mt-4">
                      <label className="text-xs text-gray-500">Гараар засах (эцсийн жин)</label>
                      <div className="mt-2 flex items-center gap-2">
                        <div className="relative flex-1">
                          <Pencil
                            size={16}
                            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                          />
                          <input
                            value={brandOverride[b.brand] ?? ""}
                            onChange={(e) => setBrandOverride(b.brand, Number(e.target.value))}
                            placeholder="ж: 1250.5"
                            className="w-full rounded-apple border border-gray-200 bg-white py-2 pl-9 pr-3 outline-none focus:border-[#0071E3]"
                            inputMode="decimal"
                          />
                        </div>
                        <button
                          onClick={() => setBrandOverride(b.brand, 0)}
                          className="rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
                        >
                          Цэвэрлэх
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-8 rounded-apple bg-white p-5 shadow-sm">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-lg font-semibold text-gray-900">Илгээгдсэн мөрүүд</div>
                {loading && <div className="text-sm text-gray-500">Уншиж байна...</div>}
              </div>

              <div className="max-h-[520px] overflow-auto rounded-apple border border-gray-100">
                <table className="min-w-[1100px] w-full text-sm">
                  <thead className="sticky top-0 bg-white shadow-sm">
                    <tr className="text-left text-gray-500">
                      <th className="sticky left-0 bg-white px-4 py-3">Код</th>
                      <th className="sticky left-[140px] bg-white px-4 py-3">Нэр</th>
                      <th className="px-4 py-3">Агуулах</th>
                      <th className="px-4 py-3">Брэнд</th>
                      <th className="px-4 py-3">Нэгж жин</th>
                      <th className="px-4 py-3">Тоо (хайрцаг)</th>
                      <th className="px-4 py-3">Тоо (ш)</th>
                      <th className="px-4 py-3">Авто жин</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {lines.map((l, idx) => (
                      <tr key={idx} className="text-gray-900">
                        <td className="sticky left-0 bg-white px-4 py-3">{l.itemCode}</td>
                        <td className="sticky left-[140px] bg-white px-4 py-3">{l.name}</td>
                        <td className="px-4 py-3">{l.warehouseTagId}</td>
                        <td className="px-4 py-3">{l.brand}</td>
                        <td className="px-4 py-3">{(l.unitWeight ?? 0).toFixed(3)}</td>
                        <td className="px-4 py-3">{(l.orderQtyBox ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-3">{(l.orderQtyPcs ?? 0).toFixed(2)}</td>
                        <td className="px-4 py-3">{(l.computedWeight ?? 0).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </>
        )}

        {/* ── Supplier view ── */}
        {tab === "supplier" && (
          <div className="mt-5">
            {loading && (
              <p className="text-sm text-gray-400">Уншиж байна...</p>
            )}

            {/* Filter */}
            {supplierGroups.length > 0 && (
              <div className="mb-4 flex items-center gap-3">
                <label className="text-sm text-gray-500">Нийлүүлэгч:</label>
                <select
                  value={supplierFilter ?? ""}
                  onChange={(e) => setSupplierFilter(e.target.value ? Number(e.target.value) : null)}
                  className="rounded-apple border border-gray-200 px-3 py-1.5 text-sm outline-none focus:border-[#0071E3]"
                >
                  <option value="">Бүгд ({supplierGroups.length})</option>
                  {supplierGroups.map((g) => (
                    <option key={g.supplier_id} value={g.supplier_id}>
                      {g.supplier_name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Supplier cards */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {filteredGroups.map((g) => (
                <div key={g.supplier_id} className="rounded-apple bg-white p-5 shadow-sm">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <Building2 size={16} className="text-gray-400" />
                        <span className="text-lg font-semibold text-gray-900">
                          {g.supplier_name}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-gray-500">
                        {g.order_count} захиалга · {g.brands.length} брэнд
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-gray-400">Нийт жин</div>
                      <div className="text-xl font-bold text-gray-900">
                        {g.total_weight.toFixed(2)} кг
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    {g.brands.map((b) => (
                      <div
                        key={b.brand}
                        className="flex items-center justify-between rounded-apple bg-[#F5F5F7] px-3 py-2"
                      >
                        <span className="text-sm font-medium text-gray-800">{b.brand}</span>
                        <div className="text-right">
                          <span className="text-sm font-semibold text-gray-900">
                            {b.weight.toFixed(2)} кг
                          </span>
                          {Object.entries(b.warehouses).length > 1 && (
                            <div className="text-xs text-gray-400">
                              {Object.entries(b.warehouses)
                                .map(([wh, w]) => `А${wh}: ${w.toFixed(0)}кг`)
                                .join(" · ")}
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-4 flex justify-end">
                    <Link
                      to={`/logistics?supplier=${g.supplier_id}`}
                      className="inline-flex items-center gap-1.5 rounded-apple border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                    >
                      <Truck size={13} />
                      Логистик →
                    </Link>
                  </div>
                </div>
              ))}

              {filteredGroups.length === 0 && !loading && (
                <div className="col-span-2 rounded-apple bg-white p-8 text-center text-sm text-gray-400 shadow-sm">
                  {supplierGroups.length === 0
                    ? "Нийлүүлэгчийн холбоос байхгүй байна. /suppliers хуудсанд тохируулна уу."
                    : "Шүүлтүүрт тохирох нийлүүлэгч байхгүй"}
                </div>
              )}
            </div>

            {/* Unmapped brands */}
            {unmappedBrands.length > 0 && (
              <div className="mt-5 rounded-apple bg-amber-50 p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                  <AlertCircle size={16} />
                  Нийлүүлэгч холбоогүй брэндүүд
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {unmappedBrands.map((b) => (
                    <div
                      key={b.brand}
                      className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800"
                    >
                      {b.brand} — {b.weight.toFixed(2)} кг
                    </div>
                  ))}
                </div>
                <Link
                  to="/suppliers"
                  className="mt-3 inline-flex items-center gap-1 text-xs text-amber-700 underline"
                >
                  Нийлүүлэгч холбох →
                </Link>
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  );
}
