import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Link } from "react-router-dom";
import {
  AlertTriangle,
  Image,
  Weight,
  Tag,
  MapPin,
  DollarSign,
  Barcode,
  Users,
  RefreshCw,
  FileX,
  Printer,
  X,
  ChevronRight,
  TrendingUp,
  TrendingDown,
  Phone,
  MessageSquare,
  ArrowRight,
  Warehouse,
  PackageX,
  Layers,
  ClipboardList,
  Truck,
  Package,
  CheckCircle2,
} from "lucide-react";
import { api } from "../lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type FlagKey =
  | "no_image"
  | "bad_weight"
  | "no_brand"
  | "no_price_tag"
  | "no_loc_tag"
  | "zero_price"
  | "no_barcode"
  | "bad_box_qty";

type WarehouseRow = {
  warehouse: string;
  total: number;
  no_image: number;
  bad_weight: number;
  no_brand: number;
  no_price_tag: number;
  no_loc_tag: number;
  zero_price: number;
  no_barcode: number;
  bad_box_qty: number;
};

type ProductRow = {
  item_code: string;
  name: string;
  brand: string;
  unit_weight: number | null;
  unit_price: number | null;
  barcode: string;
  location_tag: string;
  price_tag: string;
  issue_count: number;
  flags: Record<FlagKey, boolean>;
};

type StatsData = {
  available: boolean;
  barcode_col_exists?: boolean;
  rows: WarehouseRow[];
};

type WhWarehouse = {
  name: string;
  items: number;
  red_items: number;
  total_qty: number;
};

type WhStats = {
  available: boolean;
  file?: string;
  updated_at?: string;
  warehouse_count?: number;
  total_items?: number;
  total_red_items?: number;
  multi_location_count?: number;
  warehouses?: WhWarehouse[];
  error?: string;
};

type POLatest = {
  id: number;
  order_date: string;
  status: string;
  status_label: string;
  total_weight: number;
  total_boxes: number;
};

type PODashStats = {
  total: number;
  active: number;
  arrived: number;
  by_status: Record<string, number>;
  active_weight: number;
  active_boxes: number;
  transit_weight: number;
  transit_boxes: number;
  latest_active: POLatest | null;
};

