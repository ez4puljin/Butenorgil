import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowLeft, UploadCloud, RefreshCw, Check, AlertCircle, Warehouse, Store, Trash2,
  Settings2, ChevronDown, ChevronRight, Save, X, Wine, TrendingUp,
} from "lucide-react";
import { api } from "../lib/api";

type SlotInfo = {
  year: number;
  month: number;
  count: number;
  has_warehouse: boolean;
  has_showroom: boolean;
  has_liquor?: boolean;
  n_warehouse?: number;
  n_showroom?: number;
  n_liquor?: number;
};
type Kind = "warehouse" | "showroom" | "liquor";
type KindColor = "blue" | "violet" | "amber";

// Борлуулалтын 3 төрөл — нийт борлуулалт = Агуулах + Заал + Заалны архи
const KINDS: { key: Kind; label: string; color: KindColor; icon: (s: number) => React.ReactNode }[] = [
  { key: "warehouse", label: "Агуулах", color: "blue", icon: (s) => <Warehouse size={s} /> },
  { key: "showroom", label: "Заал", color: "violet", icon: (s) => <Store size={s} /> },
  { key: "liquor", label: "Заалны архи", color: "amber", icon: (s) => <Wine size={s} /> },
];
const KIND_LABEL: Record<Kind, string> = { warehouse: "Агуулах", showroom: "Заал", liquor: "Заалны архи" };
const KIND_CHIP: Record<KindColor, string> = {
  blue: "bg-blue-50 text-blue-700", violet: "bg-violet-50 text-violet-700", amber: "bg-amber-50 text-amber-700",
};
const hasKind = (s: SlotInfo | undefined, k: Kind) => !!s?.[`has_${k}` as const];

const MN_MONTHS = ["1-р сар","2-р сар","3-р сар","4-р сар","5-р сар","6-р сар","7-р сар","8-р сар","9-р сар","10-р сар","11-р сар","12-р сар"];
// Excel баганын үсэг (0=A, 1=B, ...). 12 багана хангалттай.
const COLS = Array.from({ length: 12 }, (_, i) => ({ idx: i, letter: String.fromCharCode(65 + i) }));

