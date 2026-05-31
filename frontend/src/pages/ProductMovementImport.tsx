import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowLeft, UploadCloud, RefreshCw, Check, AlertCircle, Store, Wine, Trash2,
  Settings2, ChevronDown, ChevronRight, Save, X,
} from "lucide-react";
import { api } from "../lib/api";

type SlotInfo = {
  year: number;
  count: number;
  has_main: boolean;
  has_liquor: boolean;
};
type Kind = "main" | "liquor";

const KIND_LABEL: Record<Kind, string> = { main: "Үндсэн заал", liquor: "Архи заал" };
// Excel баганын үсэг (0=A, 1=B, ...). 12 багана хангалттай.
const COLS = Array.from({ length: 12 }, (_, i) => ({ idx: i, letter: String.fromCharCode(65 + i) }));

export default function ProductMovementImport() {
  const now = new Date();
  const curYear = now.getFullYear();

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  const [busy, setBusy] = useState<string>("");      // `${year}-${kind}` upload-д
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Баганын тохиргоо
  const [cfgOpen, setCfgOpen] = useState(false);
  const [codeCol, setCodeCol] = useState(0);
  const [qtyCol, setQtyCol] = useState(1);
  const [cfgSaving, setCfgSaving] = useState(false);

  // Нэг далд file input — target-аар чиглүүлнэ
  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<{ year: number; kind: Kind } | null>(null);

  const loadSlots = async () => {
    try {
      const r = await api.get("/product-yearly-movement/slots");
      setSlots(r.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Жагсаалт татаж чадсангүй.");
    }
  };
  const loadConfig = async () => {
    try {
      const r = await api.get("/product-yearly-movement/config");
      setCodeCol(r.data?.code_col ?? 0);
      setQtyCol(r.data?.qty_col ?? 1);
    } catch { /* default */ }
  };

  useEffect(() => { loadSlots(); loadConfig(); }, []);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3500); };

  const slotOf = (year: number) => slots.find((s) => s.year === year);

  const pickFile = (year: number, kind: Kind) => {
    targetRef.current = { year, kind };
    fileRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const t = targetRef.current;
    if (!file || !t) return;
    const tag = `${t.year}-${t.kind}`;
    setBusy(tag); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("year", String(t.year));
      fd.append("kind", t.kind);
      const r = await api.post("/product-yearly-movement/import", fd);
      const d = r.data ?? {};
      flash(`${t.year} он · ${KIND_LABEL[t.kind]}: ${d.rows_upserted ?? 0} бараа` +
        (d.rows_skipped ? ` (${d.rows_skipped} алгассан)` : ""));
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy("");
      targetRef.current = null;
    }
  };

  const onDelete = async (year: number, kind: Kind) => {
    if (!confirm(`${year} он — ${KIND_LABEL[kind]}-ийн хөдөлгөөн устгах уу?`)) return;
    try {
      await api.delete(`/product-yearly-movement/${year}/${kind}`);
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
      await api.put("/product-yearly-movement/config", { code_col: codeCol, qty_col: qtyCol });
      flash("Баганын тохиргоо хадгалагдлаа ✓");
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Хадгалахад алдаа гарлаа.");
    } finally { setCfgSaving(false); }
  };

  // Харуулах он жил: одоо + сүүлийн 4 он + дата орсон бүх он, буурахаар
  const years = useMemo(() => {
    const ys = new Set<number>([curYear, curYear - 1, curYear - 2, curYear - 3]);
    slots.forEach((s) => ys.add(s.year));
    return [...ys].sort((a, b) => b - a);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);

  const totalStat = useMemo(() => {
    let mn = 0, lq = 0;
    slots.forEach((s) => { if (s.has_main) mn++; if (s.has_liquor) lq++; });
    return { mn, lq };
  }, [slots]);

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
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Хөдөлгөөний файл оруулалт</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">Үндсэн заал + Архи заалны хөдөлгөөнийг <b>зөвхөн оноор</b> оруулна. Сар бүрийн задаргаа байхгүй.</p>
        </div>
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
              Оруулах Excel файлын <b>аль багана нь барааны код</b>, <b>аль багана нь хөдөлгөөний тоо</b> болохыг сонгоно.
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
                <label className="block text-[11px] font-semibold text-gray-500">Хөдөлгөөний тоо</label>
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

      {/* ── Статист + сэргээх ── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1 rounded-md bg-blue-50 px-2 py-1 font-medium text-blue-700"><Store size={12} /> Үндсэн заал {totalStat.mn} он</span>
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 font-medium text-amber-700"><Wine size={12} /> Архи заал {totalStat.lq} он</span>
        <button onClick={loadSlots} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <RefreshCw size={13} /> Сэргээх
        </button>
      </div>

      {/* ── Он жилийн grid ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {years.map((y) => {
          const s = slotOf(y);
          const isFuture = y > curYear;
          return (
            <div key={y} className={`rounded-2xl border bg-white p-3.5 shadow-sm ${isFuture ? "border-gray-100 opacity-60" : "border-gray-200"}`}>
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[15px] font-bold text-gray-900">{y} он</span>
                {s && (s.has_main || s.has_liquor) && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 ring-1 ring-emerald-200">{s.count} бараа</span>
                )}
              </div>
              <KindRow icon={<Store size={13} />} label="Үндсэн заал" color="blue"
                has={!!s?.has_main} busy={busy === `${y}-main`}
                onUpload={() => pickFile(y, "main")} onDelete={() => onDelete(y, "main")} />
              <KindRow icon={<Wine size={13} />} label="Архи заал" color="amber"
                has={!!s?.has_liquor} busy={busy === `${y}-liquor`}
                onUpload={() => pickFile(y, "liquor")} onDelete={() => onDelete(y, "liquor")} />
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function KindRow({ icon, label, color, has, busy, onUpload, onDelete }: {
  icon: React.ReactNode; label: string; color: "blue" | "amber";
  has: boolean; busy: boolean; onUpload: () => void; onDelete: () => void;
}) {
  const c = color === "blue"
    ? { tx: "text-blue-700", bg: "bg-blue-50", ring: "ring-blue-200" }
    : { tx: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-200" };
  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${c.tx}`}>{icon}{label}</span>
      <div className="ml-auto flex items-center gap-1">
        {has ? (
          <>
            <span className={`inline-flex items-center gap-1 rounded-md ${c.bg} px-2 py-0.5 text-[11px] font-semibold ${c.tx} ring-1 ${c.ring}`}>
              <Check size={11} /> Орсон
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
