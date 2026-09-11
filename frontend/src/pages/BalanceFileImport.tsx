import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Link } from "react-router-dom";
import {
  ArrowLeft, UploadCloud, RefreshCw, Check, AlertCircle, Warehouse, Store, Wine, Trash2,
  Download, X, FileSpreadsheet, CalendarClock, ScanBarcode, ArrowRight,
} from "lucide-react";
import { api } from "../lib/api";

type FileInfo = {
  filename: string;
  size_bytes: number;
  row_count: number;
  uploaded_at: string | null;
  uploaded_by: string;
};
type Kind = "warehouse" | "main" | "liquor" | "hall_count";
type Slots = Record<Kind, FileInfo | null>;

const KINDS: { kind: Kind; label: string; hint?: string; icon: React.ReactNode; color: "blue" | "violet" | "amber" | "emerald" }[] = [
  { kind: "warehouse",  label: "Бүх агуулахын үлдэгдэл", icon: <Warehouse size={18} />,   color: "blue" },
  { kind: "main",       label: "Үндсэн заалны үлдэгдэл", icon: <Store size={18} />,       color: "violet" },
  { kind: "liquor",     label: "Архины заалны үлдэгдэл", icon: <Wine size={18} />,        color: "amber" },
  // Гар утасны тооллогын суурь — оруулмагц мөр бүр нээлттэй тооллогод ачаалагдана
  { kind: "hall_count", label: "Заалны тоолох барааны үлдэгдэл", icon: <ScanBarcode size={18} />, color: "emerald",
    hint: "Оруулмагц «Заалны тооллого» эхэлнэ — утсаар уншуулж тоолно. Тооллогын дундуур дахин оруулбал үлдэгдэл шинэчлэгдэж, уншуулсан тоо хадгалагдана." },
];

const PALETTE = {
  blue:    { tx: "text-blue-700",    bg: "bg-blue-50",    ring: "ring-blue-200",    grad: "from-blue-500 to-blue-600",       soft: "bg-blue-50/50" },
  violet:  { tx: "text-violet-700",  bg: "bg-violet-50",  ring: "ring-violet-200",  grad: "from-violet-500 to-violet-600",   soft: "bg-violet-50/50" },
  amber:   { tx: "text-amber-700",   bg: "bg-amber-50",   ring: "ring-amber-200",   grad: "from-amber-500 to-amber-600",     soft: "bg-amber-50/50" },
  emerald: { tx: "text-emerald-700", bg: "bg-emerald-50", ring: "ring-emerald-200", grad: "from-emerald-500 to-emerald-600", soft: "bg-emerald-50/50" },
};