export default function ProductSalesImport() {
  const now = new Date();
  const [year, setYear] = useState<number>(now.getFullYear());

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [busy, setBusy] = useState<string>("");      // `${month}-${kind}` upload-д
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Баганын тохиргоо
  const [cfgOpen, setCfgOpen] = useState(false);
  const [codeCol, setCodeCol] = useState(0);
  const [qtyCol, setQtyCol] = useState(1);
  const [cfgSaving, setCfgSaving] = useState(false);

  // Нэг далд file input — target-аар чиглүүлнэ
  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<{ month: number; kind: Kind } | null>(null);

  const loadSlots = async () => {
    try {
      const r = await api.get("/product-monthly-sales/slots");
      setSlots(r.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Жагсаалт татаж чадсангүй.");
    }
  };
  const loadConfig = async () => {
    try {
      const r = await api.get("/product-monthly-sales/config");
      setCodeCol(r.data?.code_col ?? 0);
      setQtyCol(r.data?.qty_col ?? 1);
    } catch { /* default */ }
  };

  // Борлуулалтын график — сервер урьдчилан ачаалсан өгөгдлийн төлөв
  const [sa, setSa] = useState<{ info: { products: number; rows: number; built_at: string; has_amount: boolean; master_updated: string | null };
    years: { year: number; months: number[] }[] } | null>(null);
  const [reloading, setReloading] = useState(false);
  const loadSa = async () => {
    try { const r = await api.get("/sales-analytics/meta"); setSa(r.data); } catch { /* график заавал биш */ }
  };
  const reloadAll = async () => {
    if (!confirm("Бүх сарын хадгалсан файлуудыг дахин уншиж борлуулалтын дүнг ачаалаад, графикийн өгөгдлийг шинээр бэлдэх үү?\n(Тоо ширхэг өөрчлөгдөхгүй)")) return;
    setReloading(true); setError("");
    try {
      const r = await api.post("/product-monthly-sales/reload", {}, { timeout: 300000 });
      flash(`Бүх сарыг ачааллаа: ${Number(r.data?.amounts?.updated_rows ?? 0).toLocaleString("mn-MN")} мөрийн дүн · график ${Number(r.data?.analytics?.products ?? 0).toLocaleString("mn-MN")} бараатай бэлэн`);
      await loadSa();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Дахин ачаалахад алдаа гарлаа.");
    } finally { setReloading(false); }
  };

  useEffect(() => { loadSlots(); loadConfig(); loadSa(); }, []);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3500); };

  const slotOf = (month: number) => slots.find((s) => s.year === year && s.month === month);

  const pickFile = (month: number, kind: Kind) => {
    targetRef.current = { month, kind };
    fileRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const t = targetRef.current;
    if (!file || !t) return;
    const tag = `${t.month}-${t.kind}`;
    setBusy(tag); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("year", String(year));
      fd.append("month", String(t.month));
      fd.append("kind", t.kind);
      const r = await api.post("/product-monthly-sales/import", fd);
      const d = r.data ?? {};
      flash(`${MN_MONTHS[t.month - 1]} · ${KIND_LABEL[t.kind]}: ${d.rows_upserted ?? 0} бараа` +
        (d.rows_skipped ? ` (${d.rows_skipped} алгассан)` : "") + (d.has_amount === false ? " · дүнгийн багана олдсонгүй" : ""));
      await loadSlots();
      setTimeout(loadSa, 4000);                       // график background-д дахин бэлдэгдэнэ
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy("");
      targetRef.current = null;
    }
  };

  const onDelete = async (month: number, kind: Kind) => {
    if (!confirm(`${year} оны ${MN_MONTHS[month - 1]} — «${KIND_LABEL[kind]}» борлуулалтыг устгах уу?`)) return;
    try {
      await api.delete(`/product-monthly-sales/${year}/${month}/${kind}`);
      flash("Устгалаа.");
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа.");
    }
  };

  const saveConfig = async () => {
    if (codeCol === qtyCol) { setError("Код ба тоо багана өөр байх ёстой."); return; }
    setCfgSaving(true); setError("");
    try {
      await api.put("/product-monthly-sales/config", { code_col: codeCol, qty_col: qtyCol });
      flash("Баганын тохиргоо хадгалагдлаа ✓");
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа.");
    } finally { setCfgSaving(false); }
  };

  const years = useMemo(() => {
    const ys = new Set<number>([now.getFullYear(), now.getFullYear() - 1, now.getFullYear() + 1]);
    slots.forEach((s) => ys.add(s.year));
    return [...ys].sort((a, b) => b - a);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);

  // Тухайн оны нийт оруулсан сарын тоо — төрөл бүрээр (статист)
  const yearStat = useMemo(() => {
    const st: Record<Kind, number> = { warehouse: 0, showroom: 0, liquor: 0 };
    for (let m = 1; m <= 12; m++) {
      const s = slotOf(m);
      KINDS.forEach((k) => { if (hasKind(s, k.key)) st[k.key]++; });
    }
    return st;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, year]);

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 py-3 sm:px-6 sm:py-4">
      <input ref={fileRef} type="file" accept=".xlsx,.xls" className="hidden"
        onChange={(e) => { onFileChosen(e.target.files?.[0]); e.currentTarget.value = ""; }} />

      {/* Toast */}
      <AnimatePresence>
        {(error || notice) && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
            className={`fixed left-3 right-3 top-3 z-50 flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg sm:left-auto sm:right-5 sm:max-w-md ${
              error ? "bg-red-600 text-white" : "bg-emerald-600 text-white"
            }`}>
            {error ? <AlertCircle size={15} /> : <Check size={15} />}
            <span className="flex-1">{error || notice}</span>
            <button onClick={() => { setError(""); setNotice(""); }}><X size={14} /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Header */}
      <div className="flex items-center gap-3">
        <Link to="/imports" className="grid h-10 w-10 place-items-center rounded-apple bg-[#F5F5F7] hover:bg-gray-100">
          <ArrowLeft size={18} className="text-gray-700" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Сарын борлуулалт</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">Агуулах, Заал, Заалны архины сарын борлуулалтыг тус тусад нь оруулна — нийлбэр нь захиалга, поддоны статистикт харагдана.</p>
        </div>
      </div>

      {/* ── Борлуулалтын график — урьдчилан ачаалсан өгөгдөл ── */}
      <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-gradient-to-r from-blue-600 to-indigo-600 p-4 text-white shadow-sm">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/20"><TrendingUp size={20} /></div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-bold">Борлуулалтын график</div>
          <div className="text-[11.5px] text-white/85">
            {sa ? (
              <>
                {sa.years.map((y) => `${y.year}: ${y.months[0]}–${y.months[y.months.length - 1]} сар`).join(" · ")} ачаалагдсан ·{" "}
                {sa.info.products.toLocaleString("mn-MN")} бараа{sa.info.has_amount ? " · тоо + дүн" : " · тоо"} · бэлдсэн {sa.info.built_at.split("T")[1]?.slice(0, 5)}
                {" "}— мастер/борлуулалт шинэчлэгдэх бүрт автоматаар дахин бэлдэнэ
              </>
            ) : "Бренд, бараа, ангилал, байршлаар сарын өсөлт/бууралт"}
          </div>
        </div>
        <button onClick={reloadAll} disabled={reloading}
          className="inline-flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-2 text-[12px] font-semibold hover:bg-white/25 disabled:opacity-60">
          <RefreshCw size={13} className={reloading ? "animate-spin" : ""} /> {reloading ? "Ачаалж байна…" : "Бүх сарыг дахин ачаалах"}
        </button>
        <Link to="/sales-analytics" className="inline-flex items-center gap-1 rounded-lg bg-white px-3 py-2 text-[12px] font-bold text-indigo-700 hover:bg-indigo-50">
          Графикаар харах <ChevronRight size={14} />
        </Link>
      </div>

      {/* ── Баганын тохиргоо (хураагдсан) ── */}
      <div className="mt-4 overflow-hidden rounded-2xl border border-amber-200 bg-amber-50/40">
        <button onClick={() => setCfgOpen((v) => !v)}
          className="flex w-full items-center gap-2.5 px-4 py-3 text-left hover:bg-amber-50">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-amber-100 text-amber-700"><Settings2 size={15} /></div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-gray-800">Тохиргоо — Excel баганын байршил</div>
            <div className="text-[11px] text-gray-600">Одоо: Код = <b>{COLS[codeCol]?.letter ?? "?"}</b> багана, Тоо = <b>{COLS[qtyCol]?.letter ?? "?"}</b> багана</div>
          </div>
          {cfgOpen ? <ChevronDown size={16} className="text-amber-500" /> : <ChevronRight size={16} className="text-amber-500" />}
        </button>
        {cfgOpen && (
          <div className="border-t border-amber-200 px-4 py-3">
            <p className="mb-3 text-[12px] text-gray-600">
              Оруулах Excel файлын <b>аль багана нь барааны код</b>, <b>аль багана нь борлуулалтын тоо</b> болохыг сонгоно.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-gray-500">Барааны код</label>
                <select value={codeCol} onChange={(e) => setCodeCol(Number(e.target.value))}
                  className="mt-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-400">
                  {COLS.map((c) => <option key={c.idx} value={c.idx}>{c.letter} багана</option>)}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-gray-500">Борлуулалтын тоо</label>
                <select value={qtyCol} onChange={(e) => setQtyCol(Number(e.target.value))}
                  className="mt-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm outline-none focus:border-amber-400">
                  {COLS.map((c) => <option key={c.idx} value={c.idx}>{c.letter} багана</option>)}
                </select>
              </div>
              <button onClick={saveConfig} disabled={cfgSaving}
                className="inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-amber-700 disabled:opacity-50">
                {cfgSaving ? <RefreshCw size={13} className="animate-spin" /> : <Save size={13} />} Хадгалах
              </button>
            </div>
            <p className="mt-2 text-[11px] text-gray-400">Эхний мөр гарчиг (текст) бол автоматаар алгасна. Нэг бараа олон мөр байвал нийлүүлж тооцно.</p>
          </div>
        )}
      </div>

      {/* ── Он сонгогч + статист ── */}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-[12px] font-semibold text-gray-600">Он:</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-800 outline-none focus:border-[#0071E3]">
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          {KINDS.map((k) => (
            <span key={k.key} className={`inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium ${KIND_CHIP[k.color]}`}>
              {k.icon(12)} {k.label} {yearStat[k.key]}/12
            </span>
          ))}
        </div>
        <button onClick={loadSlots} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <RefreshCw size={13} /> Сэргээх
        </button>
      </div>

      {/* ── 12 сарын grid ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {MN_MONTHS.map((mName, i) => {
          const m = i + 1;
          const s = slotOf(m);
          const isFuture = year > now.getFullYear() || (year === now.getFullYear() && m > now.getMonth() + 1);
          return (
            <div key={m} className={`rounded-2xl border bg-white p-3.5 shadow-sm ${isFuture ? "border-gray-100 opacity-60" : "border-gray-200"}`}>
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[14px] font-bold text-gray-900">{mName}</span>
                {s && KINDS.some((k) => hasKind(s, k.key)) && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">{s.count} бараа</span>
                )}
              </div>
              {KINDS.map((k) => (
                <KindRow key={k.key} icon={k.icon(13)} label={k.label} color={k.color}
                  has={hasKind(s, k.key)} count={s?.[`n_${k.key}` as const]} busy={busy === `${m}-${k.key}`}
                  onUpload={() => pickFile(m, k.key)} onDelete={() => onDelete(m, k.key)} />
              ))}
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function KindRow({ icon, label, color, has, count, busy, onUpload, onDelete }: {
  icon: React.ReactNode; label: string; color: KindColor;
  has: boolean; count?: number; busy: boolean; onUpload: () => void; onDelete: () => void;
}) {
  const c = {
    blue: { tx: "text-blue-700", bg: "bg-blue-50", ring: "ring-blue-200" },
    violet: { tx: "text-violet-700", bg: "bg-violet-50", ring: "ring-violet-200" },
    amber: { tx: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-200" },
  }[color];
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${c.tx}`}>{icon}{label}</span>
      <div className="ml-auto flex items-center gap-1">
        {has ? (
          <>
            <span title={count ? `${count} бараа` : undefined}
              className={`inline-flex items-center gap-1 rounded-md ${c.bg} px-2 py-0.5 text-[11px] font-semibold ${c.tx} ring-1 ${c.ring}`}>
              <Check size={11} /> Орсон{count ? ` · ${count}` : ""}
            </span>
            <button onClick={onUpload} disabled={busy} title="Дахин оруулах"
              className="grid h-6 w-6 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50">
              {busy ? <RefreshCw size={11} className="animate-spin" /> : <UploadCloud size={12} />}
            </button>
            <button onClick={onDelete} title="Устгах"
              className="grid h-6 w-6 place-items-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500">
              <Trash2 size={11} />
            </button>
          </>
        ) : (
          <button onClick={onUpload} disabled={busy}
            className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            {busy ? <RefreshCw size={11} className="animate-spin" /> : <UploadCloud size={11} />} Оруулах
          </button>
        )}
      </div>
    </div>
  );
}
