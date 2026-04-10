import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { Modal } from "../components/ui/Modal";
import {
  UploadCloud, Info, Pencil, Plus, Trash2, BarChart3, ChevronDown, Search, X,
} from "lucide-react";
import { api } from "../lib/api";

// ─── Types ────────────────────────────────────────────────────
type Region = { key: string; label: string; color: string; bg: string };
type ImportLog = {
  id: number;
  region: string;
  region_label: string;
  year: number;
  month: number;
  filename: string;
  uploaded_at: string;
  uploaded_by: string;
  status: string;
  message: string;
};
type LatestMap = Record<string, Record<number, Record<number, { filename: string; uploaded_at: string; uploaded_by: string }>>>;

// Dashboard types
type DashFilters = { region: string | null; year: number | null; month: number | null };
type TopCustomer = { customer_code: string; customer_name: string; total_amount: number };
type TopBrand    = { brand: string; total_amount: number };
type TrendRow    = { year: number; month: number; total_amount: number };
type DashData    = {
  total_amount:   number;
  top_customers:  TopCustomer[];
  top_brands:     TopBrand[];
  monthly_trend:  TrendRow[];
  // rankings (included in same response)
  available_months?: { year: number; month: number }[];
  customer_ranks?: CustomerRank[];
  brand_ranks?:    BrandRank[];
};

// Rankings types
type MonthlyPoint = { year: number; month: number; total: number };
type CustomerRank = {
  customer_code: string; customer_name: string; phone: string;
  monthly: MonthlyPoint[]; total_amount: number; growth_pct: number | null;
};
type BrandRank = {
  brand: string; monthly: MonthlyPoint[];
  total_amount: number; growth_pct: number | null;
};
type RankData = {
  available_months: { year: number; month: number }[];
  customers: CustomerRank[];
  brands: BrandRank[];
};

// ─── Mini chart helpers ───────────────────────────────────────

/** Linear regression: returns {slope, intercept} for y = slope*i + intercept */
function linReg(vals: number[]): { slope: number; intercept: number } {
  const n = vals.length;
  if (n < 2) return { slope: 0, intercept: vals[0] ?? 0 };
  const xm = (n - 1) / 2;
  const ym = vals.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  vals.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) ** 2; });
  const slope = den > 0 ? num / den : 0;
  return { slope, intercept: ym - slope * xm };
}

function Sparkline({ points, W = 180, H = 64 }: { points: MonthlyPoint[], W?: number, H?: number }) {
  if (points.length === 0) return <span className="text-xs text-gray-300">—</span>;

  const vals  = points.map(p => p.total);
  const n     = vals.length;
  const PL = 4, PR = 4, PT = 4, PB = H > 40 ? 16 : 4;
  const cW = W - PL - PR;   // chart area width
  const cH = H - PT - PB;   // chart area height

  const maxV = Math.max(...vals), minV = Math.min(...vals);
  const range = maxV - minV || maxV || 1;

  const getX = (i: number) => PL + (n === 1 ? cW / 2 : (i / (n - 1)) * cW);
  const getY = (v: number) => PT + cH - ((v - minV) / range) * cH;

  // Actual data polyline
  const dataPts = vals.map((v, i) => `${getX(i).toFixed(1)},${getY(v).toFixed(1)}`).join(" ");

  // Linear regression trend line
  const { slope, intercept } = linReg(vals);
  const trendIsUp = slope >= 0;
  const clamp = (v: number) => Math.max(minV, Math.min(maxV, v));
  const ty0 = getY(clamp(intercept));
  const ty1 = getY(clamp(slope * (n - 1) + intercept));

  const dataColor  = trendIsUp ? "#4ade80" : "#f87171"; // soft green / soft red
  const trendColor = trendIsUp ? "#16a34a" : "#dc2626"; // strong green / strong red

  return (
    <svg width={W} height={H} className="overflow-visible flex-shrink-0">
      {/* Zero / baseline grid line */}
      <line x1={PL} y1={PT + cH} x2={W - PR} y2={PT + cH}
        stroke="#e5e7eb" strokeWidth={1} />

      {/* Data area fill */}
      {n >= 2 && (
        <polyline
          points={`${getX(0).toFixed(1)},${PT + cH} ${dataPts} ${getX(n-1).toFixed(1)},${PT + cH}`}
          fill={trendIsUp ? "rgba(74,222,128,0.12)" : "rgba(248,113,113,0.12)"}
          stroke="none"
        />
      )}

      {/* Actual data line */}
      {n >= 2 && (
        <polyline points={dataPts} fill="none" stroke={dataColor}
          strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      )}

      {/* Data dots */}
      {vals.map((v, i) => (
        <circle key={i} cx={getX(i)} cy={getY(v)} r={2.5} fill={dataColor}
          stroke="white" strokeWidth={0.8} />
      ))}

      {/* Trend line (linear regression) — dashed, prominent */}
      {n >= 2 && (
        <line
          x1={getX(0).toFixed(1)} y1={ty0.toFixed(1)}
          x2={getX(n - 1).toFixed(1)} y2={ty1.toFixed(1)}
          stroke={trendColor} strokeWidth={2}
          strokeDasharray="4 2"
          strokeLinecap="round"
        />
      )}

      {/* Trend arrow at end */}
      {n >= 2 && (() => {
        const ax = getX(n - 1), ay = ty1;
        const angle = Math.atan2(ty1 - ty0, getX(n - 1) - getX(0));
        const arrowLen = 5;
        const a1x = ax - arrowLen * Math.cos(angle - 0.5);
        const a1y = ay - arrowLen * Math.sin(angle - 0.5);
        const a2x = ax - arrowLen * Math.cos(angle + 0.5);
        const a2y = ay - arrowLen * Math.sin(angle + 0.5);
        return (
          <polyline
            points={`${a1x.toFixed(1)},${a1y.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)} ${a2x.toFixed(1)},${a2y.toFixed(1)}`}
            fill="none" stroke={trendColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"
          />
        );
      })()}

      {/* X axis month labels — only when tall enough */}
      {H > 40 && points.map((p, i) => (
        <text key={i} x={getX(i)} y={H - 3} textAnchor="middle"
          fontSize={8} fill="#9ca3af" fontFamily="sans-serif">
          {p.month}-р
        </text>
      ))}
    </svg>
  );
}

function GrowthBadge({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="text-xs text-gray-300">—</span>;
  const up = pct >= 0;
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold
      ${up ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(1)}%<span className="font-normal opacity-70">/сар</span>
    </span>
  );
}

/** Mobile-friendly abbreviated amount: 1.19 тэрбум₮ / 123.4 сая₮ / full */
function fmtShort(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "") + " тэрбум₮";
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(1).replace(/\.?0+$/, "")     + " сая₮";
  return n.toLocaleString("mn-MN") + "₮";
}