function fmtSize(b: number): string {
  if (!b) return "";
  if (b < 1024) return `${b}B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)}KB`;
  return `${(b / 1024 / 1024).toFixed(1)}MB`;
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(`${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("mn-MN", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

export default function BalanceFileImport() {
  const [slots, setSlots] = useState<Slots>({ warehouse: null, main: null, liquor: null, hall_count: null });
  const [hallInfo, setHallInfo] = useState<{ session_id: number; items: number; scans_kept: number } | null>(null);
  const [busy, setBusy] = useState<Kind | "">("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const fileRef = useRef<HTMLInputElement | null>(null);
  const targetRef = useRef<Kind | null>(null);

  const loadSlots = async () => {
    try {
      const r = await api.get("/balance-files/slots");
      setSlots({
        warehouse: r.data?.warehouse ?? null,
        main: r.data?.main ?? null,
        liquor: r.data?.liquor ?? null,
        hall_count: r.data?.hall_count ?? null,
      });
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Жагсаалт татаж чадсангүй.");
    }
  };

  useEffect(() => { loadSlots(); }, []);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 3500); };

  const pickFile = (kind: Kind) => {
    targetRef.current = kind;
    fileRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    const kind = targetRef.current;
    if (!file || !kind) return;
    setBusy(kind); setError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("kind", kind);
      const r = await api.post("/balance-files/import", fd);
      const d = r.data ?? {};
      const label = KINDS.find((k) => k.kind === kind)?.label ?? kind;
      if (kind === "hall_count" && d.hall) {
        setHallInfo(d.hall);
        flash(`${label}: ${d.hall.items} бараа тооллогод ачаалагдлаа` + (d.hall.scans_kept ? ` (${d.hall.scans_kept} уншилт хадгалагдсан)` : ""));
      } else {
        flash(`${label}: ${d.filename ?? "файл"} шинэчлэгдлээ` + (d.row_count ? ` (~${d.row_count} мөр)` : ""));
      }
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Файл оруулахад алдаа гарлаа.");
    } finally {
      setBusy("");
      targetRef.current = null;
    }
  };

  const onDownload = async (kind: Kind, filename: string) => {
    try {
      const r = await api.get("/balance-files/download", { params: { kind }, responseType: "blob" });
      const url = URL.createObjectURL(new Blob([r.data], { type: "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename || `${kind}.xlsx`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Татахад алдаа гарлаа.");
    }
  };

  const onDelete = async (kind: Kind, label: string) => {
    if (!confirm(`${label}-ийн файл устгах уу?`)) return;
    try {
      await api.delete(`/balance-files/${kind}`);
      flash("Устгалаа.");
      await loadSlots();
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? "Устгахад алдаа гарлаа.");
    }
  };

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
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-gray-900 sm:text-2xl">Үлдэгдлийн файл оруулалт</h1>
          <p className="mt-0.5 text-xs text-gray-500 sm:text-sm">3 төрлийн үлдэгдлийг <b>өдөр бүр шинэчлэн</b> оруулна (файлыг <b>шалгуургүйгээр</b> хэвээр нь хадгална). 4 дэх «Заалны тоолох барааны үлдэгдэл» нь утасны тооллогын суурь болно.</p>
        </div>
        <button onClick={loadSlots} className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-[12px] text-gray-600 hover:bg-gray-50">
          <RefreshCw size={13} /> Сэргээх
        </button>
      </div>

      {/* ── 4 төрлийн карт ── */}
      <div className="mt-4 grid grid-cols-1 gap-4 sm:mt-6 md:grid-cols-2 xl:grid-cols-4">
        {KINDS.map(({ kind, label, hint, icon, color }) => {
          const info = slots[kind];
          const c = PALETTE[color];
          return (
            <div key={kind} className="overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
              {/* Толгой */}
              <div className={`flex items-center gap-2 bg-gradient-to-r ${c.grad} px-4 py-3 text-white`}>
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-white/20">{icon}</div>
                <div className="text-[14px] font-bold leading-tight">{label}</div>
              </div>

              {/* Биет */}
              <div className="p-4">
                {hint && <p className="mb-3 text-[11px] leading-relaxed text-gray-500">{hint}</p>}
                {kind === "hall_count" && (info || hallInfo) && (
                  <Link to="/hall-count"
                    className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-emerald-600 px-3 py-2 text-[12px] font-semibold text-white hover:bg-emerald-700">
                    <span className="flex items-center gap-1.5"><ScanBarcode size={14} /> Заалны тооллого руу очих</span>
                    <ArrowRight size={14} />
                  </Link>
                )}
                {info ? (
                  <>
                    <div className={`flex items-center gap-2 rounded-xl ${c.soft} px-3 py-2`}>
                      <FileSpreadsheet size={16} className={`shrink-0 ${c.tx}`} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12px] font-semibold text-gray-800" title={info.filename}>{info.filename}</div>
                        <div className="text-[10px] text-gray-500">
                          {[fmtSize(info.size_bytes), info.row_count ? `~${info.row_count} мөр` : ""].filter(Boolean).join(" · ")}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1 text-[11px] text-gray-500">
                      <CalendarClock size={12} className="shrink-0" />
                      <span>Сүүлд: {fmtDateTime(info.uploaded_at)}</span>
                      {info.uploaded_by && <span className="text-gray-400">· {info.uploaded_by}</span>}
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <button onClick={() => pickFile(kind)} disabled={busy === kind}
                        className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg ${c.bg} ${c.tx} ring-1 ${c.ring} px-3 py-2 text-[12px] font-semibold hover:opacity-90 disabled:opacity-50`}>
                        {busy === kind ? <RefreshCw size={13} className="animate-spin" /> : <UploadCloud size={13} />}
                        Шинэчлэх
                      </button>
                      <button onClick={() => onDownload(kind, info.filename)} title="Татах"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-500 hover:bg-emerald-50 hover:text-emerald-600">
                        <Download size={15} />
                      </button>
                      <button onClick={() => onDelete(kind, label)} title="Устгах"
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-gray-200 text-gray-500 hover:bg-red-50 hover:text-red-500">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </>
                ) : (
                  <button onClick={() => pickFile(kind)} disabled={busy === kind}
                    className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-200 py-6 text-gray-400 hover:border-gray-300 hover:text-gray-500 disabled:opacity-50">
                    {busy === kind ? <RefreshCw size={22} className="animate-spin" /> : <UploadCloud size={22} />}
                    <span className="text-[12px] font-medium">Файл оруулах</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </motion.div>
  );
}