type ARStats = {
  available: boolean;
  ar_file?: string | null;
  ci_file?: string | null;
  total?: number;
  receivable?: number;
  payable?: number;
  with_phone?: number;
  sms_sent?: number;
  error?: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const METRICS: {
  key: FlagKey;
  label: string;
  short: string;
  icon: React.ElementType;
  color: string;
}[] = [
  { key: "no_image",     label: "Зураг байхгүй",               short: "Зураг",    icon: Image,      color: "text-violet-600" },
  { key: "bad_weight",   label: "Жин буруу / байхгүй",          short: "Жин",      icon: Weight,     color: "text-orange-600" },
  { key: "no_brand",     label: "Брэнд хоосон",                  short: "Брэнд",    icon: Users,      color: "text-pink-600"   },
  { key: "no_price_tag", label: "Үнэ бодох tag байхгүй",        short: "Үнэ tag",  icon: Tag,        color: "text-amber-600"  },
  { key: "no_loc_tag",   label: "Байршил tag байхгүй",           short: "Байршил",  icon: MapPin,     color: "text-sky-600"    },
  { key: "zero_price",   label: "Үнэ = 0 / байхгүй",            short: "Үнэ=0",    icon: DollarSign, color: "text-red-600"    },
  { key: "no_barcode",   label: "Баркод байхгүй",                short: "Баркод",   icon: Barcode,    color: "text-emerald-600"},
  { key: "bad_box_qty",  label: "Хайрцагны тоо байхгүй / = 1",  short: "Хайрцаг",  icon: Package,    color: "text-indigo-600" },
];

// ── Sub-components ────────────────────────────────────────────────────────────

function Badge({ value, total }: { value: number; total: number }) {
  if (value === 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
        0
      </span>
    );
  }
  const pct = total > 0 ? (value / total) * 100 : 0;
  const cls =
    pct >= 30
      ? "bg-red-50 text-red-700"
      : pct >= 10
      ? "bg-amber-50 text-amber-700"
      : "bg-yellow-50 text-yellow-700";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ${cls}`}>
      {value}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

// ── MNT formatter ─────────────────────────────────────────────────────────────

function fmtMnt(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)} тэрбум₮`;
  if (abs >= 1_000_000)     return `${(v / 1_000_000).toFixed(1)} сая₮`;
  if (abs >= 1_000)         return `${(v / 1_000).toFixed(0)} мянга₮`;
  return `${v.toFixed(0)}₮`;
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const [stats, setStats] = useState<StatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [arStats, setArStats] = useState<ARStats | null>(null);
  const [whStats, setWhStats] = useState<WhStats | null>(null);
  const [poStats, setPoStats] = useState<PODashStats | null>(null);

  // Modal state
  const [selectedWarehouse, setSelectedWarehouse] = useState<string | null>(null);
  const [products, setProducts] = useState<ProductRow[]>([]);
  const [modalLoading, setModalLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get("/admin/dashboard-stats");
      setStats(res.data);
    } catch {
      setStats({ available: false, rows: [] });
    } finally {
      setLoading(false);
    }
  };

  const loadArStats = async () => {
    try {
      const res = await api.get("/accounts-receivable/dashboard-stats");
      setArStats(res.data);
    } catch {
      setArStats({ available: false });
    }
  };

  const loadWhStats = async () => {
    try {
      const res = await api.get("/reports/warehouse-stats");
      setWhStats(res.data);
    } catch {
      setWhStats({ available: false });
    }
  };

  const loadPoStats = async () => {
    try {
      const res = await api.get("/purchase-orders/dashboard-stats");
      setPoStats(res.data);
    } catch {
      setPoStats(null);
    }
  };

  useEffect(() => { load(); loadArStats(); loadWhStats(); loadPoStats(); }, []);

  const handleWarehouseClick = async (warehouse: string) => {
    setSelectedWarehouse(warehouse);
    setModalLoading(true);
    setProducts([]);
    try {
      const res = await api.get("/admin/dashboard-products", {
        params: { warehouse },
      });
      setProducts(res.data.products ?? []);
    } catch {
      setProducts([]);
    } finally {
      setModalLoading(false);
    }
  };

  const handlePrint = () => {
    if (!selectedWarehouse) return;

    const w = window.open("", "_blank", "width=1200,height=860");
    if (!w) return;

    const metricHeaders = METRICS.map((m) => `<th>${m.short}</th>`).join("");
    const rows = products
      .map(
        (p, i) => `<tr>
        <td class="num">${i + 1}</td>
        <td class="mono">${p.item_code}</td>
        <td>${p.name || "—"}</td>
        <td>${p.brand || "—"}</td>
        ${METRICS.map((m) =>
          `<td class="${p.flags[m.key] ? "fail" : "pass"}">${p.flags[m.key] ? "✗" : "·"}</td>`
        ).join("")}
      </tr>`
      )
      .join("");

    w.document.write(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${selectedWarehouse} — Дутуу мэдээлэлтэй бараанууд</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; font-size: 10px; padding: 14px; color: #111; }
  .hdr { margin-bottom: 10px; }
  h2  { font-size: 14px; font-weight: bold; margin-bottom: 3px; }
  .meta { color: #6b7280; font-size: 10px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; }
  th { background: #e5e7eb; border: 1px solid #9ca3af; padding: 3px 6px;
       text-align: center; font-size: 9px; white-space: nowrap; }
  th.left { text-align: left; }
  td { border: 1px solid #d1d5db; padding: 2px 5px; font-size: 9px; vertical-align: middle; }
  .fail { color: #dc2626; text-align: center; font-weight: bold; }
  .pass { color: #d1d5db; text-align: center; }
  .num  { text-align: right; color: #9ca3af; width: 24px; }
  .mono { font-family: monospace; white-space: nowrap; }
  tr:nth-child(even) td { background: #f9fafb; }
  @media print { body { padding: 6px; font-size: 9px; } }
</style>
</head><body>
<div class="hdr">
  <h2>${selectedWarehouse} — Мэдээлэл дутуу бараанууд</h2>
  <div class="meta">Нийт: ${products.length} бараа · Хэвлэсэн: ${new Date().toLocaleString("mn-MN")}</div>
</div>
<table>
  <thead><tr>
    <th class="left">№</th>
    <th class="left">Код</th>
    <th class="left">Нэр</th>
    <th class="left">Брэнд</th>
    ${metricHeaders}
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</body></html>`);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  };

  const dataRows = stats?.rows.filter((r) => r.warehouse !== "__total__") ?? [];
  const totalRow = stats?.rows.find((r) => r.warehouse === "__total__");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 sm:text-2xl">Хянах самбар</h1>
          <p className="mt-0.5 text-sm text-gray-500">
            Master нэгтгэлийн мэдээллийн чанарын шинжилгээ — агуулах тус бүрээр
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="inline-flex w-fit items-center gap-2 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          Шинэчлэх
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="mt-10 flex items-center justify-center gap-3 text-sm text-gray-400">
          <RefreshCw size={16} className="animate-spin" />
          Уншиж байна...
        </div>
      )}

      {/* No master file */}
      {!loading && stats && !stats.available && (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <FileX size={40} className="text-gray-300" />
          <p className="text-sm text-gray-500">
            Master нэгтгэл файл байхгүй байна.
            <br />
            Эхлээд Мастер нэгтгэл хийнэ үү.
          </p>
        </div>
      )}

      {/* Stats table */}
      {!loading && stats?.available && (
        <div className="mt-6">
          {/* Legend */}
          <div className="mb-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:gap-3">
            {METRICS.map((m) => (
              <div key={m.key} className="flex items-center gap-1.5 text-xs text-gray-500">
                <m.icon size={13} className={m.color} />
                <span>{m.label}</span>
              </div>
            ))}
          </div>

          {/* ── Mobile: card view (hidden on md+) ── */}
          <div className="space-y-2 md:hidden">
            {dataRows.map((row) => {
              const isNoLoc = row.warehouse === "Байршил tag байхгүй";
              return (
                <div
                  key={row.warehouse}
                  onClick={() => handleWarehouseClick(row.warehouse)}
                  className={`cursor-pointer rounded-apple p-4 shadow-sm active:opacity-80 ${
                    isNoLoc ? "bg-amber-50" : "bg-white"
                  }`}
                >
                  {/* Row header */}
                  <div className="flex items-center justify-between">
                    <span className={`font-semibold text-sm ${isNoLoc ? "text-amber-700" : "text-gray-900"}`}>
                      {isNoLoc && <AlertTriangle size={13} className="inline mr-1 mb-0.5" />}
                      {row.warehouse}
                    </span>
                    <div className="flex items-center gap-1.5 text-xs text-gray-500">
                      <span className="font-medium">{row.total.toLocaleString()} бараа</span>
                      <ChevronRight size={13} className="text-gray-300" />
                    </div>
                  </div>
                  {/* Metric chips */}
                  <div className="mt-2.5 grid grid-cols-4 gap-x-2 gap-y-2">
                    {METRICS.map((m) => (
                      <div key={m.key} className="flex flex-col items-center gap-0.5">
                        <m.icon size={11} className={m.color} />
                        <span className="text-[9px] text-gray-400 leading-tight text-center">
                          {m.short}
                        </span>
                        <Badge value={row[m.key] as number} total={row.total} />
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Total card */}
            {totalRow && (
              <div className="rounded-apple border-2 border-gray-200 bg-gray-50 p-4 shadow-sm">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-gray-900">Нийт</span>
                  <span className="text-sm font-semibold text-gray-700">
                    {totalRow.total.toLocaleString()} бараа
                  </span>
                </div>
                <div className="mt-2.5 grid grid-cols-4 gap-x-2 gap-y-2">
                  {METRICS.map((m) => (
                    <div key={m.key} className="flex flex-col items-center gap-0.5">
                      <m.icon size={11} className={m.color} />
                      <span className="text-[9px] text-gray-400 leading-tight text-center">
                        {m.short}
                      </span>
                      <Badge value={totalRow[m.key] as number} total={totalRow.total} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Desktop: table view (hidden on mobile) ── */}
          <div className="hidden overflow-x-auto rounded-apple bg-white shadow-sm md:block">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100 bg-gray-50 text-xs font-semibold text-gray-500">
                  <th className="sticky left-0 bg-gray-50 px-4 py-3 text-left whitespace-nowrap">
                    Агуулах
                  </th>
                  <th className="px-3 py-3 text-right whitespace-nowrap">Нийт</th>
                  {METRICS.map((m) => (
                    <th key={m.key} className="px-3 py-3 text-center whitespace-nowrap">
                      <div className="flex flex-col items-center gap-1">
                        <m.icon size={13} className={m.color} />
                        <span>{m.short}</span>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {dataRows.map((row) => {
                  const isNoLoc = row.warehouse === "Байршил tag байхгүй";
                  return (
                    <tr
                      key={row.warehouse}
                      onClick={() => handleWarehouseClick(row.warehouse)}
                      className={`cursor-pointer transition-colors hover:bg-blue-50 ${
                        isNoLoc ? "bg-amber-50/40" : ""
                      }`}
                    >
                      <td className={`sticky left-0 px-4 py-3 whitespace-nowrap ${isNoLoc ? "bg-amber-50" : "bg-white"}`}>
                        <div className="flex items-center gap-1.5 font-medium text-gray-900">
                          {isNoLoc ? (
                            <span className="flex items-center gap-1.5 text-amber-700">
                              <AlertTriangle size={13} />
                              {row.warehouse}
                            </span>
                          ) : (
                            row.warehouse
                          )}
                          <ChevronRight size={12} className="ml-1 text-gray-300" />
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold text-gray-700">
                        {row.total.toLocaleString()}
                      </td>
                      {METRICS.map((m) => (
                        <td key={m.key} className="px-3 py-3 text-center">
                          <Badge value={row[m.key] as number} total={row.total} />
                        </td>
                      ))}
                    </tr>
                  );
                })}

                {/* Total row */}
                {totalRow && (
                  <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
                    <td className="sticky left-0 bg-gray-50 px-4 py-3 text-gray-900 whitespace-nowrap">
                      Нийт
                    </td>
                    <td className="px-3 py-3 text-right text-gray-900">
                      {totalRow.total.toLocaleString()}
                    </td>
                    {METRICS.map((m) => (
                      <td key={m.key} className="px-3 py-3 text-center">
                        <Badge value={totalRow[m.key] as number} total={totalRow.total} />
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Notes */}
          {stats.barcode_col_exists === false && (
            <p className="mt-2 text-xs text-gray-400">
              * Баркод багана master файлд байхгүй — Мастер нэгтгэл дахин хийснээр шинэчлэгдэнэ.
            </p>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-gray-400">
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" /> 0 — Сайн
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-yellow-400" /> 1–9% — Анхаар
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-amber-400" /> 10–29% — Дунд
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block h-2 w-2 rounded-full bg-red-400" /> 30%+ — Яаралтай
            </span>
            <span className="ml-2 flex items-center gap-1 text-blue-400">
              ← Агуулах дарж дутуу бараануудыг харна уу
            </span>
          </div>
        </div>
      )}

      {/* ── Захиалгын тайлан ────────────────────────────────────────────── */}
      {poStats && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 sm:text-lg">
              Захиалгын тайлан
            </h2>
            <Link
              to="/order"
              className="flex items-center gap-1 text-xs text-[#0071E3] hover:underline"
            >
              Дэлгэрэнгүй
              <ArrowRight size={12} />
            </Link>
          </div>

          {poStats.total === 0 ? (
            <div className="flex items-center gap-3 rounded-apple bg-white px-4 py-5 shadow-sm text-sm text-gray-400">
              <ClipboardList size={18} className="shrink-0 text-gray-300" />
              Захиалга байхгүй байна
            </div>
          ) : (
            <>
              {/* ── Summary cards ── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {/* Total */}
                <div className="flex flex-col gap-1 rounded-apple bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <ClipboardList size={13} className="text-indigo-500" />
                    Нийт захиалга
                  </div>
                  <div className="text-2xl font-bold text-gray-900">{poStats.total}</div>
                  <div className="text-xs text-gray-400">
                    {poStats.arrived} нь ирсэн · {poStats.active} идэвхтэй
                  </div>
                </div>

                {/* Active weight */}
                <div className="flex flex-col gap-1 rounded-apple bg-blue-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-blue-600">
                    <Weight size={13} />
                    Идэвхтэй жин
                  </div>
                  <div className="text-xl font-bold text-blue-700 tabular-nums">
                    {poStats.active_weight.toLocaleString(undefined, { maximumFractionDigits: 0 })} кг
                  </div>
                  <div className="text-xs text-blue-400">
                    {poStats.active_boxes.toLocaleString()} хайрцаг
                  </div>
                </div>

                {/* Transit */}
                <div className="flex flex-col gap-1 rounded-apple bg-sky-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-sky-600">
                    <Truck size={13} />
                    Замд явж байна
                  </div>
                  <div className="text-xl font-bold text-sky-700 tabular-nums">
                    {poStats.transit_weight.toLocaleString(undefined, { maximumFractionDigits: 0 })} кг
                  </div>
                  <div className="text-xs text-sky-400">
                    {poStats.transit_boxes.toLocaleString()} хайрцаг
                  </div>
                </div>

                {/* Arrived */}
                <div className="flex flex-col gap-1 rounded-apple bg-emerald-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                    <CheckCircle2 size={13} />
                    Ирсэн захиалга
                  </div>
                  <div className="text-2xl font-bold text-emerald-700">{poStats.arrived}</div>
                </div>
              </div>

              {/* ── Status breakdown ── */}
              {(() => {
                const STATUS_SEQ = ["preparing","reviewing","sending","loading","transit","arrived"] as const;
                const STATUS_LABELS: Record<string, string> = {
                  preparing: "Бэлдэж байна",
                  reviewing: "Хянаж байна",
                  sending:   "Илгээж байна",
                  loading:   "Ачигдаж байна",
                  transit:   "Замд",
                  arrived:   "Ирсэн",
                };
                const STATUS_CLS: Record<string, string> = {
                  preparing: "bg-amber-50 text-amber-700 border-amber-200",
                  reviewing: "bg-blue-50 text-blue-700 border-blue-200",
                  sending:   "bg-violet-50 text-violet-700 border-violet-200",
                  loading:   "bg-orange-50 text-orange-700 border-orange-200",
                  transit:   "bg-sky-50 text-sky-700 border-sky-200",
                  arrived:   "bg-emerald-50 text-emerald-700 border-emerald-200",
                };
                return (
                  <div className="mt-3 overflow-x-auto">
                    <div className="flex min-w-max items-center gap-1.5 rounded-apple bg-white px-4 py-3 shadow-sm">
                      {STATUS_SEQ.map((s, i) => {
                        const count = poStats.by_status[s] ?? 0;
                        return (
                          <div key={s} className="flex items-center gap-1.5">
                            {i > 0 && <ChevronRight size={12} className="shrink-0 text-gray-300" />}
                            <div
                              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${
                                count > 0 ? STATUS_CLS[s] : "border-gray-100 bg-gray-50 text-gray-400"
                              }`}
                            >
                              {s === "transit" && <Truck size={11} />}
                              {s === "arrived" && <CheckCircle2 size={11} />}
                              {s === "loading" && <Package size={11} />}
                              <span>{STATUS_LABELS[s]}</span>
                              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                                count > 0 ? "bg-white/60" : "bg-gray-100 text-gray-400"
                              }`}>
                                {count}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}

              {/* ── Latest active order ── */}
              {poStats.latest_active && (
                <Link
                  to={`/order/${poStats.latest_active.id}`}
                  className="mt-3 flex items-center justify-between rounded-apple bg-white px-4 py-3.5 shadow-sm hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-50">
                      <ClipboardList size={16} className="text-blue-500" />
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-gray-900">
                        {poStats.latest_active.order_date.replaceAll("-", "/")} — хамгийн сүүлийн идэвхтэй захиалга
                      </div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
                        <span className={`rounded-full px-2 py-0.5 font-medium ${
                          {
                            preparing: "bg-amber-50 text-amber-700",
                            reviewing: "bg-blue-50 text-blue-700",
                            sending:   "bg-violet-50 text-violet-700",
                            loading:   "bg-orange-50 text-orange-700",
                            transit:   "bg-sky-50 text-sky-700",
                            arrived:   "bg-emerald-50 text-emerald-700",
                          }[poStats.latest_active.status] ?? "bg-gray-100 text-gray-600"
                        }`}>
                          {poStats.latest_active.status_label}
                        </span>
                        <span>{poStats.latest_active.total_boxes.toLocaleString()} хайрцаг</span>
                        <span>·</span>
                        <span>{poStats.latest_active.total_weight.toLocaleString(undefined, { maximumFractionDigits: 0 })} кг</span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight size={16} className="shrink-0 text-gray-300" />
                </Link>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Авлага өглөгийн хураангуй ─────────────────────────────────────── */}
      {arStats && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 sm:text-lg">
              Авлага өглөгийн тайлан
            </h2>
            <Link
              to="/accounts-receivable"
              className="flex items-center gap-1 text-xs text-[#0071E3] hover:underline"
            >
              Дэлгэрэнгүй
              <ArrowRight size={12} />
            </Link>
          </div>

          {!arStats.available ? (
            <div className="flex items-center gap-3 rounded-apple bg-white px-4 py-5 shadow-sm text-sm text-gray-400">
              <FileX size={18} className="shrink-0 text-gray-300" />
              {arStats.ar_file === null || arStats.ci_file === null
                ? "Авлага өглөг болон харилцагчийн файлуудыг оруулна уу"
                : "Файл уншихад алдаа гарлаа"}
            </div>
          ) : (
            <>
              {/* Stat cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {/* Total */}
                <div className="flex flex-col gap-1 rounded-apple bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Users size={13} className="text-blue-500" />
                    Нийт харилцагч
                  </div>
                  <div className="text-2xl font-bold text-gray-900">
                    {arStats.total!.toLocaleString()}
                  </div>
                </div>

                {/* Receivable (авлага) */}
                <div className="flex flex-col gap-1 rounded-apple bg-blue-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-blue-600">
                    <TrendingUp size={13} />
                    Авлага
                  </div>
                  <div className="text-xl font-bold text-blue-700 tabular-nums">
                    {fmtMnt(arStats.receivable!)}
                  </div>
                </div>

                {/* Payable (өглөг) */}
                <div className="flex flex-col gap-1 rounded-apple bg-red-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-red-500">
                    <TrendingDown size={13} />
                    Өглөг
                  </div>
                  <div className="text-xl font-bold text-red-600 tabular-nums">
                    {fmtMnt(arStats.payable!)}
                  </div>
                </div>

                {/* Phone / SMS */}
                <div className="flex flex-col gap-1 rounded-apple bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Phone size={13} className="text-emerald-500" />
                    Утастай
                  </div>
                  <div className="text-2xl font-bold text-gray-900">
                    {arStats.with_phone!.toLocaleString()}
                  </div>
                  {arStats.sms_sent! > 0 && (
                    <div className="flex items-center gap-1 text-xs text-green-600">
                      <MessageSquare size={11} />
                      {arStats.sms_sent} SMS илгээгдсэн
                    </div>
                  )}
                </div>
              </div>

              {/* File info */}
              <p className="mt-2 text-xs text-gray-400 truncate">
                {arStats.ar_file}
              </p>
            </>
          )}
        </div>
      )}

      {/* ── Үлдэгдлийн тайлан (Done.py) ────────────────────────────────────── */}
      {whStats && (
        <div className="mt-6">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 sm:text-lg">
              Үлдэгдлийн тайлан
            </h2>
            <Link
              to="/reports"
              className="flex items-center gap-1 text-xs text-[#0071E3] hover:underline"
            >
              Дэлгэрэнгүй
              <ArrowRight size={12} />
            </Link>
          </div>

          {!whStats.available ? (
            <div className="flex items-center gap-3 rounded-apple bg-white px-4 py-5 shadow-sm text-sm text-gray-400">
              <FileX size={18} className="shrink-0 text-gray-300" />
              {whStats.error
                ? `Файл уншихад алдаа: ${whStats.error}`
                : "Үлдэгдэл тайлан файл байхгүй байна. Файл оруулалт → Үлдэгдэл тайлан хэсгээс оруулна уу."}
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="flex flex-col gap-1 rounded-apple bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Warehouse size={13} className="text-indigo-500" />
                    Агуулах
                  </div>
                  <div className="text-2xl font-bold text-gray-900">
                    {whStats.warehouse_count!.toLocaleString()}
                  </div>
                </div>

                <div className="flex flex-col gap-1 rounded-apple bg-white p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-gray-500">
                    <Tag size={13} className="text-blue-500" />
                    Нийт бараа
                  </div>
                  <div className="text-2xl font-bold text-gray-900">
                    {whStats.total_items!.toLocaleString()}
                  </div>
                </div>

                <div className="flex flex-col gap-1 rounded-apple bg-red-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-red-500">
                    <PackageX size={13} />
                    Улайсан (I&lt;0)
                  </div>
                  <div className="text-2xl font-bold text-red-600">
                    {whStats.total_red_items!.toLocaleString()}
                  </div>
                </div>

                <div className="flex flex-col gap-1 rounded-apple bg-amber-50 p-4 shadow-sm">
                  <div className="flex items-center gap-1.5 text-xs text-amber-600">
                    <Layers size={13} />
                    Давхар байршил
                  </div>
                  <div className="text-2xl font-bold text-amber-700">
                    {whStats.multi_location_count!.toLocaleString()}
                  </div>
                </div>
              </div>

              {/* Per-warehouse table */}
              {whStats.warehouses && whStats.warehouses.length > 0 && (
                <div className="mt-3 overflow-hidden rounded-apple bg-white shadow-sm">
                  {/* Mobile cards */}
                  <div className="divide-y divide-gray-100 md:hidden">
                    {whStats.warehouses.map((wh) => (
                      <div key={wh.name} className="px-4 py-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-900 truncate">{wh.name}</span>
                          <span className="ml-2 text-xs text-gray-500">{wh.total_qty.toFixed(0)} ш</span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-gray-500">
                          <span>{wh.items} бараа</span>
                          {wh.red_items > 0 && (
                            <span className="flex items-center gap-0.5 font-medium text-red-600">
                              <PackageX size={11} />
                              {wh.red_items} улайсан
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-gray-100 text-left text-xs text-gray-500">
                          <th className="px-5 py-3 font-medium">Агуулах</th>
                          <th className="px-5 py-3 font-medium text-right">Бараа</th>
                          <th className="px-5 py-3 font-medium text-right">Улайсан</th>
                          <th className="px-5 py-3 font-medium text-right">Нийт үлдэгдэл</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {whStats.warehouses.map((wh) => (
                          <tr key={wh.name} className="hover:bg-gray-50">
                            <td className="px-5 py-3 font-medium text-gray-900">{wh.name}</td>
                            <td className="px-5 py-3 text-right text-gray-700">{wh.items.toLocaleString()}</td>
                            <td className="px-5 py-3 text-right">
                              {wh.red_items > 0 ? (
                                <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-semibold text-red-600">
                                  <PackageX size={11} />
                                  {wh.red_items}
                                </span>
                              ) : (
                                <span className="text-xs text-emerald-600">0</span>
                              )}
                            </td>
                            <td className="px-5 py-3 text-right tabular-nums text-gray-700">
                              {wh.total_qty.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* File info */}
              <p className="mt-2 text-xs text-gray-400 truncate">{whStats.file}</p>
            </>
          )}
        </div>
      )}

      {/* ── Product detail modal ────────────────────────────────────────────── */}
      {selectedWarehouse && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedWarehouse(null);
          }}
        >
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex h-[92vh] w-full max-w-5xl flex-col rounded-t-2xl bg-white shadow-2xl sm:h-[90vh] sm:rounded-apple"
          >
            {/* Modal header */}
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4">
              <div>
                <h2 className="text-base font-semibold text-gray-900">
                  {selectedWarehouse === "Байршил tag байхгүй" ? (
                    <span className="flex items-center gap-2 text-amber-700">
                      <AlertTriangle size={15} />
                      {selectedWarehouse}
                    </span>
                  ) : (
                    selectedWarehouse
                  )}
                </h2>
                <p className="mt-0.5 text-xs text-gray-400">
                  {modalLoading
                    ? "Уншиж байна..."
                    : `${products.length.toLocaleString()} мэдээлэл дутуу бараа · дутуу тоогоор эрэмбэлэгдлээ`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handlePrint}
                  disabled={modalLoading || products.length === 0}
                  className="inline-flex items-center gap-2 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                >
                  <Printer size={14} />
                  Хэвлэх
                </button>
                <button
                  onClick={() => setSelectedWarehouse(null)}
                  className="rounded-apple p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
                >
                  <X size={18} />
                </button>
              </div>
            </div>

            {/* Modal body */}
            <div className="flex-1 overflow-auto">
              {modalLoading ? (
                <div className="flex h-full items-center justify-center gap-3 text-sm text-gray-400">
                  <RefreshCw size={16} className="animate-spin" />
                  Уншиж байна...
                </div>
              ) : products.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-300">
                  <span className="text-5xl">✓</span>
                  <p className="text-sm">Дутуу мэдээлэл олдсонгүй</p>
                </div>
              ) : (
                <table className="min-w-full text-sm">
                  <thead className="sticky top-0 z-10">
                    <tr className="border-b border-gray-200 bg-gray-50/90 backdrop-blur-sm text-xs font-semibold text-gray-500">
                      <th className="w-9 px-3 py-3 text-right text-gray-300">№</th>
                      <th className="px-4 py-3 text-left whitespace-nowrap">Код</th>
                      <th className="px-4 py-3 text-left">Нэр</th>
                      <th className="px-4 py-3 text-left whitespace-nowrap">Брэнд</th>
                      {METRICS.map((m) => (
                        <th key={m.key} className="px-2 py-3 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <m.icon size={12} className={m.color} />
                            <span style={{ fontSize: "9px" }}>{m.short}</span>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {products.map((p, i) => (
                      <tr key={`${p.item_code}-${i}`} className="hover:bg-gray-50/60">
                        <td className="px-3 py-2 text-right text-xs text-gray-300">
                          {i + 1}
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">
                          {p.item_code}
                        </td>
                        <td className="px-4 py-2 max-w-[260px]">
                          <span className="line-clamp-1 text-xs font-medium text-gray-900">
                            {p.name || "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2 max-w-[130px]">
                          <span className="block truncate text-xs text-gray-500">
                            {p.brand || "—"}
                          </span>
                        </td>
                        {METRICS.map((m) => (
                          <td key={m.key} className="px-2 py-2 text-center">
                            {p.flags[m.key] ? (
                              <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                            ) : (
                              <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-100" />
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Modal footer */}
            {!modalLoading && products.length > 0 && (
              <div className="shrink-0 border-t border-gray-100 px-6 py-2.5 flex items-center justify-between text-xs text-gray-400">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full bg-red-400" />
                    Дутуу мэдээлэл
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-gray-200" />
                    Бүрэн
                  </span>
                </div>
                <span>{products.length.toLocaleString()} бараа</span>
              </div>
            )}
          </motion.div>
        </div>
      )}
    </motion.div>
  );
}