// ─── Constants ───────────────────────────────────────────────
const REGIONS: Region[] = [
  { key: "zuun_bus",   label: "Мөрөн зүүн бүс",   color: "text-blue-700",   bg: "bg-blue-50 border-blue-200" },
  { key: "baruun_bus", label: "Мөрөн баруун бүс",  color: "text-violet-700", bg: "bg-violet-50 border-violet-200" },
  { key: "oronnnutag", label: "Ороннутаг",          color: "text-emerald-700",bg: "bg-emerald-50 border-emerald-200" },
];
const YEARS  = [2024, 2025, 2026];
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);

const MONTH_SHORT = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар",
                     "7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];

function formatDate(iso: string) {
  if (!iso) return "-";
  const d = new Date(`${iso}Z`);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ").slice(0, 16);
  return d.toLocaleString("mn-MN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

// ─── Import Card ─────────────────────────────────────────────
function ImportCard({
  region, instructions, latest, busy, onUpload, onOpenInfo,
}: {
  region:       Region;
  instructions: string[];
  latest:       LatestMap;
  busy:         string | null;
  onUpload:     (regionKey: string, year: number, month: number, file: File) => void;
  onOpenInfo:   (region: Region, lines: string[]) => void;
}) {
  const [year,  setYear]  = useState<number | null>(null);
  const [month, setMonth] = useState<number | null>(null);

  const latestEntry = year && month
    ? latest[region.key]?.[year]?.[month]
    : null;

  const isBusy = busy === `${region.key}-${year}-${month}`;

  return (
    <Card className={`relative border ${region.bg} p-5`}>
      {/* Badge */}
      <div className={`absolute right-3 top-3 rounded-lg px-2 py-1 text-[10px] font-semibold ${region.color} bg-white/70 border ${region.bg}`}>
        Эрхэт
      </div>

      {/* Title + info */}
      <div className="flex items-start justify-between pr-16">
        <div>
          <div className={`text-base font-semibold ${region.color}`}>{region.label}</div>
          <div className="mt-0.5 text-xs text-gray-500">Борлуулалтын дэлгэрэнгүй тайлан</div>
        </div>
        <button
          onClick={() => onOpenInfo(region, instructions)}
          className="rounded-lg bg-white/70 p-2 hover:bg-white transition-colors"
        >
          <Info size={16} className="text-gray-500" />
        </button>
      </div>

      {/* Year selector */}
      <div className="mt-4 space-y-2">
        <div className="text-xs font-medium text-gray-600">Он сонгох</div>
        <div className="flex gap-2 flex-wrap">
          {YEARS.map((y) => (
            <button
              key={y}
              onClick={() => { setYear(y); setMonth(null); }}
              className={`min-h-[44px] rounded-lg px-3 py-1.5 text-xs font-medium border transition-colors ${
                year === y
                  ? "bg-white border-gray-400 text-gray-900 shadow-sm"
                  : "bg-white/50 border-gray-200 text-gray-600 hover:bg-white"
              }`}
            >
              {y}
            </button>
          ))}
        </div>
      </div>

      {/* Month selector */}
      {year && (
        <div className="mt-3 space-y-2">
          <div className="text-xs font-medium text-gray-600">Сар сонгох</div>
          <div className="grid grid-cols-4 gap-1.5">
            {MONTHS.map((m) => {
              const hasFile = !!latest[region.key]?.[year]?.[m];
              return (
                <button
                  key={m}
                  onClick={() => setMonth(m)}
                  className={`relative min-h-[44px] rounded-lg px-2 py-1.5 text-xs font-medium border transition-colors ${
                    month === m
                      ? "bg-white border-gray-400 text-gray-900 shadow-sm"
                      : "bg-white/50 border-gray-200 text-gray-600 hover:bg-white"
                  }`}
                >
                  {m}-р
                  {hasFile && (
                    <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* File upload */}
      {year && month && (
        <div className="mt-4 space-y-2">
          {latestEntry && (
            <div className="rounded-lg bg-white/70 px-3 py-2 text-xs text-gray-600 border border-gray-200">
              <div className="font-medium text-gray-700 truncate">{latestEntry.filename}</div>
              <div>{formatDate(latestEntry.uploaded_at)} · {latestEntry.uploaded_by}</div>
            </div>
          )}
          <label className={`inline-flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white cursor-pointer transition-colors ${
            isBusy ? "bg-gray-400 cursor-not-allowed" : "bg-[#0071E3] hover:bg-[#0064c8]"
          }`}>
            <UploadCloud size={16} />
            {isBusy
              ? "Оруулж байна..."
              : latestEntry
              ? `${year}/${month}-р сарыг дахин оруулах`
              : `${year}/${month}-р сарын файл оруулах`}
            <input
              type="file"
              accept=".xlsx,.xls"
              className="hidden"
              disabled={!!busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) onUpload(region.key, year, month, file);
                e.currentTarget.value = "";
              }}
            />
          </label>
        </div>
      )}
    </Card>
  );
}

// ─── Main page ────────────────────────────────────────────────
export default function SalesReportDetail() {
  const isAdmin = localStorage.getItem("role") === "admin";

  const [tab, setTab] = useState<"import" | "report">("import");
  const [logs, setLogs]       = useState<ImportLog[]>([]);
  const [latest, setLatest]   = useState<LatestMap>({});
  const [instructions, setInstructions] = useState<Record<string, string[]>>({});
  const [busy, setBusy]       = useState<string | null>(null);
  const [flash, setFlash]     = useState<{ msg: string; ok: boolean } | null>(null);

  // Info / instruction modal
  const [modal, setModal]     = useState<{ open: boolean; region: Region | null; lines: string[] }>({ open: false, region: null, lines: [] });
  const [editMode, setEditMode]   = useState(false);
  const [editLines, setEditLines] = useState<string[]>([]);
  const [saving, setSaving]       = useState(false);

  // Log filter
  const [filterRegion, setFilterRegion] = useState("all");

  // Dashboard state
  const [dashFilters, setDashFilters] = useState<DashFilters>({ region: null, year: null, month: null });
  const [dashData, setDashData]       = useState<DashData | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const [dashError, setDashError]     = useState<string | null>(null);

  // Excluded brands filter
  const [excludedBrands,  setExcludedBrands]  = useState<string[]>([]);
  const [brandInput,      setBrandInput]       = useState("");
  const [savingBrands,    setSavingBrands]     = useState(false);
  const [allBrands,       setAllBrands]        = useState<string[]>([]);

  // Rankings sort + search (data comes from dashData)
  const [rankSortBy,       setRankSortBy]       = useState<"growth" | "amount">("growth");
  const [custSearch,       setCustSearch]       = useState("");
  const [brandSearch,      setBrandSearch]      = useState("");

  const showFlash = (msg: string, ok = true) => {
    setFlash({ msg, ok });
    setTimeout(() => setFlash(null), 3500);
  };

  const loadData = async () => {
    const [logsRes, latestRes, instrRes, exclRes, brandsRes] = await Promise.all([
      api.get("/sales-report/imports"),
      api.get("/sales-report/latest"),
      api.get("/sales-report/instructions"),
      api.get("/sales-report/excluded-brands"),
      api.get("/sales-report/brands"),
    ]);
    setLogs(logsRes.data);
    setInstructions(instrRes.data);
    setExcludedBrands(exclRes.data.brands);
    setAllBrands(brandsRes.data);

    // build LatestMap: region → year → month → entry
    const map: LatestMap = {};
    for (const e of latestRes.data as any[]) {
      if (!map[e.region]) map[e.region] = {};
      if (!map[e.region][e.year]) map[e.region][e.year] = {};
      map[e.region][e.year][e.month] = { filename: e.filename, uploaded_at: e.uploaded_at, uploaded_by: e.uploaded_by };
    }
    setLatest(map);
  };

  const loadDashboard = async (f: DashFilters) => {
    setDashLoading(true);
    setDashError(null);
    try {
      const params: Record<string, string> = {};
      if (f.region) params.region = f.region;
      if (f.year)   params.year   = String(f.year);
      if (f.month)  params.month  = String(f.month);
      const res = await api.get("/sales-report/dashboard", { params });
      setDashData(res.data);
    } catch {
      setDashError("Тайлан ачааллахад алдаа гарлаа");
    } finally {
      setDashLoading(false);
    }
  };

  const applyDashFilters = (f: DashFilters) => {
    setDashFilters(f);
    loadDashboard(f);
  };

  const saveExcludedBrands = async (brands: string[]) => {
    setSavingBrands(true);
    try {
      await api.put("/sales-report/excluded-brands", { brands });
      setExcludedBrands(brands);
      showFlash("Хадгалагдлаа — тайлан шинэчлэгдэж байна...");
      await loadDashboard(dashFilters);
    } catch {
      showFlash("Хадгалахад алдаа гарлаа", false);
    } finally {
      setSavingBrands(false);
    }
  };

  useEffect(() => { loadData(); }, []);

  useEffect(() => {
    if (tab === "report") loadDashboard(dashFilters);
  }, [tab]);

  const onUpload = async (regionKey: string, year: number, month: number, file: File) => {
    const busyKey = `${regionKey}-${year}-${month}`;
    setBusy(busyKey);
    try {
      const fd = new FormData();
      fd.append("region", regionKey);
      fd.append("year", String(year));
      fd.append("month", String(month));
      fd.append("f", file);
      await api.post("/sales-report/upload", fd);
      await loadData();
      showFlash(`${REGIONS.find(r => r.key === regionKey)?.label} ${year}/${month}-р сарын файл амжилттай орууллаа`);
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа", false);
    } finally {
      setBusy(null);
    }
  };

  const openInfo = (region: Region, lines: string[]) => {
    setModal({ open: true, region, lines });
    setEditMode(false);
    setEditLines([]);
  };

  const saveInstructions = async () => {
    if (!modal.region) return;
    setSaving(true);
    try {
      await api.put(`/sales-report/instructions/${modal.region.key}`, { lines: editLines });
      const updated = editLines.filter(l => l.trim());
      setInstructions(prev => ({ ...prev, [modal.region!.key]: updated }));
      setModal(prev => ({ ...prev, lines: updated }));
      setEditMode(false);
    } catch {
      showFlash("Хадгалахад алдаа гарлаа", false);
    } finally {
      setSaving(false);
    }
  };

  const filteredLogs = useMemo(() =>
    filterRegion === "all" ? logs : logs.filter(l => l.region === filterRegion),
    [logs, filterRegion]
  );

  const [reparsing, setReparsing] = useState(false);
  const reparseAll = async () => {
    setReparsing(true);
    try {
      const res = await api.post("/sales-report/reparse-all");
      const { processed, results } = res.data;
      const errors = results.filter((r: any) => !r.ok);
      if (errors.length === 0) {
        showFlash(`${processed} файл амжилттай боловсруулагдлаа`);
      } else {
        showFlash(`${processed - errors.length}/${processed} амжилттай. ${errors.length} алдаатай.`, false);
      }
      await loadData();
    } catch (e: any) {
      showFlash(e?.response?.data?.detail ?? "Боловсруулахад алдаа гарлаа", false);
    } finally {
      setReparsing(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <BarChart3 size={22} className="text-[#0071E3]" />
        <div>
          <div className="text-2xl font-semibold text-gray-900">Борлуулалтын тайлан дэлгэрэнгүй</div>
          <div className="mt-0.5 text-sm text-gray-500">Эрхэт системийн борлуулалтын тайлан импорт болон боловсруулалт</div>
        </div>
      </div>

      {/* Flash — fixed bottom on mobile, static on sm+ */}
      {flash && (
        <div className={`fixed bottom-4 left-4 right-4 z-50 sm:static sm:mt-4 rounded-xl px-4 py-3 text-sm font-medium shadow-lg sm:shadow-none ${flash.ok ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {flash.msg}
        </div>
      )}

      {/* Tabs — sticky on mobile */}
      <div className="sticky top-0 z-20 bg-white mt-5 flex gap-1 border-b border-gray-200">
        {(["import", "report"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-[#0071E3] text-[#0071E3]"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            {t === "import" ? "Импорт" : "Боловсруулсан тайлан"}
          </button>
        ))}
      </div>

      {/* ── Import tab ─────────────────────────────────────── */}
      {tab === "import" && (
        <>
          <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {REGIONS.map((region) => (
              <ImportCard
                key={region.key}
                region={region}
                instructions={instructions[region.key] ?? []}
                latest={latest}
                busy={busy}
                onUpload={onUpload}
                onOpenInfo={openInfo}
              />
            ))}
          </div>

          {/* Import log */}
          <div className="mt-8 rounded-2xl bg-white p-4 sm:p-6 shadow-sm">
            <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <div className="text-base font-semibold text-gray-900">Импортын түүх</div>
                {/* Full text button — desktop only */}
                <button
                  onClick={reparseAll}
                  disabled={reparsing}
                  className="hidden sm:inline-flex items-center gap-1.5 rounded-lg bg-gray-100 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                >
                  {reparsing ? "Боловсруулж байна..." : "Дахин боловсруулах"}
                </button>
                {/* Icon-only button — mobile only */}
                <button
                  onClick={reparseAll}
                  disabled={reparsing}
                  title="Дахин боловсруулах"
                  className="sm:hidden inline-flex items-center justify-center rounded-lg bg-gray-100 p-2 text-gray-700 hover:bg-gray-200 disabled:opacity-50 transition-colors"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                    <path d="M21 3v5h-5"/>
                    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                    <path d="M8 16H3v5"/>
                  </svg>
                </button>
              </div>
              {/* Region filter */}
              <div className="relative">
                <select
                  value={filterRegion}
                  onChange={e => setFilterRegion(e.target.value)}
                  className="appearance-none rounded-lg border border-gray-200 bg-white pl-3 pr-8 py-1.5 text-xs text-gray-700 focus:outline-none"
                >
                  <option value="all">Бүгд</option>
                  {REGIONS.map(r => (
                    <option key={r.key} value={r.key}>{r.label}</option>
                  ))}
                </select>
                <ChevronDown size={12} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-gray-400" />
              </div>
            </div>

            {/* Mobile card list — sm:hidden */}
            <div className="sm:hidden space-y-2">
              {filteredLogs.length === 0 && (
                <div className="py-8 text-center text-sm text-gray-400">Импорт хийгдсэн файл байхгүй байна</div>
              )}
              {filteredLogs.map((l) => (
                <div key={l.id} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="font-semibold text-sm text-gray-800">{l.region_label}</div>
                    <div className="text-xs text-gray-400 shrink-0">{formatDate(l.uploaded_at)}</div>
                  </div>
                  <div className="mt-1 text-xs text-gray-500">{l.year}/{String(l.month).padStart(2, "0")}</div>
                  <div className="mt-1 text-xs text-gray-500 truncate max-w-full">{l.filename}</div>
                  <div className="mt-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs ${l.status === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                      {l.status === "ok" ? "Амжилттай" : "Алдаатай"}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Desktop table — hidden on mobile */}
            <div className="hidden sm:block max-h-80 overflow-auto rounded-xl border border-gray-100">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white shadow-sm text-left text-gray-500">
                  <tr>
                    <th className="px-4 py-3">Огноо</th>
                    <th className="px-4 py-3">Бүс</th>
                    <th className="px-4 py-3">Он / Сар</th>
                    <th className="px-4 py-3">Файл</th>
                    <th className="px-4 py-3">Хэрэглэгч</th>
                    <th className="px-4 py-3">Төлөв</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {filteredLogs.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-center text-gray-400">Импорт хийгдсэн файл байхгүй байна</td></tr>
                  )}
                  {filteredLogs.map((l) => (
                    <tr key={l.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 text-xs">{formatDate(l.uploaded_at)}</td>
                      <td className="px-4 py-2.5 text-xs font-medium">{l.region_label}</td>
                      <td className="px-4 py-2.5 text-xs">{l.year}/{String(l.month).padStart(2, "0")}</td>
                      <td className="px-4 py-2.5 text-xs text-gray-600 max-w-[160px] truncate">{l.filename}</td>
                      <td className="px-4 py-2.5 text-xs">{l.uploaded_by}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs ${l.status === "ok" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                          {l.status === "ok" ? "Амжилттай" : "Алдаатай"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Report tab ──────────────────────────────────────── */}
      {tab === "report" && (
        <div className="mt-5 space-y-5">

          {/* Filter bar */}
          <div className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end sm:gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-500">Бүс</label>
                <select
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none"
                  value={dashFilters.region ?? ""}
                  onChange={e => applyDashFilters({ ...dashFilters, region: e.target.value || null })}
                >
                  <option value="">Бүгд</option>
                  {REGIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-500">Он</label>
                <select
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none"
                  value={dashFilters.year ?? ""}
                  onChange={e => applyDashFilters({ ...dashFilters, year: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Бүгд</option>
                  {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-500">Сар</label>
                <select
                  className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none"
                  value={dashFilters.month ?? ""}
                  onChange={e => applyDashFilters({ ...dashFilters, month: e.target.value ? Number(e.target.value) : null })}
                >
                  <option value="">Бүгд</option>
                  {MONTHS.map(m => <option key={m} value={m}>{MONTH_SHORT[m - 1]}</option>)}
                </select>
              </div>
              <div className="flex gap-2 col-span-2 sm:col-span-1">
                <button
                  className="flex-1 sm:flex-none rounded-lg border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                  onClick={() => applyDashFilters({ region: null, year: null, month: null })}
                >
                  Цэвэрлэх
                </button>
                <button
                  className="flex-1 sm:flex-none sm:ml-auto rounded-lg bg-[#0071E3] px-3 py-1.5 text-xs font-medium text-white hover:bg-[#0064c8]"
                  onClick={() => loadDashboard(dashFilters)}
                >
                  Шинэчлэх
                </button>
              </div>
            </div>

            {/* ── Үл тооцох брэндүүд ── */}
            <div className="mt-3 pt-3 border-t border-gray-100">
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-gray-600">
                  Үл тооцох брэндүүд
                </label>
                <span className="text-[10px] text-gray-400">
                  {excludedBrands.length > 0
                    ? `${excludedBrands.length} брэнд хасагдсан`
                    : "Бүх брэнд тооцогдож байна"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 rounded-xl border border-gray-200 bg-gray-50 px-2.5 py-2 min-h-[38px] focus-within:border-[#0071E3] focus-within:bg-white transition-colors">
                {excludedBrands.map(b => (
                  <span key={b}
                    className="inline-flex items-center gap-1 rounded-full bg-red-50 border border-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700">
                    {b}
                    <button type="button"
                      onClick={() => setExcludedBrands(prev => prev.filter(x => x !== b))}
                      className="hover:text-red-900 transition-colors">
                      <X size={10} />
                    </button>
                  </span>
                ))}
                <input
                  value={brandInput}
                  onChange={e => {
                    const v = e.target.value;
                    setBrandInput(v);
                    // Datalist-с хулганаар сонгоход автоматаар chip нэмэх
                    if (allBrands.includes(v) && !excludedBrands.includes(v)) {
                      setExcludedBrands(prev => [...prev, v]);
                      setBrandInput("");
                    }
                  }}
                  onKeyDown={e => {
                    if (e.key === "Enter" && brandInput.trim()) {
                      const v = brandInput.trim();
                      if (!excludedBrands.includes(v))
                        setExcludedBrands(prev => [...prev, v]);
                      setBrandInput("");
                      e.preventDefault();
                    }
                    if (e.key === "Backspace" && !brandInput && excludedBrands.length > 0)
                      setExcludedBrands(prev => prev.slice(0, -1));
                  }}
                  list="brand-suggestions"
                  placeholder={excludedBrands.length === 0 ? "Брэнд нэр оруулж Enter эсвэл + дарна..." : "Брэнд нэмэх..."}
                  className="flex-1 min-w-[140px] bg-transparent text-xs outline-none placeholder:text-gray-400"
                />
                {brandInput.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      const v = brandInput.trim();
                      if (v && !excludedBrands.includes(v))
                        setExcludedBrands(prev => [...prev, v]);
                      setBrandInput("");
                    }}
                    className="flex-shrink-0 rounded-full bg-gray-200 hover:bg-gray-300 p-1 transition-colors"
                    title="Нэмэх">
                    <Plus size={10} className="text-gray-600" />
                  </button>
                )}
                <datalist id="brand-suggestions">
                  {allBrands.filter(b => !excludedBrands.includes(b)).map(b => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              </div>
              <div className="flex justify-end mt-2">
                <button
                  onClick={() => saveExcludedBrands(excludedBrands)}
                  disabled={savingBrands}
                  className="rounded-lg bg-red-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-1.5">
                  {savingBrands ? (
                    <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white/30 border-t-white" /> Хадгалж байна...</>
                  ) : "Хадгалах ба шинэчлэх"}
                </button>
              </div>
            </div>
          </div>

          {/* Loading */}
          {dashLoading && (
            <div className="rounded-2xl bg-white py-12 text-center text-sm text-gray-400 shadow-sm">
              Тайлан ачааллаж байна...
            </div>
          )}

          {/* Error */}
          {dashError && !dashLoading && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {dashError}
            </div>
          )}

          {/* KPI summary cards */}
          {dashData && !dashLoading && (
            <div className="grid grid-cols-3 gap-3 sm:gap-4">
              <Card className="p-4 sm:p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Нийт борлуулалт</div>
                <div className="mt-2 font-semibold text-gray-900 leading-tight">
                  <span className="text-sm sm:hidden">{fmtShort(dashData.total_amount)}</span>
                  <span className="hidden sm:inline text-2xl">{dashData.total_amount.toLocaleString("mn-MN")}₮</span>
                </div>
              </Card>
              <Card className="p-4 sm:p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Харилцагч тоо</div>
                <div className="mt-2 text-lg sm:text-2xl font-semibold text-gray-900">
                  {dashData.top_customers.length.toLocaleString()}
                </div>
              </Card>
              <Card className="p-4 sm:p-5">
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">Брэнд тоо</div>
                <div className="mt-2 text-lg sm:text-2xl font-semibold text-gray-900">
                  {dashData.top_brands.length.toLocaleString()}
                </div>
              </Card>
            </div>
          )}

          {/* Top customers */}
          {dashData && !dashLoading && dashData.top_customers.length > 0 && (
            <div className="rounded-2xl bg-white shadow-sm">
              <div className="px-5 pt-5 pb-3 text-base font-semibold text-gray-900">Топ харилцагчид</div>

              {/* Mobile: card list — no horizontal scroll */}
              <div className="sm:hidden max-h-80 overflow-y-auto divide-y divide-gray-100">
                {dashData.top_customers.map((c, i) => (
                  <div key={`${c.customer_code}-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-xs text-gray-400 w-5 shrink-0 text-right">{i + 1}</span>
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{c.customer_name}</div>
                        <div className="text-xs text-gray-400">{c.customer_code}</div>
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="text-xs font-semibold">{c.total_amount.toLocaleString("mn-MN")}₮</div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden sm:block max-h-80 overflow-auto px-5 pb-5">
                <div className="rounded-xl border border-gray-100">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white text-left text-gray-500 shadow-sm">
                      <tr>
                        <th className="w-8 px-4 py-3">#</th>
                        <th className="px-4 py-3">Код</th>
                        <th className="px-4 py-3">Харилцагч</th>
                        <th className="px-4 py-3 text-right">Борлуулалт</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {dashData.top_customers.map((c, i) => (
                        <tr key={`${c.customer_code}-${i}`} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 text-xs text-gray-400">{i + 1}</td>
                          <td className="px-4 py-2.5 font-mono text-xs text-gray-600">{c.customer_code}</td>
                          <td className="px-4 py-2.5 text-xs font-medium">{c.customer_name}</td>
                          <td className="px-4 py-2.5 text-right text-xs font-semibold">
                            {c.total_amount.toLocaleString("mn-MN")}₮
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* Top brands table */}
          {dashData && !dashLoading && dashData.top_brands.length > 0 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <div className="mb-3 text-base font-semibold text-gray-900">Брэндээр ангилсан борлуулалт</div>
              <div className="max-h-80 overflow-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-gray-500 shadow-sm">
                    <tr>
                      <th className="w-8 px-4 py-3">#</th>
                      <th className="px-4 py-3">Брэнд</th>
                      <th className="px-4 py-3 text-right">Борлуулалт</th>
                      <th className="hidden sm:table-cell px-4 py-3 text-right">Хувь %</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {dashData.top_brands.map((b, i) => {
                      const pct = dashData.total_amount > 0
                        ? ((b.total_amount / dashData.total_amount) * 100).toFixed(1)
                        : "0.0";
                      return (
                        <tr key={b.brand} className="hover:bg-gray-50">
                          <td className="px-4 py-2.5 text-xs text-gray-400">{i + 1}</td>
                          <td className="px-4 py-2.5 text-xs font-medium">{b.brand}</td>
                          <td className="px-4 py-2.5 text-right text-xs font-semibold">
                            {b.total_amount.toLocaleString("mn-MN")}₮
                          </td>
                          <td className="hidden sm:table-cell px-4 py-2.5 text-right text-xs text-gray-500">{pct}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Monthly trend table (only shown when ≥2 months) */}
          {dashData && !dashLoading && dashData.monthly_trend.length > 1 && (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <div className="mb-3 text-base font-semibold text-gray-900">Сарын дүн</div>
              <div className="overflow-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-gray-500 shadow-sm">
                    <tr>
                      <th className="px-4 py-3">Он / Сар</th>
                      <th className="px-4 py-3 text-right">Борлуулалт</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {dashData.monthly_trend.map(t => (
                      <tr key={`${t.year}-${t.month}`} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 text-xs">{t.year} / {MONTH_SHORT[t.month - 1]}</td>
                        <td className="px-4 py-2.5 text-right text-xs font-semibold">
                          {t.total_amount.toLocaleString("mn-MN")}₮
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── Customer rankings ── */}
          {dashData && !dashLoading && (dashData.customer_ranks?.length ?? 0) > 0 && (() => {
            const q = custSearch.trim().toLowerCase();
            const sorted = [...(dashData.customer_ranks ?? [])].sort(
              rankSortBy === "amount"
                ? (a, b) => b.total_amount - a.total_amount
                : (a, b) =>
                    (a.growth_pct === null ? 1 : 0) - (b.growth_pct === null ? 1 : 0) ||
                    (b.growth_pct ?? -Infinity) - (a.growth_pct ?? -Infinity)
            );
            const filtered = q
              ? sorted.filter(c =>
                  c.customer_name.toLowerCase().includes(q) ||
                  c.customer_code.toLowerCase().includes(q) ||
                  (c.phone || "").includes(q) ||
                  c.total_amount.toLocaleString("mn-MN").includes(q) ||
                  (c.growth_pct?.toFixed(1) ?? "").includes(q)
                )
              : sorted;
            return (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-base font-semibold text-gray-900">
                    Харилцагчдын өсөлт/бууралтын ранк
                  </div>
                  <span className="text-xs text-gray-400">
                    {q ? `${filtered.length} / ${sorted.length}` : sorted.length} харилцагч · {dashData.available_months?.length ?? 0} сар
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 sm:flex-none">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={custSearch}
                      onChange={e => setCustSearch(e.target.value)}
                      placeholder="Хайх (нэр, код, утас, дүн...)"
                      className="w-full sm:w-52 rounded-lg border border-gray-200 pl-8 pr-3 py-1.5 text-xs focus:border-[#0071E3] focus:outline-none"
                    />
                  </div>
                  <div className="flex gap-1 rounded-lg bg-gray-100 p-1 text-xs">
                    <button onClick={() => setRankSortBy("growth")}
                      className={`rounded px-2 py-1 transition-colors ${rankSortBy === "growth" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                      Өсөлтөөр</button>
                    <button onClick={() => setRankSortBy("amount")}
                      className={`rounded px-2 py-1 transition-colors ${rankSortBy === "amount" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                      Дүнгээр</button>
                  </div>
                </div>
              </div>
              {/* Mobile: card list — no horizontal scroll */}
              <div className="sm:hidden max-h-[600px] overflow-y-auto divide-y divide-gray-100 rounded-xl border border-gray-100">
                {filtered.map((c, i) => (
                  <div key={c.customer_code || i} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <span className="text-xs text-gray-400 w-5 shrink-0 mt-0.5 text-right">{i + 1}</span>
                        <div className="min-w-0">
                          <div className="text-xs font-medium leading-snug">{c.customer_name}</div>
                          <div className="text-xs text-gray-400">{c.customer_code}</div>
                          {c.phone && <div className="text-xs text-gray-500 mt-0.5">{c.phone}</div>}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-xs font-semibold">{c.total_amount.toLocaleString("mn-MN")}₮</div>
                        <div className="mt-1"><GrowthBadge pct={c.growth_pct} /></div>
                        <div className="mt-1.5"><Sparkline points={c.monthly} W={80} H={28} /></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden sm:block max-h-[600px] overflow-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-xs text-gray-500 shadow-sm">
                    <tr>
                      <th className="w-8 px-3 py-3">#</th>
                      <th className="px-3 py-3">Харилцагч</th>
                      <th className="px-3 py-3">Утас</th>
                      <th className="px-3 py-3 text-right">Нийт дүн</th>
                      <th className="px-3 py-3 text-center">Тренд %/сар</th>
                      <th className="hidden md:table-cell px-3 py-3 text-center">Тренд график</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((c, i) => (
                      <tr key={c.customer_code || i} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-xs text-gray-400">{i + 1}</td>
                        <td className="px-3 py-2">
                          <div className="text-xs font-medium">{c.customer_name}</div>
                          <div className="text-xs text-gray-400">{c.customer_code}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-600">
                          {c.phone || <span className="text-gray-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-xs font-semibold">
                          {c.total_amount.toLocaleString("mn-MN")}₮
                        </td>
                        <td className="px-3 py-2 text-center">
                          <GrowthBadge pct={c.growth_pct} />
                        </td>
                        <td className="hidden md:table-cell px-3 py-2 text-center">
                          <Sparkline points={c.monthly} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}

          {/* ── Brand rankings ── */}
          {dashData && !dashLoading && (dashData.brand_ranks?.length ?? 0) > 0 && (() => {
            const q = brandSearch.trim().toLowerCase();
            const sorted = [...(dashData.brand_ranks ?? [])].sort(
              rankSortBy === "amount"
                ? (a, b) => b.total_amount - a.total_amount
                : (a, b) =>
                    (a.growth_pct === null ? 1 : 0) - (b.growth_pct === null ? 1 : 0) ||
                    (b.growth_pct ?? -Infinity) - (a.growth_pct ?? -Infinity)
            );
            const filtered = q
              ? sorted.filter(b =>
                  b.brand.toLowerCase().includes(q) ||
                  b.total_amount.toLocaleString("mn-MN").includes(q) ||
                  (b.growth_pct?.toFixed(1) ?? "").includes(q)
                )
              : sorted;
            return (
            <div className="rounded-2xl bg-white p-5 shadow-sm">
              <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
                <div className="flex items-center gap-2 flex-wrap">
                  <div className="text-base font-semibold text-gray-900">Брэндийн өсөлт/бууралтын ранк</div>
                  <span className="text-xs text-gray-400">
                    {q ? `${filtered.length} / ${sorted.length}` : sorted.length} брэнд · {dashData.available_months?.length ?? 0} сар
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1 sm:flex-none">
                    <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                    <input
                      type="text"
                      value={brandSearch}
                      onChange={e => setBrandSearch(e.target.value)}
                      placeholder="Хайх (брэнд, дүн...)"
                      className="w-full sm:w-44 rounded-lg border border-gray-200 pl-8 pr-3 py-1.5 text-xs focus:border-[#0071E3] focus:outline-none"
                    />
                  </div>
                  <div className="flex gap-1 rounded-lg bg-gray-100 p-1 text-xs">
                    <button onClick={() => setRankSortBy("growth")}
                      className={`rounded px-2 py-1 transition-colors ${rankSortBy === "growth" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                      Өсөлтөөр</button>
                    <button onClick={() => setRankSortBy("amount")}
                      className={`rounded px-2 py-1 transition-colors ${rankSortBy === "amount" ? "bg-white shadow-sm font-medium text-gray-900" : "text-gray-500 hover:text-gray-700"}`}>
                      Дүнгээр</button>
                  </div>
                </div>
              </div>
              {/* Mobile: card list — no horizontal scroll */}
              <div className="sm:hidden max-h-[600px] overflow-y-auto divide-y divide-gray-100 rounded-xl border border-gray-100">
                {filtered.map((b, i) => (
                  <div key={b.brand} className="px-3 py-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0">
                        <span className="text-xs text-gray-400 w-5 shrink-0 mt-0.5 text-right">{i + 1}</span>
                        <div className="text-xs font-medium leading-snug min-w-0 truncate">{b.brand}</div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-xs font-semibold">{b.total_amount.toLocaleString("mn-MN")}₮</div>
                        <div className="mt-1"><GrowthBadge pct={b.growth_pct} /></div>
                        <div className="mt-1.5"><Sparkline points={b.monthly} W={80} H={28} /></div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table */}
              <div className="hidden sm:block max-h-[600px] overflow-auto rounded-xl border border-gray-100">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white text-left text-xs text-gray-500 shadow-sm">
                    <tr>
                      <th className="w-8 px-3 py-3">#</th>
                      <th className="px-3 py-3">Брэнд</th>
                      <th className="px-3 py-3 text-right">Нийт дүн</th>
                      <th className="px-3 py-3 text-center">Тренд %/сар</th>
                      <th className="hidden md:table-cell px-3 py-3 text-center">Тренд график</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filtered.map((b, i) => (
                      <tr key={b.brand} className="hover:bg-gray-50">
                        <td className="px-3 py-2 text-xs text-gray-400">{i + 1}</td>
                        <td className="px-3 py-2 text-xs font-medium">{b.brand}</td>
                        <td className="px-3 py-2 text-right text-xs font-semibold">
                          {b.total_amount.toLocaleString("mn-MN")}₮
                        </td>
                        <td className="px-3 py-2 text-center">
                          <GrowthBadge pct={b.growth_pct} />
                        </td>
                        <td className="hidden md:table-cell px-3 py-2 text-center">
                          <Sparkline points={b.monthly} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            );
          })()}

          {/* Empty state */}
          {dashData && !dashLoading && dashData.total_amount === 0 && (
            <div className="rounded-2xl bg-white py-16 text-center shadow-sm">
              <BarChart3 size={48} className="mx-auto mb-4 text-gray-200" />
              <div className="text-sm text-gray-400">
                Сонгосон шүүлтүүрт тохирох дата олдсонгүй.<br />
                Импортын табаас файл оруулсны дараа тайлан гарна.
              </div>
            </div>
          )}

        </div>
      )}

      {/* Instructions modal */}
      <Modal
        open={modal.open}
        title={`${modal.region?.label ?? ""} — заавар`}
        onClose={() => { setModal({ open: false, region: null, lines: [] }); setEditMode(false); }}
      >
        {!editMode ? (
          <>
            <ol className="list-decimal pl-5 space-y-2 text-sm text-gray-700">
              {modal.lines.map((x, i) => <li key={i}>{x}</li>)}
            </ol>
            {isAdmin && modal.region && (
              <div className="mt-5 flex justify-end">
                <button
                  onClick={() => { setEditLines([...modal.lines]); setEditMode(true); }}
                  className="inline-flex items-center gap-2 rounded-xl bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200"
                >
                  <Pencil size={14} /> Заавар засах
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="space-y-2">
              {editLines.map((line, i) => (
                <div key={i} className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right text-xs text-gray-400">{i + 1}.</span>
                  <input
                    className="flex-1 rounded-lg border border-gray-200 px-3 py-2 text-sm focus:border-[#0071E3] focus:outline-none"
                    value={line}
                    onChange={(e) => { const n = [...editLines]; n[i] = e.target.value; setEditLines(n); }}
                  />
                  <button
                    onClick={() => setEditLines(editLines.filter((_, j) => j !== i))}
                    className="text-gray-400 hover:text-red-500"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <button
              className="mt-3 inline-flex items-center gap-1 text-sm text-[#0071E3] hover:underline"
              onClick={() => setEditLines([...editLines, ""])}
            >
              <Plus size={14} /> Мөр нэмэх
            </button>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                onClick={() => setEditMode(false)}
              >
                Болих
              </button>
              <button
                className="rounded-xl bg-[#0071E3] px-4 py-2 text-sm text-white hover:opacity-90 disabled:opacity-60"
                disabled={saving}
                onClick={saveInstructions}
              >
                {saving ? "Хадгалж байна..." : "Хадгалах"}
              </button>
            </div>
          </>
        )}
      </Modal>
    </motion.div>
  );
}
