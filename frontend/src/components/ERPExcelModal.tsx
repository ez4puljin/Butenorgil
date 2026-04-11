import { useState, useEffect } from "react";
import { X, Download, RefreshCw, Building2 } from "lucide-react";
import { api } from "../lib/api";
import type { PODetail } from "../store/purchaseOrderStore";

// ── Types ─────────────────────────────────────────────────────────────────────

type Company = "buten_orgil" | "orgil_khorum";

interface ERPConfig {
  company: Company;
  date: string;
  document_note: string;
  related_account: string;               // Харьцсан данс
  account: string;
  warehouse_map: Record<string, string>; // buten_orgil: warehouse_name → ERP location code
  single_location: string;               // orgil_khorum
}

const COMPANY_LABELS: Record<Company, string> = {
  buten_orgil: "Бүтэн-Оргил ХХК",
  orgil_khorum: "Оргил-Хорум ХХК",
};

const LS_KEY = "erp_excel_config_v1";

const defaultConfig = (orderDate: string): ERPConfig => ({
  company: "buten_orgil",
  date: orderDate,
  document_note: "",
  related_account: "",
  account: "",
  warehouse_map: {},
  single_location: "",
});

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  order: PODetail;
  onClose: () => void;
  brandFilter?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ERPExcelModal({ order, onClose, brandFilter }: Props) {
  // Unique warehouse names from order lines (only lines with received_qty_box > 0)
  const warehouses = [
    ...new Set(
      order.lines
        .filter((l) => (l.received_qty_box ?? 0) > 0)
        .map((l) => l.warehouse_name)
        .filter(Boolean)
    ),
  ].sort();

  const [cfg, setCfg] = useState<ERPConfig>(() => {
    try {
      const saved = localStorage.getItem(LS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as ERPConfig;
        return { ...defaultConfig(order.order_date), ...parsed, date: order.order_date };
      }
    } catch {
      // ignore
    }
    return defaultConfig(order.order_date);
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist to localStorage whenever config changes
  useEffect(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  }, [cfg]);

  const set = <K extends keyof ERPConfig>(key: K, val: ERPConfig[K]) =>
    setCfg((prev) => ({ ...prev, [key]: val }));

  const setWarehouseCode = (wh: string, code: string) =>
    setCfg((prev) => ({
      ...prev,
      warehouse_map: { ...prev.warehouse_map, [wh]: code },
    }));

  const handleExport = async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await api.post(
        `/purchase-orders/${order.id}/export-erp-excel`,
        { ...cfg, brand_filter: brandFilter ?? "" },
        { responseType: "blob" }
      );
      // Filename from Content-Disposition header or fallback
      const disposition = res.headers?.["content-disposition"] ?? "";
      const match = disposition.match(/filename=([^\s;]+)/);
      const fname = match?.[1] ?? `${order.order_date.replaceAll("-", "")}_PO${order.id}.xlsx`;
      const url = URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      a.click();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Excel үүсгэхэд алдаа гарлаа");
    } finally {
      setLoading(false);
    }
  };

  const canExport =
    cfg.document_note.trim() !== "" &&
    cfg.account.trim() !== "" &&
    (cfg.company === "orgil_khorum"
      ? cfg.single_location.trim() !== ""
      : warehouses.every((wh) => (cfg.warehouse_map[wh] ?? "").trim() !== ""));

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/30 sm:items-center sm:p-4">
      <div className="w-full max-w-lg rounded-t-2xl bg-white shadow-xl sm:rounded-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-6 py-4 shrink-0">
          <div className="flex items-center gap-2">
            <Building2 size={16} className="text-emerald-600" />
            <h2 className="text-base font-semibold text-gray-900">ERP Импорт Excel</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700">
            <X size={18} />
          </button>
        </div>

        {/* Body — scrollable */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">
          {/* Company selector */}
          <div>
            <label className="mb-1.5 block text-xs font-medium text-gray-500">Компани</label>
            <div className="flex gap-2">
              {(["buten_orgil", "orgil_khorum"] as Company[]).map((c) => (
                <button
                  key={c}
                  onClick={() => set("company", c)}
                  className={`flex-1 rounded-lg border py-2 text-sm font-medium transition-colors ${
                    cfg.company === c
                      ? "border-[#0071E3] bg-[#0071E3] text-white"
                      : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50"
                  }`}
                >
                  {COMPANY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Огноо</label>
            <input
              type="date"
              value={cfg.date}
              onChange={(e) => set("date", e.target.value)}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
            />
          </div>

          {/* Гүйлгээний утга */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">
              Гүйлгээний утга <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={cfg.document_note}
              onChange={(e) => set("document_note", e.target.value)}
              placeholder="жишээ: Барааны орлого — 2026/12/31"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
            />
          </div>

          {/* Харьцсан данс */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">Харьцсан данс</label>
            <input
              type="text"
              value={cfg.related_account}
              onChange={(e) => set("related_account", e.target.value)}
              placeholder="жишээ: 310101"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
            />
          </div>

          {/* Данс */}
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-500">
              Данс <span className="text-red-400">*</span>
            </label>
            <input
              type="text"
              value={cfg.account}
              onChange={(e) => set("account", e.target.value)}
              placeholder="жишээ: 150101"
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
            />
          </div>

          {/* Location config — depends on company */}
          {cfg.company === "orgil_khorum" ? (
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-500">
                Байршил (код) <span className="text-red-400">*</span>
              </label>
              <input
                type="text"
                value={cfg.single_location}
                onChange={(e) => set("single_location", e.target.value)}
                placeholder="жишээ: 14"
                className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-[#0071E3]"
              />
              <p className="mt-1 text-[11px] text-gray-400">
                Бүх бараа энэ нэг байршилд орлого авагдана
              </p>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-gray-500">
                Агуулах → Байршил код <span className="text-red-400">*</span>
              </label>
              {warehouses.length === 0 ? (
                <p className="text-xs text-amber-600">Ирсэн тоотой бараа байхгүй байна</p>
              ) : (
                <div className="space-y-2 rounded-lg border border-gray-100 bg-gray-50 p-3">
                  {warehouses.map((wh) => (
                    <div key={wh} className="flex items-center gap-3">
                      <span className="flex-1 truncate text-xs text-gray-700" title={wh}>
                        {wh || "(байршилгүй)"}
                      </span>
                      <input
                        type="text"
                        value={cfg.warehouse_map[wh] ?? ""}
                        onChange={(e) => setWarehouseCode(wh, e.target.value)}
                        placeholder="ERP код"
                        className="w-24 rounded border border-gray-200 bg-white px-2 py-1 text-xs outline-none focus:border-[#0071E3]"
                      />
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-1 text-[11px] text-gray-400">
                Агуулах бүрийн ERP дахь байршил кодыг оруулна уу
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-4 shrink-0">
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Болих
          </button>
          <button
            onClick={handleExport}
            disabled={loading || !canExport}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-700 disabled:opacity-40"
          >
            {loading ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            Excel татах
          </button>
        </div>
      </div>
    </div>
  );
}
