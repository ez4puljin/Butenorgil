import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";
import {
  Download, FileSpreadsheet, CheckCircle2, AlertCircle, MapPinned, Printer,
  FileDown, Settings2, ChevronDown, ChevronRight, RefreshCw, Save,
} from "lucide-react";

// ── Тайлангийн тодорхойлолт ───────────────────────────────────────────────────
type ReportCard = {
  key: string;
  title: string;
  scriptNote?: string;          // .py файлын нэр
  description: string;
  requiredTypes: number[];       // ямар upload type хэрэгтэй
};

const TYPE_LABEL: Record<number, string> = {
  1: "Эрхэт бараа",
  2: "Эрксэс бараа",
  3: "Орлого тайлан",
  4: "Хөдөлгөөний тайлан",
  5: "Үлдэгдэл тайлан",
  6: "Борлуулалт тайлан",
  7: "Дарагдсан барааны тайлан",
};

const REPORT_CARDS: ReportCard[] = [
  {
    key: "ulailt",
    title: "Улайлт тайлан",
    scriptNote: "done.py",
    description: "Үлдэгдлийн 3 файлын аль нэгийг сонгоод улайлт тайлан гаргана (Бүх агуулах / Үндсэн заал / Архины заал).",
    requiredTypes: [],   // Үлдэгдлийн файл оруулалт (BalanceFile)-аас уншина — runtime-д шалгана
  },
  {
    key: "no_movement",
    title: "Орлого байсан ч хөдөлгөөнгүй",
    description: "Сүүлийн N хоногт агуулахад орлого авсан мөртлөө хөдөлгөөний файлд огт гараагүй бараа. Заалд шууд орсон орлогыг тооцохгүй; зөвхөн мастерын 4 агуулахын тагтай (Бөөний, Архи ус ундаа, Жижиглэн, Гэрээт) бараа.",
    requiredTypes: [],   // Орлогын файл / Хөдөлгөөний файл оруулалтаас — runtime-д шалгана
  },
  {
    key: "inventory_adj",
    title: "Дарагдсан барааны тайлан",
    description: "type=7 файлын tickUsed=False мөрүүдийг шүүж тайлан гаргана.",
    requiredTypes: [7],
  },
  {
    key: "last_purchase_price",
    title: "Барааны сүүлийн орлогоны тайлан",
    scriptNote: "last_purchase_price.py",
    description: "Орлого тайланаас (type=3) бараа бүрийн хамгийн сүүлийн орлогоны үнэ гаргана.",
    requiredTypes: [3],
  },
];

// ── Tag vs Байршил зөрүүтэй орлого шалгагч ───────────────────────────────────

type TagLocRow = {
  date: string; doc_no: string; code: string; name: string;
  product_tags: string; qty: number; unit_price: number; amount: number; user: string;
};
type TagLocGroup = {
  location: string; allowed_tags: string[]; rows: TagLocRow[];
  count: number; total_amount: number;
};
type TagLocResult = {
  date_from: string; date_to: string;
  summary: { total_rows: number; ok: number; mismatch: number; master_not_found: number; ignored: number; truncated: number };
  unmapped_locations: Record<string, number>;
  groups: TagLocGroup[];
  meta: { locations_in_range: Record<string, number>; all_tags: string[]; config: { map: Record<string, string[]>; ignore_locations: string[] } };
};

const fmtN = (v: number) => {
  const f = Number(v || 0);
  return f === Math.trunc(f) ? Math.trunc(f).toLocaleString("mn-MN") : f.toLocaleString("mn-MN", { maximumFractionDigits: 2 });
};

