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
  uploaded_at: string | null;
  uploaded_by: string;
};
type SlotInfo = {
  year: number;
  file: FileInfo | null;
};

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
  const [busy, setBusy] = useState<number | null>(null);   // year upload-д
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<number | null>(null);

  const loadSlots = async () => {
    try {
      const r = await api.get("/income-files/slots");
      setSlots(r.data ?? []);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Жагсаалт татаж чадсангүй.");
    }
  };

  useEffect(() => { loadSlots(); }, []);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3500); };

  const fileOf = (year: number) => slots.find((s) => s.year === year)?.file ?? null;

  const pickFile = (year: number) => {
    targetRef.current = year;
    fileRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const year = targetRef.current;
    if (!file || year == null) return;
    setBusy(year); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("year", String(year));
      const r = await api.post("/income-files/import", fd);
      const d = r.data ?? {};
      flash(`${year} он · Бүх орлого: ${d.filename ?? "файл"} хадгалагдлаа` +
        (d.row_count ? ` (~${d.row_count} мөр)` : ""));
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy(null);
      targetRef.current = null;
    }
  };

  const onDownload = async (year: number, filename: string) => {
    try {
      const r = await api.get("/income-files/download", {
        params: { year },
        responseType: "blob",
      });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || `Бүх_орлого_${year}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Татахад алдаа гарлаа.");
    }
  };

  const onDelete = async (year: number) => {
    if (!confirm(`${year} он — Бүх орлогын файл устгах уу?`)) return;
    try {
      await api.delete(`/income-files/${year}`);
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

  const totalCount = useMemo(() => slots.filter((s) => s.file).length, [slots]);

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
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">Бүх орлогыг <b>зөвхөн оноор</b> оруулна. Файлыг <b>ямар ч шалгуургүйгээр</b> хэвээр нь хадгална.</p>
        </div>
      </div>

      {/* ── Статист + сэргээх ── */}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
        <span className="inline-flex items-center gap-1 rounded-md bg-rose-50 px-2 py-1 font-medium text-rose-700"><Receipt size={12} /> Бүх орлого {totalCount} он</span>
        <button onClick={loadSlots} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <RefreshCw size={13} /> Сэргээх
        </button>
      </div>

      {/* ── Он жилийн grid ── */}
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {years.map((y) => {
          const info = fileOf(y);
          const isFuture = y > curYear;
          return (
            <div key={y} className={`rounded-2xl border bg-white p-3.5 shadow-sm ${isFuture ? "border-gray-100 opacity-60" : "border-gray-200"}`}>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[15px] font-bold text-gray-900">{y} он</span>
              </div>
              <FileRow info={info} busy={busy === y}
                onUpload={() => pickFile(y)}
                onDownload={(fn) => onDownload(y, fn)}
                onDelete={() => onDelete(y)} />
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}

function FileRow({ info, busy, onUpload, onDownload, onDelete }: {
  info: FileInfo | null; busy: boolean;
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
        <span className={`inline-flex items-center gap-1 text-[12px] font-medium ${c.tx}`}><Receipt size={13} />Бүх орлого</span>
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
