import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowLeft, UploadCloud, RefreshCw, Check, AlertCircle, Receipt, Trash2,
  Download, X, FileSpreadsheet,
} from "lucide-react";
import { api } from "../lib/api";

type FileInfo = {
  filename: string;
  size_bytes: number;
  row_count: number;
  price_updated: number;
  uploaded_at: string | null;
  uploaded_by: string;
};
type SlotInfo = {
  year: number;
  month: number;          // 0 = бүтэн он, 1..12 = сар
  file: FileInfo | null;
};

const MONTH_NAMES = ["1-р сар", "2-р сар", "3-р сар", "4-р сар", "5-р сар", "6-р сар",
  "7-р сар", "8-р сар", "9-р сар", "10-р сар", "11-р сар", "12-р сар"];

function fmtSize(b: number): string {
  if (!b) return "";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("mn-MN", { year: "2-digit", month: "2-digit", day: "2-digit" });
}

export default function IncomeFileImport() {
  const now = new Date();
  const curYear = now.getFullYear();

  const [slots, setSlots] = useState<SlotInfo[]>([]);
  // Энэ оноос эхлэн сар бүрээр (backend-ээс ирнэ; анхдагч 2026)
  const [monthlyFrom, setMonthlyFrom] = useState(2026);
  const [busy, setBusy] = useState<string | null>(null);   // "year-month" upload-д
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<{ year: number; month: number } | null>(null);

  const loadSlots = async () => {
    try {
      const r = await api.get("/income-files/slots");
      // Шинэ хариу {monthly_from_year, slots}; хуучин сервер массив буцаадаг байсан
      const d = r.data;
      if (Array.isArray(d)) setSlots(d.map((x: any) => ({ ...x, month: x.month ?? 0 })));
      else { setSlots(d?.slots ?? []); if (d?.monthly_from_year) setMonthlyFrom(d.monthly_from_year); }
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Жагсаалт татаж чадсангүй.");
    }
  };

  useEffect(() => { loadSlots(); }, []);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3500); };

  const fileOf = (year: number, month = 0) =>
    slots.find((s) => s.year === year && s.month === month)?.file ?? null;
  const key = (year: number, month: number) => `${year}-${month}`;
  const label = (year: number, month: number) => (month ? `${year} он ${MONTH_NAMES[month - 1]}` : `${year} он · Бүх орлого`);

  const pickFile = (year: number, month = 0) => {
    targetRef.current = { year, month };
    fileRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const t = targetRef.current;
    if (!file || !t) return;
    const { year, month } = t;
    setBusy(key(year, month)); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("year", String(year));
      fd.append("month", String(month));
      const r = await api.post("/income-files/import", fd);
      const d = r.data ?? {};
      const pu = d.price_update ?? {};
      const priceMsg = pu.error
        ? " · ⚠ үнэ шинэчилж чадсангүй"
        : pu.skipped ? " · үнэ шинэчлээгүй (хуучин сар)"
        : (pu.updated ? ` · ${pu.updated} барааны үнэ шинэчилсэн` : "");
      flash(`${label(year, month)}: ${d.filename ?? "файл"} хадгалагдлаа` +
        (d.row_count ? ` (~${d.row_count} мөр)` : "") + priceMsg);
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy(null);
      targetRef.current = null;
    }
  };

  const onDownload = async (year: number, month: number, filename: string) => {
    try {
      const r = await api.get("/income-files/download", {
        params: { year, month },
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || (month ? `Орлого_${year}_${String(month).padStart(2, "0")}.xlsx` : `Бүх_орлого_${year}.xlsx`);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Татахад алдаа гарлаа.");
    }
  };

  const onDelete = async (year: number, month = 0) => {
    if (!confirm(`${label(year, month)} — файл устгах уу?`)) return;
    try {
      await api.delete(`/income-files/${year}`, { params: { month } });
      flash("Устгалаа.");
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа.");
    }
  };

  // Харуулах он жил: одоо + сүүлийн 4 он + дата орсон бүх он, буурахаар
  const years = useMemo(() => {
    const ys = new Set<number>([curYear, curYear - 1, curYear - 2, curYear - 3]);
    slots.forEach((s) => ys.add(s.year));
    return [...ys].sort((a, b) => b - a);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots]);

  const totalCount = useMemo(() => slots.filter((s) => s.file && s.month === 0).length, [slots]);
  const monthCount = useMemo(() => slots.filter((s) => s.file && s.month > 0).length, [slots]);
  const curMonth = now.getMonth() + 1;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="px-4 py-3 sm:px-6 sm:py-4">
      <input ref={fileRef} type="file" className="hidden"
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
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Орлогын файл оруулалт</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">{monthlyFrom} оноос <b>сар бүрээр</b>, өмнөх онуудыг <b>бүтэн оноор</b> оруулна. Файлыг <b>ямар ч шалгуургүйгээр</b> хэвээр нь хадгална.</p>
        </div>
      </div>

      {/* ── Статист + сэргээх ── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 font-medium text-rose-700"><Receipt size={12} /> Бүтэн он {totalCount} · сарын файл {monthCount}</span>
        <button onClick={loadSlots} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <RefreshCw size={13} /> Сэргээх
        </button>
      </div>

      {/* ── Сар бүрээр (monthlyFrom оноос) ── */}
      {years.filter((y) => y >= monthlyFrom).map((y) => {
        const yearFile = fileOf(y, 0);
        const monthsDone = MONTH_NAMES.filter((_, i) => fileOf(y, i + 1)).length;
        return (
          <div key={`m-${y}`} className="mt-3 rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-[15px] font-bold text-gray-900">{y} он</span>
              <span className="text-[11px] text-gray-500">сар бүрээр · {monthsDone}/12 сар орсон</span>
            </div>
            {yearFile && (
              <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <AlertCircle size={13} className="mt-0.5 shrink-0" />
                <div className="min-w-0 flex-1">
                  <b>Бүтэн оны хуучин файл</b> байна ({yearFile.filename}, {fmtDate(yearFile.uploaded_at)}).
                  {monthsDone > 0 ? " Сарын файл орсон тул энэ файл ашиглагдахгүй — устгаж болно." : " Сар бүрээр оруулж эхэлмэгц энэ файл ашиглагдахгүй болно."}
                </div>
                <button onClick={() => onDownload(y, 0, yearFile.filename)} title="Татах" className="rounded-md p-1 text-amber-700 hover:bg-amber-100"><Download size={12} /></button>
                <button onClick={() => onDelete(y, 0)} title="Устгах" className="rounded-md p-1 text-amber-700 hover:bg-red-100 hover:text-red-600"><Trash2 size={12} /></button>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {MONTH_NAMES.map((mn, i) => {
                const m = i + 1;
                const info = fileOf(y, m);
                const isFuture = y > curYear || (y === curYear && m > curMonth);
                return (
                  <div key={m} className={`rounded-xl border p-2.5 ${info ? "border-rose-200 bg-rose-50/40" : isFuture ? "border-gray-100 opacity-50" : "border-dashed border-gray-300"}`}>
                    <div className="mb-1 text-[13px] font-bold text-gray-800">{mn}</div>
                    <FileRow info={info} busy={busy === key(y, m)} compact
                      onUpload={() => pickFile(y, m)}
                      onDownload={(fn) => onDownload(y, m, fn)}
                      onDelete={() => onDelete(y, m)} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {/* ── Бүтэн оноор (өмнөх онууд) ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {years.filter((y) => y < monthlyFrom).map((y) => {
          const info = fileOf(y);
          return (
            <div key={y} className="rounded-2xl border border-gray-200 bg-white p-3.5 shadow-sm">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[15px] font-bold text-gray-900">{y} он</span>
              </div>
              <FileRow info={info} busy={busy === key(y, 0)}
                onUpload={() => pickFile(y)}
                onDownload={(fn) => onDownload(y, 0, fn)}
                onDelete={() => onDelete(y)} />
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function FileRow({ info, busy, compact, onUpload, onDownload, onDelete }: {
  info: FileInfo | null; busy: boolean; compact?: boolean;
  onUpload: () => void; onDownload: (filename: string) => void; onDelete: () => void;
}) {
  const c = { tx: "text-rose-700", bg: "bg-rose-50", ring: "ring-rose-200" };
  const meta = info
    ? [fmtSize(info.size_bytes), info.row_count ? `~${info.row_count} мөр` : "", fmtDate(info.uploaded_at)]
        .filter(Boolean).join(" · ")
    : "";
  return (
    <div>
      <div className="flex items-center gap-2">
        {!compact && <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${c.tx}`}><Receipt size={13} />Бүх орлого</span>}
        <div className="ml-auto flex items-center gap-1">
          {info ? (
            <span className={`inline-flex items-center gap-1 rounded-md ${c.bg} px-2 py-0.5 text-[11px] font-semibold ${c.tx} ring-1 ${c.ring}`}>
              <Check size={11} /> Орсон
            </span>
          ) : (
            <button onClick={onUpload} disabled={busy}
              className="inline-flex items-center gap-1 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              {busy ? <RefreshCw size={11} className="animate-spin" /> : <UploadCloud size={11} />} Оруулах
            </button>
          )}
        </div>
      </div>

      {info && (
        <div className="mt-1 flex items-center gap-1.5">
          <FileSpreadsheet size={12} className="shrink-0 text-gray-400" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[11px] font-medium text-gray-700" title={info.filename}>{info.filename}</div>
            {meta && <div className="text-[10px] text-gray-400">{meta}</div>}
            {info.price_updated > 0 && (
              <div className="text-[10px] font-medium text-emerald-600">↻ {info.price_updated} барааны үнэ шинэчилсэн</div>
            )}
          </div>
          <button onClick={() => onDownload(info.filename)} title="Татах"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-emerald-50 hover:text-emerald-600">
            <Download size={12} />
          </button>
          <button onClick={onUpload} disabled={busy} title="Дахин оруулах"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50">
            {busy ? <RefreshCw size={11} className="animate-spin" /> : <UploadCloud size={12} />}
          </button>
          <button onClick={onDelete} title="Устгах"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-gray-400 hover:bg-red-50 hover:text-red-500">
            <Trash2 size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