function TagLocationChecker() {
  const today = new Date().toISOString().slice(0, 10);
  const [dateFrom, setDateFrom] = useState(today.slice(0, 8) + "01");
  const [dateTo, setDateTo] = useState(today);
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState("");
  const [res, setRes] = useState<TagLocResult | null>(null);
  // Харгалзааны тохиргоо засварлагч
  const [cfgOpen, setCfgOpen] = useState(false);
  const [cfgMap, setCfgMap] = useState<Record<string, string[]>>({});
  const [cfgIgnore, setCfgIgnore] = useState<string[]>([]);
  const [cfgSaving, setCfgSaving] = useState(false);

  const run = async () => {
    if (!dateFrom || !dateTo) { setError("Огноо сонгоно уу."); return; }
    setLoading(true); setError("");
    try {
      const r = await api.get("/reports/tag-location-check", { params: { date_from: dateFrom, date_to: dateTo } });
      setRes(r.data);
      setCfgMap(r.data?.meta?.config?.map ?? {});
      setCfgIgnore(r.data?.meta?.config?.ignore_locations ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Шалгахад алдаа гарлаа.");
      setRes(null);
    } finally { setLoading(false); }
  };

  const downloadPdf = async () => {
    setPdfLoading(true); setError("");
    try {
      const r = await api.get("/reports/tag-location-check/pdf", {
        params: { date_from: dateFrom, date_to: dateTo }, responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/pdf" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `tag_bairshil_zoruu_${dateFrom}_${dateTo}.pdf`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "PDF татахад алдаа гарлаа.");
    } finally { setPdfLoading(false); }
  };

  const toggleTag = (loc: string, tag: string) => {
    setCfgMap((m) => {
      const cur = new Set(m[loc] ?? []);
      cur.has(tag) ? cur.delete(tag) : cur.add(tag);
      return { ...m, [loc]: [...cur] };
    });
  };
  const toggleIgnore = (loc: string) => {
    setCfgIgnore((l) => (l.includes(loc) ? l.filter((x) => x !== loc) : [...l, loc]));
  };
  const saveCfg = async () => {
    setCfgSaving(true); setError("");
    try {
      await api.put("/reports/tag-location-check/config", { map: cfgMap, ignore_locations: cfgIgnore });
      await run();   // шинэ харгалзаагаар дахин шалгана
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Тохиргоо хадгалахад алдаа гарлаа.");
    } finally { setCfgSaving(false); }
  };

  const s = res?.summary;

  return (
    <div className="mt-6">
      {/* Хэвлэх үед зөвхөн preview хэсэг харагдана */}
      {res && (
        <style>{`@media print {
          body * { visibility: hidden !important; }
          #tagloc-print, #tagloc-print * { visibility: visible !important; }
          #tagloc-print { position: absolute; left: 0; top: 0; width: 100%; }
        }`}</style>
      )}

      {/* ── Шалгагч толгой ── */}
      <div className="rounded-apple bg-gradient-to-r from-violet-600 to-purple-600 p-4 text-white shadow-sm sm:p-5 print:hidden">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/20">
            <MapPinned size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-base font-bold sm:text-lg">Tag vs Байршил зөрүү</div>
            <div className="text-[12px] text-white/80 sm:text-[13px]">
              Орлого авагдсан байршил (L багана) мастерын "Байршил tag"-тай зөрсөн орлогуудыг шалгана — 2025-2026 оны бүх орлогоос
            </div>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2.5">
          <div>
            <label className="block text-[11px] font-semibold text-white/70">Эхлэх огноо</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="mt-1 rounded-lg border-0 bg-white/95 px-3 py-2 text-sm text-gray-800 outline-none" />
          </div>
          <div>
            <label className="block text-[11px] font-semibold text-white/70">Дуусах огноо</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="mt-1 rounded-lg border-0 bg-white/95 px-3 py-2 text-sm text-gray-800 outline-none" />
          </div>
          <button onClick={run} disabled={loading}
            className="inline-flex h-[38px] items-center gap-2 rounded-lg bg-white px-4 text-sm font-bold text-violet-700 shadow-sm hover:bg-violet-50 disabled:opacity-60">
            {loading ? <RefreshCw size={15} className="animate-spin" /> : <MapPinned size={15} />}
            {loading ? "Боловсруулж байна..." : "Tag vs Байршил зөрүүтэй орлого шалгах"}
          </button>
        </div>
        {error && <div className="mt-2 rounded-lg bg-red-500/30 px-3 py-1.5 text-[12px] font-medium">{error}</div>}
      </div>

      {/* ── Үр дүн ── */}
      {res && s && (
        <div className="mt-4">
          {/* Үйлдлийн мөр */}
          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <button onClick={() => window.print()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-gray-900 px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-gray-700">
              <Printer size={14} /> Хэвлэх
            </button>
            <button onClick={downloadPdf} disabled={pdfLoading}
              className="inline-flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-[12px] font-semibold text-white hover:bg-rose-700 disabled:opacity-60">
              {pdfLoading ? <RefreshCw size={14} className="animate-spin" /> : <FileDown size={14} />} PDF татах
            </button>
            <button onClick={() => setCfgOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-2 text-[12px] font-semibold text-amber-700 hover:bg-amber-100">
              <Settings2 size={14} /> Харгалзаа тохиргоо
              {cfgOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          </div>

          {/* Харгалзаа тохиргоо — байршил бүрд зөвшөөрөгдөх tag-ууд */}
          {cfgOpen && (
            <div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50/40 p-4 print:hidden">
              <div className="text-[13px] font-semibold text-gray-800">Байршил ↔ Master tag харгалзаа</div>
              <p className="mt-1 text-[11px] text-gray-500">
                Байршил бүр дээр аль tag-тай бараа авагдах нь ЗӨВ болохыг тэмдэглэнэ. Тэмдэглээгүй tag-тай бараа тухайн байршилд авагдвал зөрүүтэйд тооцно.
              </p>
              <div className="mt-3 space-y-2.5">
                {Object.keys(res.meta.locations_in_range).sort().map((loc) => (
                  <div key={loc} className="rounded-xl bg-white p-3 ring-1 ring-amber-100">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12.5px] font-bold text-gray-800">{loc}</span>
                      <span className="text-[10px] text-gray-400">({res.meta.locations_in_range[loc]} мөр)</span>
                      <label className="ml-auto inline-flex items-center gap-1 text-[11px] text-gray-500">
                        <input type="checkbox" checked={cfgIgnore.includes(loc)} onChange={() => toggleIgnore(loc)} />
                        Шалгалтаас алгасах
                      </label>
                    </div>
                    {!cfgIgnore.includes(loc) && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {res.meta.all_tags.map((tag) => {
                          const on = (cfgMap[loc] ?? []).includes(tag);
                          return (
                            <button key={tag} onClick={() => toggleTag(loc, tag)}
                              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ring-inset transition-colors ${
                                on ? "bg-violet-600 text-white ring-violet-600" : "bg-white text-gray-600 ring-gray-200 hover:bg-gray-50"
                              }`}>
                              {on ? "✓ " : ""}{tag}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <button onClick={saveCfg} disabled={cfgSaving}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-4 py-2 text-[12px] font-semibold text-white hover:bg-amber-700 disabled:opacity-60">
                {cfgSaving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />}
                Хадгалаад дахин шалгах
              </button>
            </div>
          )}

          {/* ── Preview (хэвлэгдэх хэсэг) ── */}
          <div id="tagloc-print" className="mt-3">
            <div className="hidden print:block pb-2 text-[15px] font-bold">
              Tag vs Байршил зөрүүтэй орлого — {res.date_from} … {res.date_to}
            </div>

            {/* Summary tiles */}
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
              {[
                { label: "Нийт орлогын мөр", v: s.total_rows, cls: "text-gray-800" },
                { label: "Зөв байршилд", v: s.ok, cls: "text-emerald-600" },
                { label: "Зөрүүтэй", v: s.mismatch, cls: "text-red-600" },
                { label: "Мастерт олдоогүй", v: s.master_not_found, cls: "text-amber-600" },
                { label: "Алгассан", v: s.ignored, cls: "text-gray-400" },
              ].map((t) => (
                <div key={t.label} className="rounded-xl border border-gray-100 bg-white p-3 shadow-sm">
                  <div className="text-[10.5px] font-medium text-gray-400">{t.label}</div>
                  <div className={`text-xl font-bold tabular-nums ${t.cls}`}>{t.v.toLocaleString("mn-MN")}</div>
                </div>
              ))}
            </div>

            {Object.keys(res.unmapped_locations).length > 0 && (
              <div className="mt-2.5 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800">
                ⚠ Харгалзаа тохируулаагүй байршил: {Object.entries(res.unmapped_locations).map(([l, c]) => `${l} (${c} мөр)`).join(", ")} — "Харгалзаа тохиргоо"-оос tag оноож өгнө үү.
              </div>
            )}
            {s.truncated > 0 && (
              <div className="mt-2.5 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 text-[12px] text-gray-500">
                Зөрүү их тул эхний 3,000 мөрийг харуулав — {s.truncated.toLocaleString("mn-MN")} мөр багтсангүй. Богино огнооны муж сонговол бүрэн харагдана.
              </div>
            )}

            {/* Бүлгүүд — зөрүүтэй байршил тус бүр */}
            {res.groups.length === 0 ? (
              <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center text-sm font-semibold text-emerald-700">
                ✓ Сонгосон хугацаанд байршлын зөрүүтэй орлого олдсонгүй
              </div>
            ) : res.groups.map((g) => (
              <div key={g.location} className="mt-4 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm print:break-inside-avoid">
                <div className="flex flex-wrap items-center gap-2 border-b border-gray-100 bg-violet-50/60 px-4 py-2.5">
                  <span className="text-[14px] font-bold text-violet-900">{g.location}</span>
                  <span className="rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-bold text-red-600 ring-1 ring-red-200">{g.count.toLocaleString("mn-MN")} мөр</span>
                  <span className="text-[12px] font-semibold tabular-nums text-gray-600">{fmtN(g.total_amount)}₮</span>
                  <span className="ml-auto text-[10.5px] text-gray-400">Зөвшөөрөгдөх tag: {g.allowed_tags.join(", ")}</span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-[12px]">
                    <thead>
                      <tr className="border-b border-gray-100 bg-gray-50/60 text-left text-[10.5px] uppercase tracking-wide text-gray-400">
                        <th className="px-3 py-2">Огноо</th>
                        <th className="px-3 py-2">Баримт</th>
                        <th className="px-3 py-2">Код</th>
                        <th className="px-3 py-2">Бараа</th>
                        <th className="px-3 py-2">Барааны master tag</th>
                        <th className="px-3 py-2 text-right">Тоо</th>
                        <th className="px-3 py-2 text-right">Нэгж үнэ</th>
                        <th className="px-3 py-2 text-right">Дүн</th>
                        <th className="px-3 py-2">Хэрэглэгч</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {g.rows.map((r, i) => (
                        <tr key={i} className="hover:bg-gray-50/60">
                          <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-gray-500">{r.date.replaceAll("-", "/")}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-gray-400">{r.doc_no}</td>
                          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-gray-600">{r.code}</td>
                          <td className="px-3 py-1.5 font-medium text-gray-800">{r.name}</td>
                          <td className="px-3 py-1.5 text-amber-700">{r.product_tags}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums">{fmtN(r.qty)}</td>
                          <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{fmtN(r.unit_price)}</td>
                          <td className="px-3 py-1.5 text-right font-semibold tabular-nums">{fmtN(r.amount)}</td>
                          <td className="px-3 py-1.5 text-[11px] text-gray-400">{r.user.split("@")[0]}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

type BalanceSlots = {
  warehouse: { filename: string; uploaded_at: string | null } | null;
  main:      { filename: string; uploaded_at: string | null } | null;
  liquor:    { filename: string; uploaded_at: string | null } | null;
};

export default function Reports() {
  const [files, setFiles] = useState<any[]>([]);
  const [availableTypes, setAvailableTypes] = useState<number[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  // Үлдэгдлийн файл оруулалтын төлөв — Улайлт картанд аль файл бэлэн болохыг харуулна
  const [balSlots, setBalSlots] = useState<BalanceSlots>({ warehouse: null, main: null, liquor: null });
  const [ulailtKind, setUlailtKind] = useState<"warehouse" | "main" | "liquor">("warehouse");
  // Хөдөлгөөнгүй тайлан — он сонголт + оролтын файлын төлөв
  const [movYear] = useState<number>(new Date().getFullYear());
  const [movDays, setMovDays] = useState<number>(7);
  const [incomeYears, setIncomeYears] = useState<Record<number, number>>({});   // year → файлын тоо
  const [movYears, setMovYears] = useState<Record<number, { main: boolean; liquor: boolean }>>({});

  const loadStatus = async () => {
    try {
      const res = await api.get("/reports/status");
      setAvailableTypes(res.data.available_types ?? []);
    } catch {
      // status endpoint алдаа гарвал хоосон
    }
  };

  const loadBalanceSlots = async () => {
    try {
      const res = await api.get("/balance-files/slots");
      setBalSlots({
        warehouse: res.data?.warehouse ?? null,
        main: res.data?.main ?? null,
        liquor: res.data?.liquor ?? null,
      });
    } catch { /* хоосон үлдээнэ */ }
  };

  const loadFiles = async () => {
    const res = await api.get("/reports/files");
    setFiles(res.data.files);
  };

  const loadMovementInputs = async () => {
    try {
      const inc = await api.get("/income-files/slots");
      const slots: any[] = Array.isArray(inc.data) ? inc.data : (inc.data?.slots ?? []);
      const iy: Record<number, number> = {};
      slots.forEach((s) => { if (s.file) iy[s.year] = (iy[s.year] ?? 0) + 1; });
      setIncomeYears(iy);
    } catch { /* хоосон */ }
    try {
      const mv = await api.get("/product-yearly-movement/slots");
      const my: Record<number, { main: boolean; liquor: boolean }> = {};
      (mv.data ?? []).forEach((s: any) => { my[s.year] = { main: !!s.has_main, liquor: !!s.has_liquor }; });
      setMovYears(my);
    } catch { /* хоосон */ }
  };

  useEffect(() => {
    loadStatus();
    loadFiles();
    loadBalanceSlots();
    loadMovementInputs();
  }, []);

  const download = async (name: string) => {
    const res = await api.get(`/reports/download/${name}`, { responseType: "blob" });
    const url = window.URL.createObjectURL(res.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const runReport = async (card: ReportCard) => {
    setRunning(card.key);
    try {
      // Улайлт картын хувьд сонгосон үлдэгдлийн файлын kind-ийг дамжуулна
      const params: Record<string, string> = {};
      if (card.key === "ulailt") params.kind = ulailtKind;
      if (card.key === "no_movement") params.days = String(movDays);

      const res = await api.post(`/reports/run/${card.key}`, {}, {
        responseType: "blob",
        params,
      });

      const cd = res.headers["content-disposition"] ?? "";
      const match = cd.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] ?? `${card.key}.xlsx`;
      const url = window.URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      window.URL.revokeObjectURL(url);
      await loadFiles();
    } catch (e: any) {
      const text = await e?.response?.data?.text?.();
      let detail = "Тайлан гаргахад алдаа гарлаа";
      try {
        const parsed = JSON.parse(text ?? "");
        detail = parsed.detail ?? detail;
      } catch {}
      alert(detail);
    } finally {
      setRunning(null);
    }
  };

  // Карт бэлэн эсэхийг шалгах
  const isReady = (card: ReportCard) => {
    if (card.key === "ulailt") {
      // Улайлт: сонгосон kind-ийн файл оруулагдсан эсэхээр шалгана
      return !!balSlots[ulailtKind];
    }
    if (card.key === "no_movement") {
      const m = movYears[movYear];
      return !!incomeYears[movYear] && !!m && (m.main || m.liquor);
    }
    if (card.requiredTypes.length === 0) return null; // тусгай төрөл
    return card.requiredTypes.every((t) => availableTypes.includes(t));
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <div className="text-2xl font-semibold text-gray-900 print:hidden">Тайлан</div>
      <div className="mt-1 text-sm text-gray-500 print:hidden">
        Тайлан боловсруулж эксэл файлаар экспорт хийх
      </div>

      {/* ── Tag vs Байршил зөрүүтэй орлого шалгагч ──────────────────────────── */}
      <TagLocationChecker />

      {/* ── Тайлангийн карт grid ────────────────────────────────────────────── */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {REPORT_CARDS.map((card) => {
          const ready = isReady(card);
          const isRunning = running === card.key;
          const missingTypes = card.requiredTypes.filter((t) => !availableTypes.includes(t));

          return (
            <div
              key={card.key}
              className="flex flex-col rounded-apple bg-white p-5 shadow-sm border border-gray-100"
            >
              {/* Карт толгой */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet size={16} className="mt-0.5 shrink-0 text-emerald-500" />
                  <div>
                    <div className="text-sm font-semibold text-gray-900">{card.title}</div>
                    {card.scriptNote && (
                      <div className="mt-0.5 font-mono text-[10px] text-gray-400">
                        {card.scriptNote}
                      </div>
                    )}
                  </div>
                </div>

                {/* Бэлэн / Дутуу badge */}
                {ready === true && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                    <CheckCircle2 size={11} />
                    Бэлэн
                  </span>
                )}
                {ready === false && (
                  <span className="flex shrink-0 items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                    <AlertCircle size={11} />
                    Дутуу
                  </span>
                )}
                {ready === null && (
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-500">
                    Нээх
                  </span>
                )}
              </div>

              {/* Тайлбар */}
              <p className="mt-3 text-xs leading-relaxed text-gray-500">{card.description}</p>

              {/* Улайлт картын файл сонгогч — 3 төрлөөс аль нэгээс улайлт гаргана */}
              {card.key === "ulailt" && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                    Үлдэгдлийн файлаас сонго
                  </div>
                  <div className="flex flex-col gap-1.5">
                    {([
                      { k: "warehouse", label: "Бүх агуулахын үлдэгдэл", color: "blue"   },
                      { k: "main",      label: "Үндсэн заалны үлдэгдэл",  color: "violet" },
                      { k: "liquor",    label: "Архины заалны үлдэгдэл",  color: "amber"  },
                    ] as const).map(({ k, label, color }) => {
                      const info = balSlots[k];
                      const active = ulailtKind === k;
                      const has = !!info;
                      const ring  = active ? (color === "blue" ? "ring-blue-400" : color === "violet" ? "ring-violet-400" : "ring-amber-400") : "ring-gray-200";
                      const bg    = active ? (color === "blue" ? "bg-blue-50"    : color === "violet" ? "bg-violet-50"    : "bg-amber-50")    : "bg-white";
                      return (
                        <button
                          key={k}
                          onClick={() => setUlailtKind(k)}
                          disabled={!has}
                          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[11.5px] ring-1 ring-inset ${ring} ${bg} ${has ? "" : "opacity-50 cursor-not-allowed"} hover:bg-gray-50`}
                          title={has ? `Файл: ${info!.filename}` : "Файл оруулаагүй"}
                        >
                          <span className={`grid h-4 w-4 shrink-0 place-items-center rounded-full border ${active ? "border-current" : "border-gray-300"}`}>
                            {active && <span className="h-2 w-2 rounded-full bg-current" />}
                          </span>
                          <span className="flex-1 font-semibold text-gray-800">{label}</span>
                          {has ? (
                            <span className="flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                              <CheckCircle2 size={9} /> Бэлэн
                            </span>
                          ) : (
                            <span className="flex items-center gap-1 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                              <AlertCircle size={9} /> Алга
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {!balSlots[ulailtKind] && (
                    <div className="mt-1.5 text-[10px] text-amber-600">
                      Сонгосон файл оруулагдаагүй байна. Файл оруулалт → Үлдэгдлийн файл оруулалт хэсгээс оруулна уу.
                    </div>
                  )}
                </div>
              )}

              {/* Хөдөлгөөнгүй картын он сонголт + оролтын файлын төлөв */}
              {card.key === "no_movement" && (() => {
                const m = movYears[movYear];
                const chip = (ok: boolean, label: string) => (
                  <span className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${ok ? "bg-emerald-50 text-emerald-700" : "bg-amber-50 text-amber-700"}`}>
                    {ok ? <CheckCircle2 size={9} /> : <AlertCircle size={9} />}{label}
                  </span>
                );
                return (
                  <div className="mt-3">
                    <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">Сүүлийн хэд хоногийн орлого</div>
                    <select value={movDays} onChange={(e) => setMovDays(Number(e.target.value))}
                      className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-[12px] outline-none focus:border-gray-400">
                      {[3, 7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>Сүүлийн {d} хоног</option>)}
                    </select>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {chip(!!incomeYears[movYear], incomeYears[movYear] ? `Орлого ${incomeYears[movYear]} файл` : "Орлогын файл алга")}
                      {chip(!!m?.main, "Хөдөлгөөн: Үндсэн заал")}
                      {chip(!!m?.liquor, "Хөдөлгөөн: Архи заал")}
                    </div>
                    {!(incomeYears[movYear] && m && (m.main || m.liquor)) && (
                      <div className="mt-1.5 text-[10px] text-amber-600">
                        Файл оруулалт → Орлогын файл / Хөдөлгөөний файл хэсгээс {movYear} оны файлуудыг (сүүлийн хоногуудыг хамарсан) оруулна уу.
                      </div>
                    )}
                  </div>
                );
              })()}

              {/* Шаардлагатай файлууд */}
              {card.requiredTypes.length > 0 && (
                <div className="mt-3">
                  <div className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-gray-400">
                    Шаардлагатай файлууд
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {card.requiredTypes.map((t) => {
                      const has = availableTypes.includes(t);
                      return (
                        <span
                          key={t}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            has
                              ? "bg-emerald-50 text-emerald-700"
                              : "bg-gray-100 text-gray-400"
                          }`}
                        >
                          {has ? "✓ " : ""}
                          {TYPE_LABEL[t] ?? `type=${t}`}
                        </span>
                      );
                    })}
                  </div>
                  {missingTypes.length > 0 && (
                    <div className="mt-1.5 text-[10px] text-amber-600">
                      Импортын хэсгээс дутуу файлуудаа оруулна уу.
                    </div>
                  )}
                </div>
              )}

              {/* Татах товч */}
              <div className="mt-auto pt-4">
                <button
                  onClick={() => runReport(card)}
                  disabled={isRunning || ready === false}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-apple bg-gray-900 px-4 py-2 text-xs font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {isRunning ? (
                    <>
                      <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                      </svg>
                      Боловсруулж байна...
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      Татах
                    </>
                  )}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Гаралтын файлуудын жагсаалт ───────────────────────────────────── */}
      <div className="mt-8">
        <Card className="p-6">
          <div className="text-lg font-semibold text-gray-900">Гаралтын файлууд</div>
          <div className="mt-3 max-h-[520px] overflow-auto rounded-apple border border-gray-100">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-white shadow-sm">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3">Нэр</th>
                  <th className="px-4 py-3">Хэмжээ</th>
                  <th className="px-4 py-3">Үйлдэл</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {files.length === 0 && (
                  <tr>
                    <td colSpan={3} className="px-4 py-8 text-center text-sm text-gray-400">
                      Гаралтын файл байхгүй байна
                    </td>
                  </tr>
                )}
                {files.map((f) => (
                  <tr key={f.name}>
                    <td className="px-4 py-3">{f.name}</td>
                    <td className="px-4 py-3">{Math.round(f.size / 1024)} КБ</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => download(f.name)}
                        className="inline-flex items-center gap-2 rounded-apple border border-gray-200 bg-white px-3 py-2 text-sm hover:bg-gray-50"
                      >
                        <Download size={16} />
                        Татах
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </motion.div>
  );
}
